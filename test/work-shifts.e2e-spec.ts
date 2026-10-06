import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { v7 } from 'uuid';
import request from 'supertest';
import { Client } from 'pg';
import { WorkShiftsService } from '../src/finance/work-shifts.service.js';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { withTestTenant } from './tenant-scope.js';

describe('business work shifts', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  let accountId: string;
  let actorId: string;
  let payerSocioId: string;
  let collaboratorId: string;
  let inactiveId: string;
  let deviceId: string;
  let foreignMemberId: string;
  let foreignDeviceId: string;
  let foreignAccountId: string;
  const contextId = `work-shifts-${randomUUID()}`;
  const otherContext = `work-shifts-other-${randomUUID()}`;
  const endpoint = '/finance/work-shifts';
  const auth = (req: request.Test, memberId = actorId) =>
    req
      .auth(token, { type: 'bearer' })
      .set('x-member-id', memberId)
      .set('x-device-id', deviceId);
  const post = (dto: unknown, memberId = actorId) =>
    auth(request(app.getHttpServer()).post(endpoint), memberId).send(
      dto as object,
    );
  const get = (path = endpoint, query: Record<string, unknown> = {}) =>
    auth(request(app.getHttpServer()).get(path)).query(query);
  const body = (overrides: Record<string, unknown> = {}) => ({
    id: v7(),
    memberId: payerSocioId,
    workDate: '2026-10-05',
    minutes: 60,
    note: 'Stock sorting',
    createdByMemberId: actorId,
    deviceId,
    ...overrides,
  });
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    const account = await prisma.account.create({
      data: {
        username: randomUUID(),
        passwordHash: 'not-a-login-fixture',
        contextId,
      },
    });
    accountId = account.id;
    token = await app.get(JwtService).signAsync({ sub: account.id });
    await withTestTenant(contextId, async () => {
      const member = (
        name: string,
        role: 'socio' | 'colaborador',
        active = true,
      ) => prisma.member.create({ data: { name, role, active, contextId } });
      actorId = (await member('Recorder', 'socio')).id;
      payerSocioId = (await member('Payer socio', 'socio')).id;
      collaboratorId = (await member('Collaborator', 'colaborador')).id;
      inactiveId = (await member('Former member', 'colaborador', false)).id;
      deviceId = (
        await prisma.device.create({
          data: { name: 'Tablet', authorized: true, contextId },
        })
      ).id;
    });
    foreignMemberId = await withTestTenant(
      otherContext,
      async () =>
        (
          await prisma.member.create({
            data: { name: 'Other', role: 'socio', contextId: otherContext },
          })
        ).id,
    );
    foreignAccountId = (
      await prisma.account.create({
        data: {
          username: randomUUID(),
          passwordHash: 'fixture',
          contextId: otherContext,
        },
      })
    ).id;
    foreignDeviceId = await withTestTenant(
      otherContext,
      async () =>
        (
          await prisma.device.create({
            data: {
              name: 'Foreign tablet',
              contextId: otherContext,
              authorized: true,
            },
          })
        ).id,
    );
  });

  afterAll(async () => {
    // Fixtures are isolated by unique context; the database is never reset.
    if (prisma) {
      for (const ctx of [contextId, otherContext])
        await withTestTenant(ctx, async () => {
          await prisma.workShiftReversal.deleteMany({
            where: { contextId: ctx },
          });
          await prisma.workShift.deleteMany({ where: { contextId: ctx } });
          await prisma.device.deleteMany({ where: { contextId: ctx } });
          await prisma.member.deleteMany({ where: { contextId: ctx } });
        });
      await prisma.account.deleteMany({
        where: { contextId: { in: [contextId, otherContext] } },
      });
    }
    await app?.close();
  });

  it('allows multiple records and persists normalized replay warnings', async () => {
    const first = body({ workDate: '2026-01-01', minutes: undefined });
    const receipt = await post(first).expect(201);
    expect(receipt.body).toMatchObject({
      minutes: null,
      workDate: '2026-01-01',
      warnings: [],
    });
    const second = await post(body({ workDate: '2026-01-01' })).expect(201);
    expect(second.body.warnings).toEqual([
      { code: 'MULTIPLE_SHIFTS_SAME_DAY', existingActiveShiftCount: 1 },
    ]);
    const replay = await post({ ...first, minutes: null }).expect(200);
    expect(replay.body).toEqual(receipt.body);
    await post({ ...first, minutes: 2 }).expect(409);
  });
  it('serializes concurrent identical creates and distinct same-day warnings', async () => {
    const dto = body({ workDate: '2026-01-02' });
    const replays = await Promise.all([post(dto), post(dto)]);
    expect(replays.map((res) => res.status).sort((a, b) => a - b)).toEqual([
      200, 201,
    ]);
    expect(replays[0].body).toEqual(replays[1].body);
    const responses = await Promise.all([
      post(body({ workDate: '2026-01-03' })),
      post(body({ workDate: '2026-01-03' })),
    ]);
    expect(responses.map((res) => res.status)).toEqual([201, 201]);
    expect(
      responses
        .map((res) => res.body.warnings[0]?.existingActiveShiftCount ?? 0)
        .sort((a, b) => a - b),
    ).toEqual([0, 1]);
  });
  it('requires active same-tenant workers and binds recorder/device', async () => {
    for (const memberId of [inactiveId, foreignMemberId, randomUUID()])
      await post(body({ memberId })).expect(403);
    await post(body({ createdByMemberId: collaboratorId })).expect(403);
    await post(body({ deviceId: randomUUID() })).expect(403);
    await post(body({ contextId: otherContext })).expect(400);
    await post(body({ createdByAccountId: randomUUID() })).expect(400);
    await post(body(), collaboratorId).expect(403);
  });
  it('rejects invalid dates, duration, ranges and cursors', async () => {
    for (const workDate of ['2026-02-29', '2026-04-31', '2026-10-05T00:00:00Z'])
      await post(body({ workDate })).expect(400);
    for (const minutes of [0, -1, 1.5, '60', 2147483648])
      await post(body({ minutes })).expect(400);
    await get(endpoint, { from: '2026-01-01', to: '2026-01-01' }).expect(400);
    await get(endpoint, { cursor: 'invalid' }).expect(400);
    await get(endpoint, {
      cursor: Buffer.from(
        JSON.stringify({ workDate: '2026-02-29', id: v7() }),
      ).toString('base64url'),
    }).expect(400);
  });
  it('forces collaborator own-only list and summary while socios see both roles', async () => {
    await post(
      body({ memberId: collaboratorId, workDate: '2026-02-01', minutes: null }),
    ).expect(201);
    await post(
      body({ memberId: collaboratorId, workDate: '2026-02-01', minutes: 50 }),
    ).expect(201);
    await post(body({ workDate: '2026-02-01', minutes: 100 })).expect(201);
    const own = await auth(
      request(app.getHttpServer()).get(endpoint),
      collaboratorId,
    ).expect(200);
    expect(own.body.items.length).toBe(2);
    expect(
      own.body.items.every(
        (row: { memberId: string }) => row.memberId === collaboratorId,
      ),
    ).toBe(true);
    await auth(request(app.getHttpServer()).get(endpoint), collaboratorId)
      .query({ memberId: payerSocioId })
      .expect(403);
    const summary = await get(endpoint + '/summary', {
      from: '2026-02-01',
      to: '2026-02-02',
    }).expect(200);
    expect(summary.body.totals).toEqual({
      shiftCount: 3,
      knownMinutes: 150,
      unknownDurationCount: 1,
    });
    const ownSummary = await auth(
      request(app.getHttpServer()).get(endpoint + '/summary'),
      collaboratorId,
    ).expect(200);
    expect(ownSummary.body.totals).toEqual({
      shiftCount: 2,
      knownMinutes: 50,
      unknownDurationCount: 1,
    });
    await auth(
      request(app.getHttpServer()).get(endpoint + '/summary'),
      collaboratorId,
    )
      .query({ memberId: payerSocioId })
      .expect(403);
  });
  it('paginates date/id descending without exposing internal receipts', async () => {
    const page = await get(endpoint, {
      from: '2026-01-01',
      to: '2026-02-01',
      limit: 2,
    }).expect(200);
    expect(page.body.items).toHaveLength(2);
    expect(page.body.nextCursor).toBeTruthy();
    const next = await get(endpoint, {
      from: '2026-01-01',
      to: '2026-02-01',
      limit: 2,
      cursor: page.body.nextCursor,
    }).expect(200);
    expect(
      next.body.items.some((item: { id: string }) =>
        page.body.items.some((first: { id: string }) => first.id === item.id),
      ),
    ).toBe(false);
    expect(JSON.stringify(page.body)).not.toContain('requestFingerprint');
    expect(JSON.stringify(page.body)).not.toContain('creationResponse');
  });
  it('keeps history and exact replay after worker deactivation', async () => {
    const dto = body({ memberId: collaboratorId, workDate: '2026-03-01' });
    const original = await post(dto).expect(201);
    await withTestTenant(contextId, () =>
      prisma.member.update({
        where: { id: collaboratorId },
        data: { active: false },
      }),
    );
    try {
      expect((await post(dto).expect(200)).body).toEqual(original.body);
      await post(body({ memberId: collaboratorId })).expect(403);
      const history = await get(endpoint, { memberId: collaboratorId }).expect(
        200,
      );
      expect(
        history.body.items.some((row: { id: string }) => row.id === dto.id),
      ).toBe(true);
    } finally {
      await withTestTenant(contextId, () =>
        prisma.member.update({
          where: { id: collaboratorId },
          data: { active: true },
        }),
      );
    }
  });

  it('conflicts on replay from a different authenticated account', async () => {
    const dto = body({ workDate: '2026-03-02' });
    await post(dto).expect(201);
    const another = await prisma.account.create({
      data: { username: randomUUID(), passwordHash: 'fixture', contextId },
    });
    const anotherToken = await app
      .get(JwtService)
      .signAsync({ sub: another.id });
    await request(app.getHttpServer())
      .post(endpoint)
      .auth(anotherToken, { type: 'bearer' })
      .set('x-member-id', actorId)
      .set('x-device-id', deviceId)
      .send(dto)
      .expect(409);
  });
  it('runs FORCE RLS as a non-bypass runtime role and hides foreign rows', async () => {
    const dto = body({ workDate: '2026-03-03' });
    await post(dto).expect(201);
    await withTestTenant(otherContext, async () => {
      expect(
        await prisma.workShift.findMany({ where: { id: dto.id } }),
      ).toEqual([]);
      await prisma.$transaction(async (tx) => {
        const role = await tx.$queryRaw<
          { rolsuper: boolean; rolbypassrls: boolean }[]
        >`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
        expect(role[0]).toEqual({ rolsuper: false, rolbypassrls: false });
        const tables = await tx.$queryRaw<
          { relrowsecurity: boolean; relforcerowsecurity: boolean }[]
        >`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('WorkShift', 'WorkShiftReversal')`;
        expect(tables).toHaveLength(2);
        expect(
          tables.every(
            (table) => table.relrowsecurity && table.relforcerowsecurity,
          ),
        ).toBe(true);
        expect(
          await tx.$queryRaw`SELECT id FROM "WorkShift" WHERE id = ${dto.id}::uuid`,
        ).toEqual([]);
      });
    });
  });
  it('rejects mixed-tenant worker edges even through raw SQL', async () => {
    await expect(
      withTestTenant(contextId, () =>
        prisma.$transaction(async (tx) => {
          await tx.$executeRaw`INSERT INTO "WorkShift" (id, "contextId", "memberId", "workDate", "createdByMemberId", "createdByAccountId", "deviceId", "requestFingerprint", "creationResponse") VALUES (${v7()}::uuid, ${contextId}, ${foreignMemberId}::uuid, '2026-10-05', ${actorId}::uuid, ${accountId}::uuid, ${deviceId}::uuid, 'fixture', '{}'::jsonb)`;
        }),
      ),
    ).rejects.toThrow();
  });

  it('reauthorizes previously selected recorder/device inside the write transaction', async () => {
    const service = app.get(WorkShiftsService);
    const actor = {
      account: { id: accountId, contextId, memberId: null },
      selection: { memberId: actorId, deviceId },
    };
    await withTestTenant(contextId, async () => {
      await prisma.member.update({
        where: { id: actorId },
        data: { role: 'colaborador' },
      });
      try {
        await expect(service.create(actor, body())).rejects.toThrow(
          'Operation origin is no longer authorized',
        );
      } finally {
        await prisma.member.update({
          where: { id: actorId },
          data: { role: 'socio' },
        });
      }
      await prisma.device.update({
        where: { id: deviceId },
        data: { authorized: false },
      });
      try {
        await expect(service.create(actor, body())).rejects.toThrow(
          'Operation origin is no longer authorized',
        );
      } finally {
        await prisma.device.update({
          where: { id: deviceId },
          data: { authorized: true },
        });
      }
    });
  });
  it('denies raw unscoped reads and rejects mixed recorder/device/account foreign keys', async () => {
    const client = new Client({
      connectionString: process.env.DATABASE_URL_TEST,
    });
    await client.connect();
    try {
      expect((await client.query('SELECT id FROM "WorkShift"')).rows).toEqual(
        [],
      );
      expect(
        (await client.query('SELECT id FROM "WorkShiftReversal"')).rows,
      ).toEqual([]);
    } finally {
      await client.end();
    }
    for (const edge of [
      { recorder: foreignMemberId, device: deviceId, account: accountId },
      { recorder: actorId, device: foreignDeviceId, account: accountId },
      { recorder: actorId, device: deviceId, account: foreignAccountId },
    ]) {
      await expect(
        withTestTenant(contextId, () =>
          prisma.$transaction(async (tx) => {
            await tx.$executeRaw`INSERT INTO "WorkShift" (id, "contextId", "memberId", "workDate", "createdByMemberId", "createdByAccountId", "deviceId", "requestFingerprint", "creationResponse") VALUES (${v7()}::uuid, ${contextId}, ${payerSocioId}::uuid, '2026-10-05', ${edge.recorder}::uuid, ${edge.account}::uuid, ${edge.device}::uuid, 'fixture', '{}'::jsonb)`;
          }),
        ),
      ).rejects.toThrow();
    }
  });
  describe('auditable corrections', () => {
    const reverseBody = (overrides: Record<string, unknown> = {}) => ({
      id: v7(),
      reason: 'Incorrect duration',
      occurredAt: '2026-10-05T12:00:00-06:00',
      createdByMemberId: actorId,
      deviceId,
      ...overrides,
    });
    const reverse = (id: string, dto: unknown, memberId = actorId) =>
      auth(
        request(app.getHttpServer()).post(endpoint + '/' + id + '/reversals'),
        memberId,
      ).send(dto as object);
    const original = async (overrides: Record<string, unknown> = {}) => {
      const dto = body(overrides);
      await post(dto).expect(201);
      return dto;
    };
    it('atomically reverses and replaces without counting corrected original as a duplicate', async () => {
      const shift = await original({ workDate: '2026-04-01', minutes: 20 });
      const replacement = body({ workDate: '2026-04-01', minutes: null });
      const dto = reverseBody({ replacement });
      const res = await reverse(shift.id, dto).expect(201);
      expect(res.body).toMatchObject({
        workShiftId: shift.id,
        replacementWorkShiftId: replacement.id,
        original: { id: shift.id, minutes: 20 },
        replacement: { id: replacement.id, minutes: null, warnings: [] },
      });
      expect((await reverse(shift.id, dto).expect(200)).body).toEqual(res.body);
      await reverse(shift.id, { ...dto, reason: 'Changed' }).expect(409);
      await reverse(shift.id, reverseBody()).expect(409);
      const summary = await get(endpoint + '/summary', {
        from: '2026-04-01',
        to: '2026-04-02',
      }).expect(200);
      expect(summary.body.totals).toEqual({
        shiftCount: 1,
        knownMinutes: 0,
        unknownDurationCount: 1,
      });
      const list = await get(endpoint, {
        from: '2026-04-01',
        to: '2026-04-02',
        status: 'active',
      }).expect(200);
      expect(list.body.items[0].replacedByReversal).toEqual({
        id: dto.id,
        workShiftId: shift.id,
      });
      expect(
        (
          await get(endpoint, {
            from: '2026-04-01',
            to: '2026-04-02',
            status: 'reversed',
          }).expect(200)
        ).body.items[0].id,
      ).toBe(shift.id);
      await reverse(replacement.id, reverseBody()).expect(201);
      expect(
        (
          await get(endpoint + '/summary', {
            from: '2026-04-01',
            to: '2026-04-02',
          }).expect(200)
        ).body.totals.shiftCount,
      ).toBe(0);
    });
    it('persists original and replacement receipts across later changes', async () => {
      const shift = await original({ workDate: '2026-04-02' });
      const initial = (await post(shift).expect(200)).body;
      const replacement = body({
        workDate: '2026-04-02',
        memberId: collaboratorId,
      });
      const dto = reverseBody({ replacement });
      const receipt = (await reverse(shift.id, dto).expect(201)).body;
      await post(
        body({ workDate: '2026-04-02', memberId: collaboratorId }),
      ).expect(201);
      await withTestTenant(contextId, () =>
        prisma.member.update({
          where: { id: collaboratorId },
          data: { active: false },
        }),
      );
      try {
        expect((await reverse(shift.id, dto).expect(200)).body).toEqual(
          receipt,
        );
        expect((await post(shift).expect(200)).body).toEqual(initial);
      } finally {
        await withTestTenant(contextId, () =>
          prisma.member.update({
            where: { id: collaboratorId },
            data: { active: true },
          }),
        );
      }
    });
    it('rolls back on inactive/foreign or used replacement identities', async () => {
      const shift = await original({ workDate: '2026-04-03' });
      const used = await original({ workDate: '2026-04-04' });
      for (const replacement of [
        body({ memberId: inactiveId }),
        body({ memberId: foreignMemberId }),
        used,
      ]) {
        const dto = reverseBody({ replacement });
        await reverse(shift.id, dto).expect(replacement === used ? 409 : 403);
        await withTestTenant(contextId, async () => {
          expect(
            await prisma.workShiftReversal.count({
              where: { workShiftId: shift.id },
            }),
          ).toBe(0);
          if (replacement !== used)
            expect(
              await prisma.workShift.count({
                where: { id: replacement.id as string },
              }),
            ).toBe(0);
        });
      }
    });
    it('validates immutable correction identities and zoned audit instant', async () => {
      const shift = await original({ workDate: '2026-04-05' });
      for (const dto of [
        reverseBody({ id: shift.id }),
        reverseBody({ reason: ' ' }),
        reverseBody({ occurredAt: '2026-10-05' }),
        reverseBody({ occurredAt: '2026-10-05T12:00:00.1234Z' }),
        reverseBody({ replacement: body({ id: shift.id }) }),
      ])
        await reverse(shift.id, dto).expect(400);
      await reverse(
        shift.id,
        reverseBody({ createdByMemberId: collaboratorId }),
      ).expect(403);
      await reverse(shift.id, reverseBody(), collaboratorId).expect(403);
      await reverse(v7(), reverseBody()).expect(404);
      await reverse(
        shift.id,
        reverseBody({
          replacement: body({ createdByMemberId: collaboratorId }),
        }),
      ).expect(403);
    });
    it('serializes identical and distinct reversal races', async () => {
      const shift = await original({ workDate: '2026-04-06' });
      const dto = reverseBody();
      const identical = await Promise.all([
        reverse(shift.id, dto),
        reverse(shift.id, dto),
      ]);
      expect(identical.map((res) => res.status).sort((a, b) => a - b)).toEqual([
        200, 201,
      ]);
      expect(identical[0].body).toEqual(identical[1].body);
      const another = await original({ workDate: '2026-04-07' });
      const competing = await Promise.all([
        reverse(another.id, reverseBody()),
        reverse(another.id, reverseBody()),
      ]);
      expect(competing.map((res) => res.status).sort((a, b) => a - b)).toEqual([
        201, 409,
      ]);
    });
    it('shares ordered day locks across replacement and concurrent recording', async () => {
      const shift = await original({ workDate: '2026-04-08' });
      const replacement = body({ workDate: '2026-04-08' });
      const concurrent = body({ workDate: '2026-04-08' });
      const results = await Promise.all([
        reverse(shift.id, reverseBody({ replacement })),
        post(concurrent),
      ]);
      expect(results.map((res) => res.status)).toEqual([201, 201]);
      const replacementCount =
        results[0].body.replacement.warnings[0]?.existingActiveShiftCount ?? 0;
      const createCount =
        results[1].body.warnings[0]?.existingActiveShiftCount ?? 0;
      expect([replacementCount, createCount]).toEqual(
        replacementCount === 0 ? [0, 1] : [1, 1],
      );
    });
    it('does not reuse correction identities for another shift or correction', async () => {
      const shift = await original({ workDate: '2026-04-09' });
      const dto = reverseBody();
      await reverse(shift.id, dto).expect(201);
      await post(body({ id: dto.id })).expect(409);
      const another = await original({ workDate: '2026-04-10' });
      await reverse(another.id, reverseBody({ id: another.id })).expect(400);
      await reverse(another.id, reverseBody({ id: shift.id })).expect(409);
      await reverse(
        another.id,
        reverseBody({ replacement: body({ id: dto.id }) }),
      ).expect(409);
    });
    it('hides reversals through ORM and raw RLS from a foreign tenant', async () => {
      const shift = await original({ workDate: '2026-04-11' });
      const dto = reverseBody();
      await reverse(shift.id, dto).expect(201);
      await withTestTenant(otherContext, async () => {
        expect(
          await prisma.workShiftReversal.findMany({ where: { id: dto.id } }),
        ).toEqual([]);
        await prisma.$transaction(async (tx) => {
          expect(
            await tx.$queryRaw`SELECT id FROM "WorkShiftReversal" WHERE id = ${dto.id}::uuid`,
          ).toEqual([]);
        });
      });
    });

    it('locks opposite worker/day corrections in one deterministic order', async () => {
      const first = await original({
        workDate: '2026-04-14',
        memberId: payerSocioId,
      });
      const second = await original({
        workDate: '2026-04-15',
        memberId: collaboratorId,
      });
      const responses = await Promise.all([
        reverse(
          first.id,
          reverseBody({
            replacement: body({
              workDate: '2026-04-15',
              memberId: collaboratorId,
            }),
          }),
        ),
        reverse(
          second.id,
          reverseBody({
            replacement: body({
              workDate: '2026-04-14',
              memberId: payerSocioId,
            }),
          }),
        ),
      ]);
      expect(responses.map((res) => res.status)).toEqual([201, 201]);
      expect(
        (
          await get(endpoint + '/summary', {
            from: '2026-04-14',
            to: '2026-04-16',
          }).expect(200)
        ).body.totals.shiftCount,
      ).toBe(2);
    });
    it('serializes a same-day creation racing a reversal without replacement', async () => {
      const shift = await original({ workDate: '2026-04-16' });
      const responses = await Promise.all([
        reverse(shift.id, reverseBody()),
        post(body({ workDate: '2026-04-16' })),
      ]);
      expect(responses.map((res) => res.status)).toEqual([201, 201]);
      expect([0, 1]).toContain(
        responses[1].body.warnings[0]?.existingActiveShiftCount ?? 0,
      );
      expect(
        (
          await get(endpoint + '/summary', {
            from: '2026-04-16',
            to: '2026-04-17',
          }).expect(200)
        ).body.totals.shiftCount,
      ).toBe(1);
    });

    it('returns generic foreign-target absence and rolls back a late reversal identity collision', async () => {
      const foreignShiftId = v7();
      const foreignReversalId = v7();
      await withTestTenant(otherContext, async () => {
        await prisma.workShift.create({
          data: {
            id: foreignShiftId,
            contextId: otherContext,
            memberId: foreignMemberId,
            workDate: new Date('2026-04-17T00:00:00Z'),
            createdByMemberId: foreignMemberId,
            createdByAccountId: foreignAccountId,
            deviceId: foreignDeviceId,
            requestFingerprint: 'fixture',
            creationResponse: {},
          },
        });
        await prisma.workShiftReversal.create({
          data: {
            id: foreignReversalId,
            workShiftId: foreignShiftId,
            contextId: otherContext,
            reason: 'Fixture correction',
            occurredAt: new Date(),
            createdByMemberId: foreignMemberId,
            createdByAccountId: foreignAccountId,
            deviceId: foreignDeviceId,
            requestFingerprint: 'fixture',
            creationResponse: {},
          },
        });
      });
      await reverse(foreignShiftId, reverseBody()).expect(404);
      await post(body({ id: foreignShiftId })).expect(409);
      const shift = await original({ workDate: '2026-04-18' });
      const replacement = body({ workDate: '2026-04-18' });
      await reverse(
        shift.id,
        reverseBody({ id: foreignReversalId, replacement }),
      ).expect(409);
      await withTestTenant(contextId, async () => {
        expect(
          await prisma.workShift.count({ where: { id: replacement.id } }),
        ).toBe(0);
        expect(
          await prisma.workShiftReversal.count({
            where: { workShiftId: shift.id },
          }),
        ).toBe(0);
      });
    });
  });
});

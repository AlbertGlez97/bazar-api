import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { v7 } from 'uuid';
import request from 'supertest';
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
      await prisma.account.deleteMany({ where: { contextId } });
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
});

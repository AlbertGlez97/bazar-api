import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { v7 } from 'uuid';
import request from 'supertest';
import { FinanceReservesService } from '../src/finance/finance-reserves.service.js';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { withTestTenant } from './tenant-scope.js';

describe('planned finance reserves', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const contexts = [
    `reserves-${randomUUID()}`,
    `reserves-other-${randomUUID()}`,
  ];
  const actors: {
    accountId: string;
    token: string;
    memberId: string;
    collaboratorId: string;
    inactiveId: string;
    collaboratorToken: string;
    inactiveToken: string;
    deviceId: string;
    revokedDeviceId: string;
  }[] = [];
  const endpoint = '/api/v1/finance/reserves';
  // The token decides who acts (one account per person).
  const auth = (
    req: request.Test,
    index = 0,
    token?: string,
    deviceId?: string,
  ) =>
    req
      .auth(token ?? actors[index].token, { type: 'bearer' })
      .set('x-device-id', deviceId ?? actors[index].deviceId);
  const accountFor = async (contextId: string, memberId: string) => {
    const account = await prisma.account.create({
      data: {
        username: randomUUID(),
        passwordHash: 'not-a-login-fixture',
        contextId,
        memberId,
      },
    });
    return {
      id: account.id,
      token: await app.get(JwtService).signAsync({ sub: account.id }),
    };
  };
  // A second socio of the first business, with their own account.
  const secondSocio = async () => {
    const member = await withTestTenant(contexts[0], () =>
      prisma.member.create({
        data: { contextId: contexts[0], name: 'Second socio', role: 'socio' },
      }),
    );
    return {
      memberId: member.id,
      ...(await accountFor(contexts[0], member.id)),
    };
  };
  const body = (overrides: Record<string, unknown> = {}, index = 0) => ({
    id: v7(),
    name: 'Rent buffer',
    amountMinor: 5000,
    periodFrom: '2026-10-01',
    periodTo: '2026-11-01',
    occurredAt: '2026-10-07T12:00:00Z',
    createdByMemberId: actors[index].memberId,
    deviceId: actors[index].deviceId,
    ...overrides,
  });
  const post = (dto: object, index = 0) =>
    auth(request(app.getHttpServer()).post(endpoint), index).send(dto);
  const get = (query: Record<string, unknown> = {}, index = 0) =>
    auth(request(app.getHttpServer()).get(endpoint), index).query(query);
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
    prisma = app.get(PrismaService);
    for (const contextId of contexts) {
      const fixture = await withTestTenant(contextId, async () => {
        const member = (role: 'socio' | 'colaborador', active = true) =>
          prisma.member.create({
            data: { contextId, name: 'Reserve fixture', role, active },
          });
        const memberId = (await member('socio')).id;
        const collaboratorId = (await member('colaborador')).id;
        const inactiveId = (await member('socio', false)).id;
        const deviceId = (
          await prisma.device.create({
            data: { contextId, name: 'Reserve tablet', authorized: true },
          })
        ).id;
        const revokedDeviceId = (
          await prisma.device.create({
            data: { contextId, name: 'Revoked tablet', authorized: false },
          })
        ).id;
        return {
          memberId,
          collaboratorId,
          inactiveId,
          deviceId,
          revokedDeviceId,
        };
      });
      const socio = await accountFor(contextId, fixture.memberId);
      const collaborator = await accountFor(contextId, fixture.collaboratorId);
      const inactive = await accountFor(contextId, fixture.inactiveId);
      actors.push({
        accountId: socio.id,
        token: socio.token,
        collaboratorToken: collaborator.token,
        inactiveToken: inactive.token,
        ...fixture,
      });
    }
  });
  afterAll(async () => {
    if (prisma)
      for (const contextId of contexts) {
        await withTestTenant(contextId, async () => {
          await prisma.financeReserveReversal.deleteMany({
            where: { contextId },
          });
          await prisma.financeReserve.deleteMany({ where: { contextId } });
        });
        // Accounts before Members (Account.memberId is ON DELETE RESTRICT),
        // but after the reserves that reference them.
        await prisma.account.deleteMany({ where: { contextId } });
        await withTestTenant(contextId, async () => {
          await prisma.device.deleteMany({ where: { contextId } });
          await prisma.member.deleteMany({ where: { contextId } });
        });
      }
    await app?.close();
  });
  it('creates a frozen planning receipt and lists it in its exact period', async () => {
    const dto = body();
    const response = await post(dto).expect(201);
    expect(response.body).toMatchObject({
      ...dto,
      occurredAt: new Date(dto.occurredAt).toISOString(),
      contextId: contexts[0],
      createdByAccountId: actors[0].accountId,
      currency: 'MXN',
    });
    const list = await get({ from: dto.periodFrom, to: dto.periodTo }).expect(
      200,
    );
    expect(list.body.items.map((item: { id: string }) => item.id)).toContain(
      dto.id,
    );
  });
  it('replays normalized content with the original immutable receipt even after reversal', async () => {
    const dto = body({
      name: '  Quote buffer  ',
      note: '  Awaiting invoice  ',
    });
    const original = (await post(dto).expect(201)).body;
    const replay = {
      ...dto,
      id: dto.id.toUpperCase(),
      name: 'Quote buffer',
      note: 'Awaiting invoice',
      occurredAt: '2026-10-07T06:00:00-06:00',
    };
    expect((await post(replay).expect(200)).body).toEqual(original);
    await withTestTenant(contexts[0], () =>
      prisma.financeReserveReversal.create({
        data: {
          id: v7(),
          contextId: contexts[0],
          reserveId: dto.id,
          reason: 'Fixture cancellation for immutable replay',
          occurredAt: new Date(),
          createdByMemberId: actors[0].memberId,
          createdByAccountId: actors[0].accountId,
          deviceId: actors[0].deviceId,
          requestFingerprint: randomUUID(),
          creationResponse: {},
        },
      }),
    );
    expect((await post(replay).expect(200)).body).toEqual(original);
    const active = await get({ from: dto.periodFrom, to: dto.periodTo }).expect(
      200,
    );
    expect(
      active.body.items.map((row: { id: string }) => row.id),
    ).not.toContain(dto.id);
    const reversed = await get({
      from: dto.periodFrom,
      to: dto.periodTo,
      status: 'reversed',
    }).expect(200);
    expect(reversed.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: dto.id,
          status: 'reversed',
          reversal: expect.objectContaining({ reserveId: dto.id }),
        }),
      ]),
    );
  });
  it('conflicts on changed content or person, without exposing foreign identities', async () => {
    const dto = body();
    await post(dto).expect(201);
    for (const change of [
      { amountMinor: 5001 },
      { name: 'Changed' },
      { periodTo: '2026-12-01' },
      { note: 'Changed' },
    ])
      await post({ ...dto, ...change }).expect(409);
    // Another socio (own account) replaying the same id is a conflict.
    const second = await secondSocio();
    await request(app.getHttpServer())
      .post(endpoint)
      .auth(second.token, { type: 'bearer' })
      .set('x-device-id', actors[0].deviceId)
      .send({ ...dto, createdByMemberId: second.memberId })
      .expect(409);
    await post(
      {
        ...dto,
        createdByMemberId: actors[1].memberId,
        deviceId: actors[1].deviceId,
      },
      1,
    ).expect(404);
    expect((await get({}, 1).expect(200)).body.items).toHaveLength(0);
  });
  it.each([
    { contextId: 'client-chosen' },
    { createdByAccountId: randomUUID() },
    { name: '   ' },
    { amountMinor: '5000' },
    { currency: 'USD' },
    { periodFrom: '2026-02-30' },
    { periodTo: '2026-10-01' },
    { periodTo: '2026-09-01' },
    { periodFrom: '2026-10-01T00:00:00Z' },
    { note: 4 },
    { id: randomUUID() },
  ])('rejects invalid or client-owned scope fields %j', async (change) => {
    await post(body(change)).expect(400);
  });
  it('rejects attribution mismatch and unauthorized actors/devices', async () => {
    await post(body({ createdByMemberId: actors[0].collaboratorId })).expect(
      403,
    );
    await post(body({ deviceId: actors[0].revokedDeviceId })).expect(403);
    await request(app.getHttpServer()).post(endpoint).send(body()).expect(401);
    // A colaborador, a deactivated socio and a socio of another business.
    for (const [token, memberId] of [
      [actors[0].collaboratorToken, actors[0].collaboratorId],
      [actors[0].inactiveToken, actors[0].inactiveId],
      [actors[1].token, actors[1].memberId],
    ]) {
      await auth(request(app.getHttpServer()).post(endpoint), 0, token)
        .send(body({ createdByMemberId: memberId }))
        .expect(403);
      await auth(
        request(app.getHttpServer()).get(endpoint),
        0,
        token,
      ).expect(403);
    }
    await auth(
      request(app.getHttpServer()).post(endpoint),
      0,
      undefined,
      actors[0].revokedDeviceId,
    )
      .send(body({ deviceId: actors[0].revokedDeviceId }))
      .expect(403);
  });
  it.each([
    { from: '2026-10-01' },
    { to: '2026-11-01' },
    { from: '2026-10-02', to: '2026-10-01' },
    { from: '2026-02-30', to: '2026-03-01' },
    { limit: '1e2' },
    { limit: '0x10' },
    { status: 'all' },
    { cursor: 'garbage' },
    { limit: '0' },
    { limit: '101' },
    { unknown: 'filter' },
  ])('rejects malformed list filters %j', async (query) => {
    await get(query).expect(400);
  });
  it('paginates deterministically and binds cursors to tenant and exact filters', async () => {
    const period = { periodFrom: '2027-01-01', periodTo: '2027-02-01' };
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const dto = body(period);
      ids.push(dto.id);
      await post(dto).expect(201);
    }
    await post(
      body({ periodFrom: period.periodFrom, periodTo: '2027-03-01' }),
    ).expect(201);
    const query = { from: period.periodFrom, to: period.periodTo, limit: 1 };
    const pages: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await get({
        ...query,
        ...(cursor ? { cursor } : {}),
      }).expect(200);
      expect(page.body.items).toHaveLength(1);
      expect(page.body.items[0]).not.toHaveProperty('requestFingerprint');
      expect(page.body.items[0]).not.toHaveProperty('creationResponse');
      pages.push(page.body.items[0].id);
      cursor = page.body.nextCursor;
      if (cursor) {
        await get({ ...query, cursor }, 1).expect(400);
        await get({ ...query, cursor, status: 'reversed' }).expect(400);
        await get({ ...query, cursor, to: '2027-03-01' }).expect(400);
      }
    } while (cursor);
    expect(pages).toHaveLength(3);
    expect(new Set(pages)).toEqual(new Set(ids));
    const repeated = await get(query).expect(200);
    expect(repeated.body.items[0].id).toBe(pages[0]);
  });
  it('applies only active exact-period reserves to overview and preserves negative availability', async () => {
    const period = { periodFrom: '2028-01-01', periodTo: '2028-02-01' };
    await post(body({ ...period, amountMinor: 500 })).expect(201);
    await post(body({ ...period, amountMinor: 200 })).expect(201);
    await post(
      body({
        periodFrom: '2028-01-01',
        periodTo: '2028-03-01',
        amountMinor: 900,
      }),
    ).expect(201);
    await post(
      body({
        periodFrom: '2028-01-02',
        periodTo: '2028-02-01',
        amountMinor: 900,
      }),
    ).expect(201);
    const dto = body({ ...period, amountMinor: 900 });
    await post(dto).expect(201);
    await withTestTenant(contexts[0], () =>
      prisma.financeReserveReversal.create({
        data: {
          id: v7(),
          contextId: contexts[0],
          reserveId: dto.id,
          reason: 'Fixture cancellation',
          occurredAt: new Date(),
          createdByMemberId: actors[0].memberId,
          createdByAccountId: actors[0].accountId,
          deviceId: actors[0].deviceId,
          requestFingerprint: randomUUID(),
          creationResponse: {},
        },
      }),
    );
    const result = await auth(
      request(app.getHttpServer()).get('/api/v1/finance/overview'),
    )
      .query({ from: period.periodFrom, to: period.periodTo })
      .expect(200);
    expect(result.body.reserves).toEqual({
      activeCount: 2,
      plannedMinor: 700,
      matching: 'EXACT_PERIOD',
    });
    expect(result.body.result).toMatchObject({
      recordedOperatingResultMinor: 0,
      potentiallyAvailableMinor: -700,
      status: 'complete',
      isCashBalance: false,
      isWithdrawableProfit: false,
    });
    expect(
      result.body.warnings.map((row: { code: string }) => row.code),
    ).not.toContain('RESERVES_PENDING');
    const foreign = await auth(
      request(app.getHttpServer()).get('/api/v1/finance/overview'),
      1,
    )
      .query({ from: period.periodFrom, to: period.periodTo })
      .expect(200);
    expect(foreign.body.reserves.plannedMinor).toBe(0);
  });
  it('denies raw unscoped access and enforces composite audit tenant edges', async () => {
    const raw = new PrismaService();
    await raw.$connect();
    const dto = body();
    const data = {
      ...dto,
      contextId: contexts[0],
      periodFrom: new Date(dto.periodFrom + 'T00:00:00Z'),
      periodTo: new Date(dto.periodTo + 'T00:00:00Z'),
      occurredAt: new Date(dto.occurredAt),
      createdByAccountId: actors[0].accountId,
      requestFingerprint: randomUUID(),
      creationResponse: {},
    };
    try {
      expect(await raw.financeReserve.findMany()).toEqual([]);
      expect(await raw.financeReserveReversal.findMany()).toEqual([]);
      await expect(raw.financeReserve.create({ data })).rejects.toThrow();
      for (const change of [
        { createdByMemberId: actors[1].memberId },
        { deviceId: actors[1].deviceId },
        { createdByAccountId: actors[1].accountId },
      ]) {
        await expect(
          raw.$transaction(async (tx) => {
            await tx.$executeRaw`SELECT set_config('app.context_id', ${contexts[0]}, true)`;
            return tx.financeReserve.create({
              data: { ...data, id: v7(), ...change },
            });
          }),
        ).rejects.toMatchObject({ code: 'P2003' });
      }
      const foreign = body({}, 1);
      await post(foreign, 1).expect(201);
      await expect(
        raw.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.context_id', ${contexts[0]}, true)`;
          return tx.financeReserveReversal.create({
            data: {
              id: v7(),
              contextId: contexts[0],
              reserveId: foreign.id,
              reason: 'Invalid cross-context reversal',
              occurredAt: new Date(),
              createdByMemberId: actors[0].memberId,
              createdByAccountId: actors[0].accountId,
              deviceId: actors[0].deviceId,
              requestFingerprint: randomUUID(),
              creationResponse: {},
            },
          });
        }),
      ).rejects.toMatchObject({ code: 'P2003' });
    } finally {
      await raw.$disconnect();
    }
  });
  it('normalizes omitted currency and null note identically for replay', async () => {
    const dto = body();
    const receipt = (await post(dto).expect(201)).body;
    expect(
      (await post({ ...dto, currency: 'MXN', note: null }).expect(200)).body,
    ).toEqual(receipt);
  });
  const cancellation = (changes: Record<string, unknown> = {}, index = 0) => ({
    id: v7(),
    reason: 'Plan no longer needed',
    occurredAt: '2026-10-07T12:00:00Z',
    createdByMemberId: actors[index].memberId,
    deviceId: actors[index].deviceId,
    ...changes,
  });
  const reverse = (id: string, dto: object, index = 0) =>
    auth(
      request(app.getHttpServer()).post(`${endpoint}/${id}/reversals`),
      index,
    ).send(dto);
  it('cancels a plan with a frozen audit receipt and restores overview availability', async () => {
    const dto = body({
      periodFrom: '2029-01-01',
      periodTo: '2029-02-01',
      amountMinor: 1200,
    });
    const original = (await post(dto).expect(201)).body;
    const audit = cancellation();
    const response = await reverse(dto.id, audit).expect(201);
    expect(response.body).toMatchObject({
      ...audit,
      occurredAt: new Date(audit.occurredAt).toISOString(),
      reserveId: dto.id,
      contextId: contexts[0],
      createdByAccountId: actors[0].accountId,
      original,
    });
    expect(response.body.receivedAt).toMatch(/Z$/);
    expect((await reverse(dto.id, audit).expect(200)).body).toEqual(
      response.body,
    );
    expect((await post(dto).expect(200)).body).toEqual(original);
    const overview = await auth(
      request(app.getHttpServer()).get('/api/v1/finance/overview'),
    )
      .query({ from: dto.periodFrom, to: dto.periodTo })
      .expect(200);
    expect(overview.body.reserves).toEqual({
      activeCount: 0,
      plannedMinor: 0,
      matching: 'EXACT_PERIOD',
    });
    expect(overview.body.result).toMatchObject({
      recordedOperatingResultMinor: 0,
      potentiallyAvailableMinor: 0,
    });
  });
  it('normalizes cancellation replay and conflicts on payload, target, account or selected device changes', async () => {
    const dto = body();
    await post(dto).expect(201);
    const audit = cancellation({ reason: '  Quote withdrawn  ' });
    const receipt = (await reverse(dto.id, audit).expect(201)).body;
    const normalizedAudit = {
      ...audit,
      id: audit.id.toUpperCase(),
      reason: 'Quote withdrawn',
      occurredAt: '2026-10-07T06:00:00-06:00',
    };
    expect(
      (await reverse(dto.id.toUpperCase(), normalizedAudit).expect(200)).body,
    ).toEqual(receipt);
    for (const changes of [
      { reason: 'Changed' },
      { occurredAt: '2026-10-08T12:00:00Z' },
    ])
      await reverse(dto.id, { ...audit, ...changes }).expect(409);
    await reverse(v7(), audit).expect(409);
    const second = await secondSocio();
    await request(app.getHttpServer())
      .post(`${endpoint}/${dto.id}/reversals`)
      .auth(second.token, { type: 'bearer' })
      .set('x-device-id', actors[0].deviceId)
      .send({ ...audit, createdByMemberId: second.memberId })
      .expect(409);
    const device = await withTestTenant(contexts[0], () =>
      prisma.device.create({
        data: {
          contextId: contexts[0],
          name: 'Alternate authorized tablet',
          authorized: true,
        },
      }),
    );
    await auth(
      request(app.getHttpServer()).post(`${endpoint}/${dto.id}/reversals`),
      0,
      undefined,
      device.id,
    )
      .send({ ...audit, deviceId: device.id })
      .expect(409);
    await reverse(dto.id, { ...audit, deviceId: device.id }).expect(403);
  });
  it('returns the same generic 404 for foreign and unknown targets and hides foreign cancellation IDs', async () => {
    const foreign = body({}, 1);
    await post(foreign, 1).expect(201);
    const foreignAudit = cancellation({}, 1);
    await reverse(foreign.id, foreignAudit, 1).expect(201);
    const foreignResult = await reverse(foreign.id, cancellation()).expect(404);
    const missingResult = await reverse(v7(), cancellation()).expect(404);
    expect(foreignResult.body).toEqual(missingResult.body);
    const local = body();
    await post(local).expect(201);
    await reverse(local.id, cancellation({ id: foreignAudit.id })).expect(404);
    await withTestTenant(contexts[0], async () => {
      expect(
        await prisma.financeReserveReversal.count({
          where: { reserveId: local.id },
        }),
      ).toBe(0);
    });
  });
  it.each([
    { reason: '   ' },
    { id: randomUUID() },
    { occurredAt: '2026-10-07' },
    { contextId: 'client-owned' },
    { createdByAccountId: randomUUID() },
    { reserveId: v7() },
    { replacement: { name: 'Unsupported' } },
  ])(
    'rejects invalid cancellation without changing the active original %j',
    async (changes) => {
      const dto = body();
      await post(dto).expect(201);
      await reverse(dto.id, cancellation(changes)).expect(400);
      await withTestTenant(contexts[0], async () => {
        expect(
          await prisma.financeReserveReversal.count({
            where: { reserveId: dto.id },
          }),
        ).toBe(0);
        expect(
          await prisma.financeReserve.count({
            where: { id: dto.id, reversal: { is: null } },
          }),
        ).toBe(1);
      });
    },
  );
  it('rejects double reversal, self-identity and unauthorized origins', async () => {
    const dto = body();
    await post(dto).expect(201);
    await reverse(dto.id, cancellation({ id: dto.id })).expect(400);
    await reverse(
      dto.id,
      cancellation({ createdByMemberId: actors[0].collaboratorId }),
    ).expect(403);
    await request(app.getHttpServer())
      .post(`${endpoint}/${dto.id}/reversals`)
      .send(cancellation())
      .expect(401);
    for (const [token, memberId] of [
      [actors[0].collaboratorToken, actors[0].collaboratorId],
      [actors[0].inactiveToken, actors[0].inactiveId],
      [actors[1].token, actors[1].memberId],
    ])
      await auth(
        request(app.getHttpServer()).post(`${endpoint}/${dto.id}/reversals`),
        0,
        token,
      )
        .send(cancellation({ createdByMemberId: memberId }))
        .expect(403);
    await auth(
      request(app.getHttpServer()).post(`${endpoint}/${dto.id}/reversals`),
      0,
      undefined,
      actors[0].revokedDeviceId,
    )
      .send(cancellation({ deviceId: actors[0].revokedDeviceId }))
      .expect(403);
    await reverse(dto.id, cancellation()).expect(201);
    await reverse(dto.id, cancellation()).expect(409);
  });
  it('serializes concurrent identical creates and conflicting create content', async () => {
    const dto = body();
    const replies = await Promise.all([post(dto), post(dto), post(dto)]);
    expect(replies.map((res) => res.status).sort((a, b) => a - b)).toEqual([
      200, 200, 201,
    ]);
    for (const reply of replies) expect(reply.body).toEqual(replies[0].body);
    const conflicting = body();
    const conflicts = await Promise.all([
      post(conflicting),
      post({ ...conflicting, amountMinor: 5001 }),
    ]);
    expect(conflicts.map((res) => res.status).sort((a, b) => a - b)).toEqual([
      201, 409,
    ]);
    await withTestTenant(contexts[0], async () =>
      expect(
        await prisma.financeReserve.count({ where: { id: conflicting.id } }),
      ).toBe(1),
    );
  });
  it('serializes concurrent identical reversals into one immutable receipt', async () => {
    const dto = body();
    await post(dto).expect(201);
    const audit = cancellation();
    const replies = await Promise.all([
      reverse(dto.id, audit),
      reverse(dto.id, audit),
      reverse(dto.id, audit),
    ]);
    expect(replies.map((res) => res.status).sort((a, b) => a - b)).toEqual([
      200, 200, 201,
    ]);
    for (const reply of replies) expect(reply.body).toEqual(replies[0].body);
    await withTestTenant(contexts[0], async () =>
      expect(
        await prisma.financeReserveReversal.count({
          where: { reserveId: dto.id },
        }),
      ).toBe(1),
    );
  });
  it('allows one of concurrent different reversals and rejects the others', async () => {
    const dto = body();
    await post(dto).expect(201);
    const replies = await Promise.all([
      reverse(dto.id, cancellation()),
      reverse(dto.id, cancellation()),
      reverse(dto.id, cancellation()),
    ]);
    expect(replies.map((res) => res.status).sort((a, b) => a - b)).toEqual([
      201, 409, 409,
    ]);
    await withTestTenant(contexts[0], async () =>
      expect(
        await prisma.financeReserveReversal.count({
          where: { reserveId: dto.id },
        }),
      ).toBe(1),
    );
  });
  it('binds a concurrent shared reversal ID to only one target and payload', async () => {
    const a = body(),
      b = body();
    await post(a).expect(201);
    await post(b).expect(201);
    const audit = cancellation();
    const replies = await Promise.all([
      reverse(a.id, audit),
      reverse(b.id, audit),
    ]);
    expect(replies.map((res) => res.status).sort((a, b) => a - b)).toEqual([
      201, 409,
    ]);
    const c = body();
    await post(c).expect(201);
    const changed = cancellation();
    const changes = await Promise.all([
      reverse(c.id, changed),
      reverse(c.id, { ...changed, reason: 'Different content' }),
    ]);
    expect(changes.map((res) => res.status).sort((a, b) => a - b)).toEqual([
      201, 409,
    ]);
    await withTestTenant(contexts[0], async () =>
      expect(
        await prisma.financeReserveReversal.count({ where: { id: audit.id } }),
      ).toBe(1),
    );
  });
  it('rechecks stale authorization inside the transaction and leaves no cancellation on revocation', async () => {
    const dto = body();
    await post(dto).expect(201);
    const actor = {
      account: {
        id: actors[0].accountId,
        contextId: contexts[0],
        memberId: actors[0].memberId,
      },
      selection: { memberId: actors[0].memberId, deviceId: actors[0].deviceId },
    };
    const service = app.get(FinanceReservesService);
    const cases = [
      {
        revoke: () =>
          prisma.member.update({
            where: { id: actors[0].memberId },
            data: { active: false },
          }),
        restore: () =>
          prisma.member.update({
            where: { id: actors[0].memberId },
            data: { active: true },
          }),
      },
      {
        revoke: () =>
          prisma.device.update({
            where: { id: actors[0].deviceId },
            data: { authorized: false },
          }),
        restore: () =>
          prisma.device.update({
            where: { id: actors[0].deviceId },
            data: { authorized: true },
          }),
      },
      {
        revoke: () =>
          prisma.account.update({
            where: { id: actors[0].accountId },
            data: { active: false },
          }),
        restore: () =>
          prisma.account.update({
            where: { id: actors[0].accountId },
            data: { active: true },
          }),
      },
    ];
    for (const entry of cases) {
      await withTestTenant(contexts[0], entry.revoke);
      try {
        await expect(
          withTestTenant(contexts[0], () =>
            service.reverse(actor, dto.id, cancellation()),
          ),
        ).rejects.toMatchObject({ status: 403 });
        await withTestTenant(contexts[0], async () =>
          expect(
            await prisma.financeReserveReversal.count({
              where: { reserveId: dto.id },
            }),
          ).toBe(0),
        );
      } finally {
        await withTestTenant(contexts[0], entry.restore);
      }
    }
    await reverse(dto.id, cancellation()).expect(201);
  });
  it('enforces cancellation RLS and composite tenant audit references under raw writes', async () => {
    const dto = body();
    await post(dto).expect(201);
    const raw = new PrismaService();
    await raw.$connect();
    const data = {
      id: v7(),
      contextId: contexts[0],
      reserveId: dto.id,
      reason: 'Raw audit edge validation',
      occurredAt: new Date(),
      createdByMemberId: actors[0].memberId,
      createdByAccountId: actors[0].accountId,
      deviceId: actors[0].deviceId,
      requestFingerprint: randomUUID(),
      creationResponse: {},
    };
    try {
      await expect(
        raw.financeReserveReversal.create({ data }),
      ).rejects.toThrow();
      for (const change of [
        { createdByMemberId: actors[1].memberId },
        { createdByAccountId: actors[1].accountId },
        { deviceId: actors[1].deviceId },
      ]) {
        await expect(
          raw.$transaction(async (tx) => {
            await tx.$executeRaw`SELECT set_config('app.context_id', ${contexts[0]}, true)`;
            return tx.financeReserveReversal.create({
              data: { ...data, id: v7(), ...change },
            });
          }),
        ).rejects.toMatchObject({ code: 'P2003' });
      }
    } finally {
      await raw.$disconnect();
    }
    await withTestTenant(contexts[0], async () =>
      expect(
        await prisma.financeReserveReversal.count({
          where: { reserveId: dto.id },
        }),
      ).toBe(0),
    );
  });
});

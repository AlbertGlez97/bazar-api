import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { v7 } from 'uuid';
import request from 'supertest';
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
    deviceId: string;
    revokedDeviceId: string;
  }[] = [];
  const endpoint = '/api/v1/finance/reserves';
  const auth = (
    req: request.Test,
    index = 0,
    memberId?: string,
    deviceId?: string,
  ) =>
    req
      .auth(actors[index].token, { type: 'bearer' })
      .set('x-member-id', memberId ?? actors[index].memberId)
      .set('x-device-id', deviceId ?? actors[index].deviceId);
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
      const account = await prisma.account.create({
        data: {
          username: randomUUID(),
          passwordHash: 'not-a-login-fixture',
          contextId,
        },
      });
      const token = await app.get(JwtService).signAsync({ sub: account.id });
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
      actors.push({ accountId: account.id, token, ...fixture });
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
          await prisma.device.deleteMany({ where: { contextId } });
          await prisma.member.deleteMany({ where: { contextId } });
        });
        await prisma.account.deleteMany({ where: { contextId } });
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
  it('conflicts on changed content or account, without exposing foreign identities', async () => {
    const dto = body();
    await post(dto).expect(201);
    for (const change of [
      { amountMinor: 5001 },
      { name: 'Changed' },
      { periodTo: '2026-12-01' },
      { note: 'Changed' },
    ])
      await post({ ...dto, ...change }).expect(409);
    const second = await prisma.account.create({
      data: {
        username: randomUUID(),
        passwordHash: 'not-a-login-fixture',
        contextId: contexts[0],
      },
    });
    const token = await app.get(JwtService).signAsync({ sub: second.id });
    await request(app.getHttpServer())
      .post(endpoint)
      .auth(token, { type: 'bearer' })
      .set('x-member-id', actors[0].memberId)
      .set('x-device-id', actors[0].deviceId)
      .send(dto)
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
    for (const memberId of [
      actors[0].collaboratorId,
      actors[0].inactiveId,
      actors[1].memberId,
    ]) {
      await auth(request(app.getHttpServer()).post(endpoint), 0, memberId)
        .send(body({ createdByMemberId: memberId }))
        .expect(403);
      await auth(
        request(app.getHttpServer()).get(endpoint),
        0,
        memberId,
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
});

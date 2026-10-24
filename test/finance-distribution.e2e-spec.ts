import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { v7 } from 'uuid';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { withTestTenant } from './tenant-scope.js';

interface Actor {
  accountId: string;
  token: string;
  s1: string;
  s2: string;
  s3: string;
  collaborator: string;
  inactiveSocio: string;
  inactiveCollaborator: string;
  deviceId: string;
  revokedDeviceId: string;
  productId: string;
}
interface Period {
  from: string;
  to: string;
}
interface Row {
  memberId: string;
  name: string;
  role: string;
  isActive: boolean;
  partnerEligible: boolean;
  partnerAmountMinor: number;
  workUnits: number;
  shiftCount: number;
  knownMinutes: number;
  unknownDurationCount: number;
  workAmountMinor: number;
  totalMinor: number;
}

describe('finance distribution simulator HTTP', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const contexts = [`dist-${randomUUID()}`, `dist-other-${randomUUID()}`];
  const actors: Actor[] = [];
  const tokenByMember = new Map<string, string>();
  const endpoint = '/api/v1/finance/distribution-simulations';
  const worked = {
    requestedAmountMinor: 600000,
    partnerShareBps: 5000,
    workShareBps: 5000,
    workBasis: 'WORK_SHIFTS',
  };
  let dayCounter = 0;
  // Every test owns a distinct one-day period so fixtures never overlap.
  const nextPeriod = (): Period => {
    const day = (offset: number) =>
      new Date(Date.UTC(2031, 0, 1 + dayCounter + offset))
        .toISOString()
        .slice(0, 10);
    const period = { from: day(0), to: day(1) };
    dayCounter += 3;
    return period;
  };
  const instant = (date: string) => new Date(date + 'T06:00:00.000Z');
  const dateOnly = (date: string) => new Date(date + 'T00:00:00.000Z');
  const tenant = <T>(index: number, fn: () => Promise<T>) =>
    withTestTenant(contexts[index], fn);
  const post = (
    body: unknown,
    index = 0,
    memberId?: string,
    deviceId?: string,
  ) =>
    request(app.getHttpServer())
      .post(endpoint)
      .auth(tokenByMember.get(memberId ?? actors[index].s1)!, {
        type: 'bearer',
      })
      .set('x-device-id', deviceId ?? actors[index].deviceId)
      .send(body as object);
  const simulate = async (
    period: Period,
    rule: Record<string, unknown> = {},
    status = 200,
  ) => (await post({ ...period, ...worked, ...rule }).expect(status)).body;
  const byId = (rows: Row[]) =>
    Object.fromEntries(rows.map((row) => [row.memberId, row]));
  const sortedIds = (...ids: string[]) => [...ids].sort();

  const setPartners = (index: number, active: string[]) =>
    tenant(index, async () => {
      const actor = actors[index];
      for (const id of [actor.s2, actor.s3])
        await prisma.member.update({
          where: { id_contextId: { id, contextId: contexts[index] } },
          data: { active: active.includes(id) },
        });
    });
  const origin = (index: number) => ({
    contextId: contexts[index],
    createdByMemberId: actors[index].s1,
    createdByAccountId: actors[index].accountId,
    deviceId: actors[index].deviceId,
    requestFingerprint: randomUUID(),
    creationResponse: {},
  });
  const sale = (
    index: number,
    occurredAt: Date,
    totalMinor: number,
    unitCostMinor: number | null = 0,
    status: 'completada' | 'rechazada_por_conflicto' = 'completada',
  ) =>
    tenant(index, () =>
      prisma.sale.create({
        data: {
          id: v7(),
          contextId: contexts[index],
          memberId: actors[index].s1,
          deviceId: actors[index].deviceId,
          occurredAt,
          receivedAt: new Date('2032-01-01T00:00:00Z'),
          status,
          totalMinor,
          cashReceivedMinor: totalMinor,
          items: {
            create: [
              {
                quantity: 1,
                subtotalMinor: totalMinor,
                unitCostMinor,
                unitPriceMinor: totalMinor,
                productId: actors[index].productId,
                contextId: contexts[index],
              },
            ],
          },
        },
      }),
    );
  // Funds a period: a completed sale at its start instant with a known zero cost.
  const fund = (
    period: Period,
    amount: number,
    options: { index?: number; cost?: number | null } = {},
  ) =>
    sale(
      options.index ?? 0,
      instant(period.from),
      amount,
      options.cost === undefined ? 0 : options.cost,
    );
  const shift = (
    memberId: string,
    date: string,
    minutes: number | null,
    index = 0,
  ) =>
    tenant(index, () =>
      prisma.workShift.create({
        data: {
          ...origin(index),
          id: v7(),
          memberId,
          workDate: dateOnly(date),
          minutes,
          receivedAt: new Date('2032-01-01T00:00:00Z'),
        },
      }),
    );
  const expense = (
    period: Period,
    nature: 'OPERATING_EXPENSE' | 'INVENTORY_PURCHASE',
    amountMinor: number,
  ) =>
    tenant(0, () =>
      prisma.expense.create({
        data: {
          ...origin(0),
          id: v7(),
          nature,
          amountMinor,
          occurredAt: instant(period.from),
          receivedAt: new Date('2032-01-01T00:00:00Z'),
          category: nature === 'INVENTORY_PURCHASE' ? 'inventory' : 'transport',
          description: 'Distribution fixture',
          paidByMemberId: actors[0].s1,
          fundsSource: 'BUSINESS',
        },
      }),
    );
  const contribution = (period: Period, amountMinor: number) =>
    tenant(0, () =>
      prisma.contribution.create({
        data: {
          ...origin(0),
          id: v7(),
          memberId: actors[0].s1,
          amountMinor,
          occurredAt: instant(period.from),
          receivedAt: new Date('2032-01-01T00:00:00Z'),
        },
      }),
    );
  const reserve = (period: Period, amountMinor: number) =>
    tenant(0, () =>
      prisma.financeReserve.create({
        data: {
          ...origin(0),
          id: v7(),
          name: 'Distribution fixture reserve',
          amountMinor,
          periodFrom: dateOnly(period.from),
          periodTo: dateOnly(period.to),
          occurredAt: instant(period.from),
        },
      }),
    );
  const counts = () =>
    tenant(0, async () => ({
      workShifts: await prisma.workShift.count(),
      reserves: await prisma.financeReserve.count(),
      expenses: await prisma.expense.count(),
      contributions: await prisma.contribution.count(),
      sales: await prisma.sale.count(),
      members: await prisma.member.count(),
      reversals: await prisma.workShiftReversal.count(),
    }));

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
        const member = async (
          name: string,
          role: 'socio' | 'colaborador',
          active = true,
        ) =>
          (
            await prisma.member.create({
              data: { contextId, name, role, active },
            })
          ).id;
        const s1 = await member('Socio One', 'socio');
        // S2 and S3 start inactive; tests switch them on to build the partner set.
        const s2 = await member('Socio Two', 'socio', false);
        const s3 = await member('Socio Three', 'socio', false);
        const collaborator = await member('Colaborador', 'colaborador');
        const inactiveSocio = await member('Inactive Socio', 'socio', false);
        const inactiveCollaborator = await member(
          'Inactive Colaborador',
          'colaborador',
          false,
        );
        const deviceId = (
          await prisma.device.create({
            data: { contextId, name: 'Tablet', authorized: true },
          })
        ).id;
        const revokedDeviceId = (
          await prisma.device.create({
            data: { contextId, name: 'Revoked', authorized: false },
          })
        ).id;
        const productId = (
          await prisma.product.create({
            data: {
              contextId,
              name: 'Distribution product',
              tipo: 'cantidad',
              unitPriceMinor: 100,
              initialStock: 100,
              stock: 100,
              purchaseCostMinor: 9999,
            },
          })
        ).id;
        return {
          s1,
          s2,
          s3,
          collaborator,
          inactiveSocio,
          inactiveCollaborator,
          deviceId,
          revokedDeviceId,
          productId,
        };
      });
      // One account (and token) per person: the token decides who acts.
      const accountIds: Record<string, string> = {};
      for (const memberId of [
        fixture.s1,
        fixture.collaborator,
        fixture.inactiveSocio,
      ]) {
        const account = await prisma.account.create({
          data: {
            username: randomUUID(),
            passwordHash: 'not-a-login-fixture',
            contextId,
            memberId,
          },
        });
        accountIds[memberId] = account.id;
        tokenByMember.set(
          memberId,
          await app.get(JwtService).signAsync({ sub: account.id }),
        );
      }
      actors.push({
        accountId: accountIds[fixture.s1],
        token: tokenByMember.get(fixture.s1)!,
        ...fixture,
      });
    }
  });
  afterAll(async () => {
    if (prisma)
      for (const contextId of contexts) {
        await withTestTenant(contextId, async () => {
          await prisma.workShiftReversal.deleteMany({ where: { contextId } });
          await prisma.financeReserveReversal.deleteMany({
            where: { contextId },
          });
          await prisma.financeReserve.deleteMany({ where: { contextId } });
          await prisma.expenseReversal.deleteMany({ where: { contextId } });
          await prisma.contributionReversal.deleteMany({
            where: { contextId },
          });
          await prisma.workShift.deleteMany({ where: { contextId } });
          await prisma.expense.deleteMany({ where: { contextId } });
          await prisma.contribution.deleteMany({ where: { contextId } });
          await prisma.saleItem.deleteMany({ where: { contextId } });
          await prisma.sale.deleteMany({ where: { contextId } });
          await prisma.product.deleteMany({ where: { contextId } });
          await prisma.device.deleteMany({ where: { contextId } });
        });
        // Accounts before Members (Account.memberId is ON DELETE RESTRICT)
        // but after the rows that reference them.
        await prisma.account.deleteMany({ where: { contextId } });
        await withTestTenant(contextId, () =>
          prisma.member.deleteMany({ where: { contextId } }),
        );
      }
    await app?.close();
  });
  beforeEach(() => setPartners(0, []));

  describe('request validation', () => {
    const period = { from: '2031-06-01', to: '2031-06-02' };
    it.each([
      ['unknown property memberIds', { memberIds: [randomUUID()] }],
      ['unknown property contextId', { contextId: 'other' }],
      ['bps sum below 10000', { workShareBps: 4999 }],
      ['bps sum above 10000', { partnerShareBps: 5001 }],
      ['negative share', { partnerShareBps: -1, workShareBps: 10001 }],
      ['zero amount', { requestedAmountMinor: 0 }],
      ['negative amount', { requestedAmountMinor: -1 }],
      ['float amount', { requestedAmountMinor: 100.5 }],
      ['string amount', { requestedAmountMinor: '600000' }],
      ['amount above the minor-unit limit', { requestedAmountMinor: 2 ** 31 }],
      ['string bps', { partnerShareBps: '5000' }],
      ['float bps', { partnerShareBps: 4999.5, workShareBps: 5000.5 }],
      ['unknown basis', { workBasis: 'HOURS' }],
      ['missing basis', { workBasis: undefined }],
      ['from after to', { from: period.to, to: period.from }],
      ['equal dates', { to: period.from }],
      ['impossible date', { from: '2031-02-30' }],
      ['timestamp date', { from: '2031-06-01T00:00:00Z' }],
      ['missing from', { from: undefined }],
    ])('rejects %s with 400', async (_name, patch) => {
      await post({ ...period, ...worked, ...patch }).expect(400);
    });
  });

  describe('permissions', () => {
    it('denies anonymous, collaborator, inactive, foreign and unauthorized-device callers', async () => {
      const period = nextPeriod();
      await request(app.getHttpServer())
        .post(endpoint)
        .send({ ...period, ...worked })
        .expect(401);
      for (const memberId of [
        actors[0].collaborator,
        actors[0].inactiveSocio,
        actors[1].s1,
      ])
        await post({ ...period, ...worked }, 0, memberId).expect(403);
      await post(
        { ...period, ...worked },
        0,
        undefined,
        actors[0].revokedDeviceId,
      ).expect(403);
      await post(
        { ...period, ...worked },
        0,
        undefined,
        actors[1].deviceId,
      ).expect(403);
      await request(app.getHttpServer())
        .post(endpoint)
        .auth(actors[0].token, { type: 'bearer' })
        .send({ ...period, ...worked })
        .expect(403);
    });
  });

  describe('worked example and formula', () => {
    it('matches the documented example: 600000, 50/50, shifts 2 and 3', async () => {
      const period = nextPeriod();
      await setPartners(0, [actors[0].s2]);
      await fund(period, 1_000_000);
      await shift(actors[0].s1, period.from, null);
      await shift(actors[0].s1, period.from, 30);
      for (let i = 0; i < 3; i++) await shift(actors[0].s2, period.from, 45);
      const body = await simulate(period);
      expect(body.simulationFingerprint).toMatch(/^sim1:[0-9a-f]{64}$/);
      expect((await simulate(period)).simulationFingerprint).toBe(
        body.simulationFingerprint,
      );
      expect(body).toMatchObject({
        simulation: true,
        persisted: false,
        currency: 'MXN',
        rule: {
          partnerShareBps: 5000,
          workShareBps: 5000,
          workBasis: 'WORK_SHIFTS',
          partnerMode: 'EQUAL',
        },
        pools: { partnerPoolMinor: 300000, workPoolMinor: 300000 },
        financialBase: {
          potentiallyAvailableMinor: 1_000_000,
          requestedAmountMinor: 600000,
          remainingAvailableMinor: 400000,
          status: 'complete',
        },
        totals: { distributedMinor: 600000, undistributedMinor: 0 },
        period: {
          ...period,
          fromInstant: `${period.from}T06:00:00.000Z`,
          toInstant: `${period.to}T06:00:00.000Z`,
          utcOffsetMinutes: -360,
          interval: '[from,to)',
        },
      });
      const rows = byId(body.members);
      expect(body.members.map((r: Row) => r.memberId)).toEqual(
        sortedIds(actors[0].s1, actors[0].s2),
      );
      expect(rows[actors[0].s1]).toMatchObject({
        partnerAmountMinor: 150000,
        workAmountMinor: 120000,
        totalMinor: 270000,
        shiftCount: 2,
        workUnits: 2,
        partnerEligible: true,
      });
      expect(rows[actors[0].s2]).toMatchObject({
        partnerAmountMinor: 150000,
        workAmountMinor: 180000,
        totalMinor: 330000,
        workUnits: 3,
      });
      expect(body.warnings.map((w: { code: string }) => w.code)).toEqual([
        'SIMULATION_ONLY',
        'NOT_A_PAYMENT_OR_OBLIGATION',
        'PARTNER_ELIGIBILITY_IS_CURRENT_STATE',
      ]);
    });

    it.each([
      [7000, 3000, 700000, 300000],
      [10000, 0, 1000000, 0],
      [0, 10000, 0, 1000000],
    ])('splits %s/%s into the pools', async (p, w, partnerPool, workPool) => {
      const period = nextPeriod();
      await fund(period, 2_000_000);
      await shift(actors[0].collaborator, period.from, 10);
      const body = await simulate(period, {
        requestedAmountMinor: 1_000_000,
        partnerShareBps: p,
        workShareBps: w,
      });
      expect(body.pools).toEqual({
        partnerPoolMinor: partnerPool,
        workPoolMinor: workPool,
      });
      expect(body.totals.distributedMinor).toBe(1_000_000);
    });

    it('does not need work for 100/0 and does not need partners for 0/100', async () => {
      const period = nextPeriod();
      await fund(period, 1000);
      const partnersOnly = await simulate(period, {
        requestedAmountMinor: 1000,
        partnerShareBps: 10000,
        workShareBps: 0,
      });
      expect(partnersOnly.members).toHaveLength(1);
      expect(partnersOnly.members[0]).toMatchObject({
        memberId: actors[0].s1,
        partnerAmountMinor: 1000,
        workAmountMinor: 0,
      });
      await shift(actors[0].collaborator, period.from, 5);
      const workOnly = await simulate(period, {
        requestedAmountMinor: 1000,
        partnerShareBps: 0,
        workShareBps: 10000,
      });
      // The caller socio is still listed as a partner but receives nothing.
      expect(byId(workOnly.members)[actors[0].collaborator]).toMatchObject({
        workAmountMinor: 1000,
        partnerAmountMinor: 0,
      });
      expect(byId(workOnly.members)[actors[0].s1].totalMinor).toBe(0);
    });
  });

  describe('limits', () => {
    it('allows exactly the available amount and rejects one more', async () => {
      const period = nextPeriod();
      await fund(period, 5000);
      const exact = await simulate(period, {
        requestedAmountMinor: 5000,
        partnerShareBps: 10000,
        workShareBps: 0,
      });
      expect(exact.financialBase.remainingAvailableMinor).toBe(0);
      const rejected = await simulate(
        period,
        {
          requestedAmountMinor: 5001,
          partnerShareBps: 10000,
          workShareBps: 0,
        },
        422,
      );
      expect(rejected.code).toBe('FINANCE_DISTRIBUTION_EXCEEDS_AVAILABLE');
    });
    it('rejects any request when the available amount is zero or negative', async () => {
      const empty = nextPeriod();
      const none = await simulate(empty, { requestedAmountMinor: 1 }, 422);
      expect(none.code).toBe('FINANCE_DISTRIBUTION_EXCEEDS_AVAILABLE');
      const loss = nextPeriod();
      await fund(loss, 100);
      await expense(loss, 'OPERATING_EXPENSE', 500);
      const negative = await simulate(loss, { requestedAmountMinor: 1 }, 422);
      expect(negative.code).toBe('FINANCE_DISTRIBUTION_EXCEEDS_AVAILABLE');
    });
  });
  describe('partners', () => {
    it.each([1, 2, 3])(
      'splits the partner pool equally among %s active socios',
      async (count) => {
        const period = nextPeriod();
        const a = actors[0];
        await setPartners(0, [a.s2, a.s3].slice(0, count - 1));
        await fund(period, 90_000);
        const body = await simulate(period, {
          requestedAmountMinor: 90_000,
          partnerShareBps: 10000,
          workShareBps: 0,
        });
        expect(body.members).toHaveLength(count);
        expect(body.members.map((row: Row) => row.partnerAmountMinor)).toEqual(
          Array(count).fill(90_000 / count),
        );
        expect(body.totals.distributedMinor).toBe(90_000);
      },
    );
    it('rounds $100.00 over 3 socios to 33.34/33.33/33.33 by member id order', async () => {
      const period = nextPeriod();
      const a = actors[0];
      await setPartners(0, [a.s2, a.s3]);
      await fund(period, 10_000);
      const body = await simulate(period, {
        requestedAmountMinor: 10_000,
        partnerShareBps: 10000,
        workShareBps: 0,
      });
      expect(body.members.map((r: Row) => r.memberId)).toEqual(
        sortedIds(a.s1, a.s2, a.s3),
      );
      expect(body.members.map((r: Row) => r.partnerAmountMinor)).toEqual([
        3334, 3333, 3333,
      ]);
    });
    it('pays a partner without work, excludes inactive socios and never pays colaboradores', async () => {
      const period = nextPeriod();
      const a = actors[0];
      await setPartners(0, [a.s2]);
      await fund(period, 1_000_000);
      await shift(a.s1, period.from, 60);
      await shift(a.collaborator, period.from, 60);
      const body = await simulate(period, { requestedAmountMinor: 800_000 });
      const rows = byId(body.members);
      expect(Object.keys(rows).sort()).toEqual(
        sortedIds(a.s1, a.s2, a.collaborator),
      );
      expect(rows[a.s2]).toMatchObject({
        partnerAmountMinor: 200_000,
        workAmountMinor: 0,
        shiftCount: 0,
        partnerEligible: true,
      });
      expect(rows[a.collaborator]).toMatchObject({
        partnerAmountMinor: 0,
        partnerEligible: false,
        role: 'colaborador',
        workAmountMinor: 200_000,
      });
      expect(rows[a.s1]).toMatchObject({
        partnerAmountMinor: 200_000,
        workAmountMinor: 200_000,
      });
      expect(rows[a.s3]).toBeUndefined();
      expect(rows[a.inactiveSocio]).toBeUndefined();
    });
  });

  describe('work component', () => {
    it('weighs by shift count or by known minutes and never mixes the bases', async () => {
      const period = nextPeriod();
      const a = actors[0];
      await fund(period, 1_000_000);
      await shift(a.s1, period.from, 10);
      await shift(a.collaborator, period.from, 30);
      await shift(a.collaborator, period.from, 30);
      const shifts = await simulate(period, {
        requestedAmountMinor: 900_000,
        partnerShareBps: 0,
        workShareBps: 10000,
      });
      expect(byId(shifts.members)[a.s1]).toMatchObject({
        workUnits: 1,
        workAmountMinor: 300_000,
      });
      expect(byId(shifts.members)[a.collaborator]).toMatchObject({
        workUnits: 2,
        workAmountMinor: 600_000,
        knownMinutes: 60,
      });
      const minutes = await simulate(period, {
        requestedAmountMinor: 700_000,
        partnerShareBps: 0,
        workShareBps: 10000,
        workBasis: 'KNOWN_MINUTES',
      });
      expect(byId(minutes.members)[a.s1]).toMatchObject({
        workUnits: 10,
        workAmountMinor: 100_000,
      });
      expect(byId(minutes.members)[a.collaborator]).toMatchObject({
        workUnits: 60,
        workAmountMinor: 600_000,
      });
    });
    it('counts a shift without duration as 1 by shifts and 0 with a warning by minutes', async () => {
      const period = nextPeriod();
      const a = actors[0];
      await fund(period, 100_000);
      await shift(a.s1, period.from, null);
      await shift(a.collaborator, period.from, 30);
      const rule = { partnerShareBps: 0, workShareBps: 10000 };
      const shifts = await simulate(period, {
        ...rule,
        requestedAmountMinor: 100_000,
      });
      expect(byId(shifts.members)[a.s1].workAmountMinor).toBe(50_000);
      expect(
        shifts.warnings.map((w: { code: string }) => w.code),
      ).not.toContain('WORK_SHIFTS_WITHOUT_DURATION');
      const minutes = await simulate(period, {
        ...rule,
        requestedAmountMinor: 100_000,
        workBasis: 'KNOWN_MINUTES',
      });
      expect(byId(minutes.members)[a.s1]).toMatchObject({
        workUnits: 0,
        workAmountMinor: 0,
        shiftCount: 1,
        unknownDurationCount: 1,
      });
      expect(byId(minutes.members)[a.collaborator].workAmountMinor).toBe(
        100_000,
      );
      const warning = minutes.warnings.find(
        (w: { code: string }) => w.code === 'WORK_SHIFTS_WITHOUT_DURATION',
      );
      expect(warning.message).toContain('1 work shift(s)');
    });
    it('answers 422 NO_WORK without shifts and when no shift has a known duration', async () => {
      const period = nextPeriod();
      await fund(period, 10_000);
      const none = await simulate(
        period,
        { requestedAmountMinor: 10_000 },
        422,
      );
      expect(none).toMatchObject({ code: 'FINANCE_DISTRIBUTION_NO_WORK' });
      expect(none.message).toContain('No active work shifts');
      await shift(actors[0].s1, period.from, null);
      const unknown = await simulate(
        period,
        { requestedAmountMinor: 10_000, workBasis: 'KNOWN_MINUTES' },
        422,
      );
      expect(unknown.code).toBe('FINANCE_DISTRIBUTION_NO_WORK');
      expect(unknown.message).toContain('lack a known duration');
      // The same shift is real work by shift count.
      await simulate(period, { requestedAmountMinor: 10_000 });
    });
    it('pays working colaboradores a work amount only, and inactive workers with a warning', async () => {
      const period = nextPeriod();
      const a = actors[0];
      await fund(period, 100_000);
      await shift(a.collaborator, period.from, 30);
      await shift(a.inactiveCollaborator, period.from, 30);
      await shift(a.inactiveSocio, period.from, 30);
      const body = await simulate(period, { requestedAmountMinor: 100_000 });
      const rows = byId(body.members);
      expect(rows[a.s1]).toMatchObject({ partnerAmountMinor: 50_000 });
      for (const id of [
        a.collaborator,
        a.inactiveCollaborator,
        a.inactiveSocio,
      ]) {
        expect(rows[id]).toMatchObject({
          partnerAmountMinor: 0,
          partnerEligible: false,
        });
        expect([16_666, 16_667]).toContain(rows[id].workAmountMinor);
      }
      expect(rows[a.inactiveCollaborator].isActive).toBe(false);
      expect(body.warnings.map((w: { code: string }) => w.code)).toContain(
        'INACTIVE_MEMBER_RECEIVES_WORK_AMOUNT',
      );
      expect(body.totals.distributedMinor).toBe(100_000);
    });
    it('excludes reversed shifts and counts the replacement on its own', async () => {
      const period = nextPeriod();
      const a = actors[0];
      await fund(period, 100_000);
      const original = await shift(a.collaborator, period.from, 10);
      const replacement = await shift(a.collaborator, period.from, 90);
      await shift(a.s1, period.from, 100);
      const reversed = await shift(a.s1, period.from, 5000);
      await tenant(0, async () => {
        await prisma.workShiftReversal.create({
          data: {
            ...origin(0),
            id: v7(),
            workShiftId: original.id,
            replacementWorkShiftId: replacement.id,
            reason: 'Correction',
            occurredAt: new Date(),
          },
        });
        await prisma.workShiftReversal.create({
          data: {
            ...origin(0),
            id: v7(),
            workShiftId: reversed.id,
            reason: 'Mistake',
            occurredAt: new Date(),
          },
        });
      });
      // Replacement shifts are active; reversed originals are not.
      const body = await simulate(period, {
        requestedAmountMinor: 100_000,
        partnerShareBps: 0,
        workShareBps: 10000,
        workBasis: 'KNOWN_MINUTES',
      });
      const rows = byId(body.members);
      expect(rows[a.collaborator]).toMatchObject({
        shiftCount: 1,
        knownMinutes: 90,
      });
      expect(rows[a.s1]).toMatchObject({ shiftCount: 1, knownMinutes: 100 });
      expect(rows[a.collaborator].workAmountMinor).toBe(47_368);
      expect(rows[a.s1].workAmountMinor).toBe(52_632);
    });
  });

  describe('rounding', () => {
    it('allocates odd pools exactly, favors the work pool by one cent and is deterministic', async () => {
      const period = nextPeriod();
      const a = actors[0];
      await setPartners(0, [a.s2, a.s3]);
      await fund(period, 1_000_000);
      for (const [member, count] of [
        [a.s1, 1],
        [a.s2, 1],
        [a.collaborator, 1],
      ] as const)
        for (let i = 0; i < count; i++) await shift(member, period.from, 7);
      const rule = { requestedAmountMinor: 100_001 };
      const first = await simulate(period, rule);
      expect(first.pools).toEqual({
        partnerPoolMinor: 50_000,
        workPoolMinor: 50_001,
      });
      expect(first.totals).toEqual({
        distributedMinor: 100_001,
        undistributedMinor: 0,
      });
      const partner = first.members
        .map((r: Row) => r.partnerAmountMinor)
        .filter((n: number) => n > 0);
      expect(partner.reduce((s: number, n: number) => s + n, 0)).toBe(50_000);
      expect(Math.max(...partner) - Math.min(...partner)).toBeLessThanOrEqual(
        1,
      );
      for (let i = 0; i < 3; i++)
        expect(await simulate(period, rule)).toEqual(first);
    });
  });

  describe('financial base', () => {
    it('mirrors a partial cost base, warns and still computes', async () => {
      const period = nextPeriod();
      await fund(period, 50_000, { cost: null });
      const body = await simulate(period, {
        requestedAmountMinor: 10_000,
        partnerShareBps: 10000,
        workShareBps: 0,
      });
      expect(body.financialBase.status).toBe('partial');
      expect(body.warnings.map((w: { code: string }) => w.code)).toEqual([
        'SIMULATION_ONLY',
        'NOT_A_PAYMENT_OR_OBLIGATION',
        'OPERATING_RESULT_PARTIAL',
        'MISSING_SALE_COST',
        'PARTNER_ELIGIBILITY_IS_CURRENT_STATE',
      ]);
    });
    it('propagates actual overview cost overflow as HTTP 422', async () => {
      const period = nextPeriod();
      const created = await sale(0, instant(period.from), 100_000);
      // Test-only legacy snapshot: each Int fits PostgreSQL, but their BigInt product exceeds safe money.
      await tenant(0, () =>
        prisma.saleItem.updateMany({
          where: { saleId: created.id, contextId: contexts[0] },
          data: { quantity: 2_147_483_647, unitCostMinor: 2_147_483_647 },
        }),
      );
      const body = await simulate(
        period,
        { requestedAmountMinor: 1, partnerShareBps: 10000, workShareBps: 0 },
        422,
      );
      expect(body.code).toBe('FINANCE_OVERVIEW_OVERFLOW');
    });
    it('uses the overview base: reserves of the exact period are deducted once, other periods ignored', async () => {
      const period = nextPeriod();
      const other = nextPeriod();
      await fund(period, 100_000);
      await reserve(period, 30_000);
      await reserve(other, 90_000);
      const rule = { partnerShareBps: 10000, workShareBps: 0 };
      const ok = await simulate(period, {
        ...rule,
        requestedAmountMinor: 70_000,
      });
      expect(ok.financialBase).toMatchObject({
        potentiallyAvailableMinor: 70_000,
        remainingAvailableMinor: 0,
      });
      const overview = await request(app.getHttpServer())
        .get('/api/v1/finance/overview')
        .auth(actors[0].token, { type: 'bearer' })
        .set('x-device-id', actors[0].deviceId)
        .query(period)
        .expect(200);
      expect(overview.body.result.potentiallyAvailableMinor).toBe(70_000);
      await simulate(period, { ...rule, requestedAmountMinor: 70_001 }, 422);
    });
    it('does not subtract inventory purchases again and ignores contributions', async () => {
      const period = nextPeriod();
      await fund(period, 100_000);
      await expense(period, 'OPERATING_EXPENSE', 10_000);
      await expense(period, 'INVENTORY_PURCHASE', 50_000);
      await contribution(period, 500_000);
      const body = await simulate(period, {
        requestedAmountMinor: 90_000,
        partnerShareBps: 10000,
        workShareBps: 0,
      });
      expect(body.financialBase.potentiallyAvailableMinor).toBe(90_000);
      await simulate(
        period,
        {
          requestedAmountMinor: 90_001,
          partnerShareBps: 10000,
          workShareBps: 0,
        },
        422,
      );
    });
  });

  describe('period boundaries', () => {
    it('applies [from,to) to work dates', async () => {
      const period = nextPeriod();
      const a = actors[0];
      const before = new Date(dateOnly(period.from).getTime() - 86_400_000)
        .toISOString()
        .slice(0, 10);
      await fund(period, 10_000);
      await shift(a.s1, before, 10);
      await shift(a.s1, period.from, 10);
      await shift(a.collaborator, period.to, 10);
      const body = await simulate(period, {
        requestedAmountMinor: 10_000,
        partnerShareBps: 0,
        workShareBps: 10000,
      });
      expect(byId(body.members)[a.s1]).toMatchObject({ shiftCount: 1 });
      expect(byId(body.members)[a.collaborator]).toBeUndefined();
    });
    it('applies [fromInstant,toInstant) at the UTC-06 boundary to sales', async () => {
      const period = nextPeriod();
      const from = instant(period.from).getTime();
      const to = instant(period.to).getTime();
      await sale(0, new Date(from - 1), 1_000_000);
      await sale(0, new Date(from), 1);
      await sale(0, new Date(to - 1), 10);
      await sale(0, new Date(to), 100_000);
      await sale(
        0,
        new Date(from + 1000),
        100_000,
        0,
        'rechazada_por_conflicto',
      );
      const body = await simulate(period, {
        requestedAmountMinor: 11,
        partnerShareBps: 10000,
        workShareBps: 0,
      });
      expect(body.financialBase.potentiallyAvailableMinor).toBe(11);
    });
  });

  describe('tenancy and purity', () => {
    it('never leaks another context: members, shifts, sales, reserves', async () => {
      const period = nextPeriod();
      const other = actors[1];
      await fund(period, 100_000);
      await fund(period, 9_000_000, { index: 1 });
      await shift(actors[0].s1, period.from, 10);
      await shift(other.s1, period.from, 10, 1);
      await shift(other.collaborator, period.from, 10, 1);
      const body = await simulate(period, { requestedAmountMinor: 100_000 });
      expect(body.financialBase.potentiallyAvailableMinor).toBe(100_000);
      expect(body.members.map((r: Row) => r.memberId)).toEqual([actors[0].s1]);
      expect(JSON.stringify(body)).not.toContain(other.s1);
      await simulate(period, { requestedAmountMinor: 100_001 }, 422);
      const mine = await post(
        { ...period, ...worked, requestedAmountMinor: 100_000 },
        1,
      ).expect(200);
      expect(mine.body.members.map((r: Row) => r.memberId)).toEqual(
        sortedIds(other.s1, other.collaborator),
      );
      expect(mine.body.financialBase.potentiallyAvailableMinor).toBe(9_000_000);
    });
    it('writes nothing and creates no tables', async () => {
      const period = nextPeriod();
      const a = actors[0];
      await setPartners(0, [a.s2]);
      await fund(period, 100_000);
      await shift(a.s1, period.from, 10);
      const tables = () =>
        prisma.$queryRaw<{ n: bigint }[]>`
          SELECT count(*)::bigint AS n FROM information_schema.tables
          WHERE table_schema = 'public'`;
      const before = { rows: await counts(), tables: await tables() };
      for (let i = 0; i < 3; i++)
        await simulate(period, { requestedAmountMinor: 50_000 });
      await simulate(period, { requestedAmountMinor: 100_001 }, 422);
      expect({ rows: await counts(), tables: await tables() }).toEqual(before);
    });
  });
});

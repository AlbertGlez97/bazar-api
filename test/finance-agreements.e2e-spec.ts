import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { v7 } from 'uuid';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { currentBusinessDate } from '../src/common/business-time.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { verifyAgreementDocument } from '../src/finance/finance-agreements.snapshot.js';
import { purgeAgreementData } from './agreement-cleanup.js';
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
interface Rule {
  requestedAmountMinor: number;
  partnerShareBps: number;
  workShareBps: number;
  workBasis: string;
}
interface Scenario {
  period: Period;
  rule: Rule;
  sim: { simulationFingerprint: string; members: Participant[] };
}
interface Participant {
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

describe('finance distribution agreements HTTP', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const contexts = [`agr-${randomUUID()}`, `agr-other-${randomUUID()}`];
  const actors: Actor[] = [];
  let secondAccount: { id: string; token: string };
  const base = '/api/v1/finance';
  const endpoint = `${base}/distribution-agreements`;
  const worked: Rule = {
    requestedAmountMinor: 600000,
    partnerShareBps: 5000,
    workShareBps: 5000,
    workBasis: 'WORK_SHIFTS',
  };
  const year = Number(currentBusinessDate(new Date()).slice(0, 4));
  const folio = (n: number) => `AC-${year}-${String(n).padStart(5, '0')}`;
  let dayCounter = 0;
  // Every scenario owns a distinct one-day period so fixtures never overlap.
  const nextPeriod = (): Period => {
    const day = (offset: number) =>
      new Date(Date.UTC(2033, 0, 1 + dayCounter + offset))
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
  const auth = (
    req: request.Test,
    index = 0,
    memberId?: string,
    deviceId?: string,
    token?: string,
  ) =>
    req
      .auth(token ?? actors[index].token, { type: 'bearer' })
      .set('x-member-id', memberId ?? actors[index].s1)
      .set('x-device-id', deviceId ?? actors[index].deviceId);
  const http = () => request(app.getHttpServer());
  const post = (path: string, body: unknown, index = 0) =>
    auth(http().post(path), index).send(body as object);
  const get = (path: string, query: Record<string, unknown> = {}, index = 0) =>
    auth(http().get(path), index).query(query);

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
  const fund = (period: Period, amount: number, index = 0) =>
    tenant(index, () =>
      prisma.sale.create({
        data: {
          id: v7(),
          contextId: contexts[index],
          memberId: actors[index].s1,
          deviceId: actors[index].deviceId,
          occurredAt: instant(period.from),
          receivedAt: new Date('2034-01-01T00:00:00Z'),
          status: 'completada',
          totalMinor: amount,
          cashReceivedMinor: amount,
          items: {
            create: [
              {
                quantity: 1,
                subtotalMinor: amount,
                unitCostMinor: 0,
                unitPriceMinor: amount,
                productId: actors[index].productId,
                contextId: contexts[index],
              },
            ],
          },
        },
      }),
    );
  const shift = (
    memberId: string,
    date: string,
    minutes: number | null = null,
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
          receivedAt: new Date('2034-01-01T00:00:00Z'),
        },
      }),
    );
  const reserve = (period: Period, amountMinor: number, index = 0) =>
    tenant(index, () =>
      prisma.financeReserve.create({
        data: {
          ...origin(index),
          id: v7(),
          name: 'Agreement fixture reserve',
          amountMinor,
          periodFrom: dateOnly(period.from),
          periodTo: dateOnly(period.to),
          occurredAt: instant(period.from),
        },
      }),
    );
  const simulate = async (
    period: Period,
    rule: Rule = worked,
    index = 0,
    status = 200,
  ) =>
    (
      await post(
        `${base}/distribution-simulations`,
        { ...period, ...rule },
        index,
      ).expect(status)
    ).body;
  // Funds a period, registers work and returns the simulation a socio would accept.
  const scenario = async (
    options: {
      index?: number;
      partners?: string[];
      rule?: Rule;
      s1Shifts?: number;
      s2Shifts?: number;
      funding?: number;
    } = {},
  ): Promise<Scenario> => {
    const index = options.index ?? 0;
    const actor = actors[index];
    const period = nextPeriod();
    await setPartners(index, options.partners ?? [actor.s2]);
    await fund(period, options.funding ?? 1_000_000, index);
    for (let i = 0; i < (options.s1Shifts ?? 2); i++)
      await shift(actor.s1, period.from, null, index);
    for (let i = 0; i < (options.s2Shifts ?? 3); i++)
      await shift(actor.s2, period.from, null, index);
    const rule = options.rule ?? worked;
    return { period, rule, sim: await simulate(period, rule, index) };
  };
  const body = (
    sc: Scenario,
    overrides: Record<string, unknown> = {},
    index = 0,
  ) => ({
    id: v7(),
    ...sc.period,
    ...sc.rule,
    title: 'Reparto de octubre',
    simulationFingerprint: sc.sim.simulationFingerprint,
    occurredAt: '2026-10-09T12:00:00-06:00',
    createdByMemberId: actors[index].s1,
    deviceId: actors[index].deviceId,
    ...overrides,
  });
  const create = (
    sc: Scenario,
    overrides: Record<string, unknown> = {},
    index = 0,
  ) => post(endpoint, body(sc, overrides, index), index);
  const reversalBody = (
    overrides: Record<string, unknown> = {},
    index = 0,
  ) => ({
    id: v7(),
    reason: 'Captured with a wrong period',
    occurredAt: '2026-10-09T13:00:00-06:00',
    createdByMemberId: actors[index].s1,
    deviceId: actors[index].deviceId,
    ...overrides,
  });
  const reverse = (
    agreementId: string,
    overrides: Record<string, unknown> = {},
    index = 0,
  ) =>
    post(
      `${endpoint}/${agreementId}/reversals`,
      reversalBody(overrides, index),
      index,
    );
  const counts = (index = 0) =>
    tenant(index, async () => ({
      agreements: await prisma.distributionAgreement.count(),
      participants: await prisma.distributionAgreementParticipant.count(),
      reversals: await prisma.distributionAgreementReversal.count(),
      counters: await prisma.distributionAgreementCounter.findMany(),
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
      const account = await prisma.account.create({
        data: {
          username: randomUUID(),
          passwordHash: 'not-a-login-fixture',
          contextId,
        },
      });
      const token = await app.get(JwtService).signAsync({ sub: account.id });
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
              name: 'Agreement product',
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
      actors.push({ accountId: account.id, token, ...fixture });
    }
    const other = await prisma.account.create({
      data: {
        username: randomUUID(),
        passwordHash: 'not-a-login-fixture',
        contextId: contexts[0],
      },
    });
    secondAccount = {
      id: other.id,
      token: await app.get(JwtService).signAsync({ sub: other.id }),
    };
  });
  afterAll(async () => {
    // Agreement tables reject DELETE for the runtime role: purge as owner first.
    await purgeAgreementData(contexts);
    if (prisma)
      for (const contextId of contexts) {
        await withTestTenant(contextId, async () => {
          await prisma.financeReserve.deleteMany({ where: { contextId } });
          await prisma.workShift.deleteMany({ where: { contextId } });
          await prisma.saleItem.deleteMany({ where: { contextId } });
          await prisma.sale.deleteMany({ where: { contextId } });
          await prisma.product.deleteMany({ where: { contextId } });
          await prisma.device.deleteMany({ where: { contextId } });
          await prisma.member.deleteMany({ where: { contextId } });
        });
        await prisma.account.deleteMany({ where: { contextId } });
      }
    await app?.close();
  });
  beforeEach(() => setPartners(0, []));

  describe('creation from a simulation', () => {
    it('freezes the worked example and numbers folios per context from 00001', async () => {
      const sc = await scenario();
      const dto = body(sc, { title: '  Reparto de octubre  ', note: ' nota ' });
      const res = await post(endpoint, dto).expect(201);
      const a = actors[0];
      expect(res.body).toMatchObject({
        id: dto.id,
        contextId: contexts[0],
        folio: folio(1),
        status: 'active',
        title: 'Reparto de octubre',
        note: 'nota',
        replacesAgreementId: null,
        replacesAgreement: null,
        reversal: null,
        replacedBy: null,
        generatedFrom: 'DISTRIBUTION_SIMULATOR',
        algorithmVersion: 1,
        notice:
          'Documento generado a partir de una simulación aceptada por los participantes. No es un contrato legal ni registra pagos.',
        currency: 'MXN',
        occurredAt: '2026-10-09T18:00:00.000Z',
        period: { ...sc.period, utcOffsetMinutes: -360, interval: '[from,to)' },
        financialBase: {
          potentiallyAvailableMinor: 1_000_000,
          requestedAmountMinor: 600000,
          remainingAvailableMinor: 400000,
          status: 'complete',
        },
        rule: {
          partnerShareBps: 5000,
          workShareBps: 5000,
          workBasis: 'WORK_SHIFTS',
          partnerMode: 'EQUAL',
        },
        pools: { partnerPoolMinor: 300000, workPoolMinor: 300000 },
        totals: { distributedMinor: 600000, undistributedMinor: 0 },
        simulationFingerprint: sc.sim.simulationFingerprint,
        createdBy: {
          memberId: a.s1,
          name: 'Socio One',
          accountId: a.accountId,
          deviceId: a.deviceId,
        },
      });
      expect(res.body.receivedAt).toMatch(/Z$/);
      expect(res.body.snapshotFingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(
        res.body.participants.map((p: Participant) => [
          p.memberId,
          p.partnerAmountMinor,
          p.workAmountMinor,
          p.totalMinor,
        ]),
      ).toEqual(
        [
          [a.s1, 150000, 120000, 270000],
          [a.s2, 150000, 180000, 330000],
        ].sort((x, y) => (String(x[0]) < String(y[0]) ? -1 : 1)),
      );
      expect(res.body.participants).toEqual(sc.sim.members);
      const codes = res.body.warnings.map((w: { code: string }) => w.code);
      expect(codes).toEqual(['PARTNER_ELIGIBILITY_IS_CURRENT_STATE']);
      expect(codes).not.toContain('SIMULATION_ONLY');
      expect(codes).not.toContain('NOT_A_PAYMENT_OR_OBLIGATION');
      expect(res.body).not.toHaveProperty('simulation');
      expect(res.body).not.toHaveProperty('requestFingerprint');
      expect(verifyAgreementDocument(res.body)).toBe(true);

      const second = await create(await scenario()).expect(201);
      expect(second.body.folio).toBe(folio(2));
      const rows = await counts();
      expect(rows.counters).toEqual([
        { contextId: contexts[0], year, lastNumber: 2 },
      ]);
    });

    it('keeps an independent folio sequence per context', async () => {
      const sc = await scenario({ index: 1 });
      const res = await create(sc, {}, 1).expect(201);
      expect(res.body.folio).toBe(folio(1));
      expect(res.body.contextId).toBe(contexts[1]);
    });

    it('replays the same id and content with 200, the identical body and no new folio', async () => {
      const sc = await scenario();
      const dto = body(sc, { note: '  hola  ' });
      const first = await post(endpoint, dto).expect(201);
      const before = await counts();
      const replay = await post(endpoint, {
        ...dto,
        id: dto.id.toUpperCase(),
        title: `  ${dto.title}  `,
        note: 'hola',
      }).expect(200);
      expect(replay.body).toEqual(first.body);
      expect(await counts()).toEqual(before);
    });

    it('replays an existing agreement even after the data drifted (replay precedes drift detection)', async () => {
      const sc = await scenario();
      const dto = body(sc);
      const first = await post(endpoint, dto).expect(201);
      await fund(sc.period, 5_000);
      await shift(actors[0].s1, sc.period.from);
      const before = await counts();
      const replay = await post(endpoint, dto).expect(200);
      expect(replay.body).toEqual(first.body);
      expect(await counts()).toEqual(before);
    });

    it('rejects the same id with different content, or from another account, with 409', async () => {
      const sc = await scenario();
      const dto = body(sc);
      await post(endpoint, dto).expect(201);
      const before = await counts();
      for (const patch of [
        { title: 'Otro titulo' },
        { note: 'now with a note' },
        { occurredAt: '2026-10-09T12:00:01-06:00' },
      ]) {
        const res = await post(endpoint, { ...dto, ...patch }).expect(409);
        expect(res.body.code).toBe('FINANCE_AGREEMENT_ID_CONFLICT');
      }
      const foreignAccount = await auth(
        http().post(endpoint),
        0,
        undefined,
        undefined,
        secondAccount.token,
      )
        .send(dto)
        .expect(409);
      expect(foreignAccount.body.code).toBe('FINANCE_AGREEMENT_ID_CONFLICT');
      expect(await counts()).toEqual(before);
    });

    it('rejects an origin that does not match the selected member and device with 403', async () => {
      const sc = await scenario();
      await create(sc, { createdByMemberId: actors[0].s2 }).expect(403);
      await create(sc, { deviceId: actors[0].revokedDeviceId }).expect(403);
    });

    it('applies strict validation: unknown, server-owned and malformed properties are 400', async () => {
      const sc = await scenario();
      for (const patch of [
        { contextId: contexts[1] },
        { createdByAccountId: actors[0].accountId },
        { folio: 'AC-2026-00099' },
        { status: 'voided' },
        { participants: [] },
        { members: [] },
        { pools: { partnerPoolMinor: 1, workPoolMinor: 1 } },
        { totals: { distributedMinor: 1 } },
        { workShareBps: 4999 },
        { title: '   ' },
        { title: 'x'.repeat(121) },
        { note: 'x'.repeat(1001) },
        { simulationFingerprint: 'sim1:abc' },
        { simulationFingerprint: undefined },
        { replacesAgreementId: randomUUID() },
        { id: randomUUID() },
        { occurredAt: '2026-10-09' },
        { requestedAmountMinor: 0 },
        { from: sc.period.to, to: sc.period.from },
      ])
        await create(sc, patch).expect(400);
    });

    it('propagates the simulator domain errors with their own codes and persists nothing', async () => {
      const sc = await scenario();
      const before = await counts();
      const exceeds = await post(
        endpoint,
        body({ ...sc, rule: { ...sc.rule, requestedAmountMinor: 2_000_000 } }),
      ).expect(422);
      expect(exceeds.body.code).toBe('FINANCE_DISTRIBUTION_EXCEEDS_AVAILABLE');
      // Funded but without any work shift: the simulator refuses before drift is checked.
      const idle = nextPeriod();
      await fund(idle, 100_000);
      const noWork = await post(
        endpoint,
        body({
          ...sc,
          period: idle,
          rule: { ...worked, requestedAmountMinor: 50_000 },
        }),
      ).expect(422);
      expect(noWork.body.code).toBe('FINANCE_DISTRIBUTION_NO_WORK');
      expect(await counts()).toEqual(before);
    });
  });

  describe('simulation drift', () => {
    const drifts: [string, (sc: Scenario) => Promise<unknown>][] = [
      ['a new sale', (sc) => fund(sc.period, 10_000)],
      ['a new reserve', (sc) => reserve(sc.period, 1_000)],
      ['a new work shift', (sc) => shift(actors[0].s1, sc.period.from)],
      ['a deactivated socio', () => setPartners(0, [])],
      [
        'a renamed member',
        () =>
          tenant(0, () =>
            prisma.member.update({
              where: {
                id_contextId: { id: actors[0].s1, contextId: contexts[0] },
              },
              data: { name: 'Socio One Renamed' },
            }),
          ),
      ],
    ];

    afterEach(() =>
      tenant(0, () =>
        prisma.member.update({
          where: { id_contextId: { id: actors[0].s1, contextId: contexts[0] } },
          data: { name: 'Socio One' },
        }),
      ),
    );

    it.each(drifts)(
      'answers 409 with the current fingerprint after %s and persists nothing',
      async (_label, change) => {
        const sc = await scenario();
        await change(sc);
        const before = await counts();
        const res = await create(sc).expect(409);
        expect(res.body).toMatchObject({
          code: 'FINANCE_AGREEMENT_SIMULATION_CHANGED',
          currentSimulationFingerprint:
            expect.stringMatching(/^sim1:[0-9a-f]{64}$/),
        });
        expect(res.body.currentSimulationFingerprint).not.toBe(
          sc.sim.simulationFingerprint,
        );
        expect(await counts()).toEqual(before);
        // Re-simulating with the fresh data lets the creation through.
        const fresh = await simulate(sc.period, sc.rule);
        expect(fresh.simulationFingerprint).toBe(
          res.body.currentSimulationFingerprint,
        );
        await create({ ...sc, sim: fresh }).expect(201);
      },
    );

    it('uses the same fingerprint for an unchanged period (stable across calls)', async () => {
      const sc = await scenario();
      const again = await simulate(sc.period, sc.rule);
      expect(again.simulationFingerprint).toBe(sc.sim.simulationFingerprint);
    });
  });

  describe('frozen snapshot', () => {
    it('keeps the detail identical to the creation receipt after the world changes', async () => {
      const sc = await scenario();
      const created = await create(sc).expect(201);
      await tenant(0, async () => {
        await prisma.member.update({
          where: { id_contextId: { id: actors[0].s1, contextId: contexts[0] } },
          data: { name: 'Renamed Forever' },
        });
        await prisma.member.update({
          where: { id_contextId: { id: actors[0].s2, contextId: contexts[0] } },
          data: { active: false, role: 'colaborador' },
        });
      });
      await shift(actors[0].s1, sc.period.from);
      await shift(actors[0].s1, sc.period.from);
      await reserve(sc.period, 400_000);
      await fund(sc.period, 77_000);
      await fund(nextPeriod(), 11_000);
      const detail = await get(`${endpoint}/${created.body.id}`).expect(200);
      expect(detail.body).toEqual(created.body);
      expect(verifyAgreementDocument(detail.body)).toBe(true);
      expect(
        detail.body.participants.map((p: Participant) => [
          p.name,
          p.role,
          p.isActive,
        ]),
      ).toEqual(
        expect.arrayContaining([
          ['Socio One', 'socio', true],
          ['Socio Two', 'socio', true],
        ]),
      );
      const rows = await tenant(0, () =>
        prisma.distributionAgreementParticipant.findMany({
          where: { agreementId: created.body.id },
        }),
      );
      expect(rows.map((r) => r.memberName).sort()).toEqual([
        'Socio One',
        'Socio Two',
      ]);
      expect(rows.map((r) => r.role)).toEqual(['socio', 'socio']);
      await tenant(0, async () => {
        await prisma.member.update({
          where: { id_contextId: { id: actors[0].s1, contextId: contexts[0] } },
          data: { name: 'Socio One' },
        });
        await prisma.member.update({
          where: { id_contextId: { id: actors[0].s2, contextId: contexts[0] } },
          data: { role: 'socio' },
        });
      });
    });

    it('stores participants for socios, workers, idle socios and inactive workers', async () => {
      const a = actors[0];
      const period = nextPeriod();
      await setPartners(0, [a.s2, a.s3]);
      await fund(period, 1_000_000);
      await shift(a.s1, period.from);
      await shift(a.collaborator, period.from);
      await shift(a.collaborator, period.from);
      await shift(a.inactiveCollaborator, period.from);
      const sc: Scenario = {
        period,
        rule: worked,
        sim: await simulate(period),
      };
      const res = await create(sc).expect(201);
      const by = Object.fromEntries(
        res.body.participants.map((p: Participant) => [p.memberId, p]),
      ) as Record<string, Participant>;
      expect(by[a.collaborator]).toMatchObject({
        role: 'colaborador',
        partnerEligible: false,
        partnerAmountMinor: 0,
        shiftCount: 2,
      });
      expect(by[a.collaborator].workAmountMinor).toBe(
        by[a.collaborator].totalMinor,
      );
      expect(by[a.s2]).toMatchObject({
        role: 'socio',
        partnerEligible: true,
        workAmountMinor: 0,
        shiftCount: 0,
      });
      expect(by[a.s2].partnerAmountMinor).toBeGreaterThan(0);
      expect(by[a.inactiveCollaborator]).toMatchObject({
        isActive: false,
        partnerEligible: false,
      });
      expect(by[a.inactiveCollaborator].workAmountMinor).toBeGreaterThan(0);
      expect(res.body.warnings.map((w: { code: string }) => w.code)).toContain(
        'INACTIVE_MEMBER_RECEIVES_WORK_AMOUNT',
      );
      const rows = await tenant(0, () =>
        prisma.distributionAgreementParticipant.findMany({
          where: { agreementId: res.body.id },
        }),
      );
      expect(rows).toHaveLength(res.body.participants.length);
      expect(rows.reduce((sum, r) => sum + r.totalMinor, 0)).toBe(600000);
    });

    it.each([
      [
        'three equal partners over an indivisible amount',
        {
          requestedAmountMinor: 10_000,
          partnerShareBps: 10000,
          workShareBps: 0,
          workBasis: 'WORK_SHIFTS',
        },
        [3334, 3333, 3333],
      ],
      [
        'odd pools split by work and equally',
        {
          requestedAmountMinor: 10_001,
          partnerShareBps: 3333,
          workShareBps: 6667,
          workBasis: 'WORK_SHIFTS',
        },
        null,
      ],
    ])('stores cent-exact amounts for %s', async (_label, rule, expected) => {
      const sc = await scenario({
        partners: [actors[0].s2, actors[0].s3],
        rule,
        funding: 50_000,
        s1Shifts: 1,
        s2Shifts: 1,
      });
      const res = await create(sc).expect(201);
      const rows = await tenant(0, () =>
        prisma.distributionAgreementParticipant.findMany({
          where: { agreementId: res.body.id },
        }),
      );
      expect(rows.reduce((sum, r) => sum + r.totalMinor, 0)).toBe(
        rule.requestedAmountMinor,
      );
      expect(res.body.totals).toEqual({
        distributedMinor: rule.requestedAmountMinor,
        undistributedMinor: 0,
      });
      for (const row of rows)
        expect(row.partnerAmountMinor + row.workAmountMinor).toBe(
          row.totalMinor,
        );
      if (expected)
        expect(
          rows.map((r) => r.partnerAmountMinor).sort((x, y) => y - x),
        ).toEqual(expected);
      const stored = await tenant(0, () =>
        prisma.distributionAgreement.findFirstOrThrow({
          where: { id: res.body.id },
        }),
      );
      expect(stored.partnerPoolMinor + stored.workPoolMinor).toBe(
        rule.requestedAmountMinor,
      );
      expect(stored.distributedMinor + stored.undistributedMinor).toBe(
        rule.requestedAmountMinor,
      );
    });
  });

  describe('folio concurrency', () => {
    it('allocates distinct consecutive folios to concurrent different creates', async () => {
      const count = 8;
      const before = await counts();
      const start = before.counters[0]?.lastNumber ?? 0;
      const sc = await scenario();
      const responses = await Promise.all(
        Array.from({ length: count }, (_, i) =>
          create(sc, { title: `Concurrent ${i}` }),
        ),
      );
      expect(responses.map((r) => r.status)).toEqual(Array(count).fill(201));
      const folios = responses.map((r) => r.body.folio as string).sort();
      expect(folios).toEqual(
        Array.from({ length: count }, (_, i) => folio(start + i + 1)),
      );
      expect((await counts()).counters[0].lastNumber).toBe(start + count);
    });

    it('stays gapless when two API instances contend (bounded transaction retry)', async () => {
      const second = (
        await Test.createTestingModule({ imports: [AppModule] }).compile()
      ).createNestApplication();
      second.setGlobalPrefix('api/v1');
      await second.init();
      try {
        const start = (await counts()).counters[0]?.lastNumber ?? 0;
        const sc = await scenario();
        const through = (server: INestApplication, i: number) =>
          auth(request(server.getHttpServer()).post(endpoint))
            .send(body(sc, { title: `Instance ${i}` }))
            .then((res) => res);
        const responses = await Promise.all([
          ...[0, 1, 2].map((i) => through(app, i)),
          ...[3, 4, 5].map((i) => through(second, i)),
        ]);
        expect(responses.map((r) => r.status)).toEqual(Array(6).fill(201));
        expect(responses.map((r) => r.body.folio as string).sort()).toEqual(
          Array.from({ length: 6 }, (_, i) => folio(start + i + 1)),
        );
      } finally {
        await second.close();
      }
    });

    it('turns concurrent identical creates into one 201, replays and one row', async () => {
      const sc = await scenario();
      const dto = body(sc);
      const before = await counts();
      const responses = await Promise.all(
        Array.from({ length: 4 }, () => post(endpoint, dto)),
      );
      expect(responses.map((r) => r.status).sort((x, y) => x - y)).toEqual([
        200, 200, 200, 201,
      ]);
      // JSONB reorders keys on read, so compare structure, not serialization.
      for (const response of responses)
        expect(response.body).toEqual(responses[0].body);
      const after = await counts();
      expect(after.agreements).toBe(before.agreements + 1);
      expect(after.counters[0].lastNumber).toBe(
        (before.counters[0]?.lastNumber ?? 0) + 1,
      );
    });

    it('releases the folio when the creation fails, keeping numbers gapless', async () => {
      const sc = await scenario();
      const before = await counts();
      await create(sc, { replacesAgreementId: v7() }).expect(422);
      await fund(sc.period, 1_234);
      await create(sc).expect(409);
      expect(await counts()).toEqual(before);
      const ok = await create({
        ...sc,
        sim: await simulate(sc.period, sc.rule),
      }).expect(201);
      expect(ok.body.folio).toBe(
        folio((before.counters[0]?.lastNumber ?? 0) + 1),
      );
    });
  });

  describe('replacement', () => {
    it('lets a new agreement replace a voided one and exposes both links', async () => {
      const sc = await scenario();
      const original = (await create(sc).expect(201)).body;
      const replaced = await create(sc, {
        replacesAgreementId: original.id,
      }).expect(422);
      expect(replaced.body.code).toBe('FINANCE_AGREEMENT_REPLACEMENT_INVALID');
      await reverse(original.id).expect(201);
      const replacement = (
        await create(sc, { replacesAgreementId: original.id }).expect(201)
      ).body;
      expect(replacement.replacesAgreementId).toBe(original.id);
      expect(replacement.replacesAgreement).toEqual({
        id: original.id,
        folio: original.folio,
      });
      const oldDetail = (await get(`${endpoint}/${original.id}`).expect(200))
        .body;
      expect(oldDetail.status).toBe('voided');
      expect(oldDetail.replacedBy).toEqual({
        id: replacement.id,
        folio: replacement.folio,
      });
      const newDetail = (await get(`${endpoint}/${replacement.id}`).expect(200))
        .body;
      expect(newDetail).toEqual(replacement);
      const list = (
        await get(endpoint, { from: sc.period.from, to: sc.period.to }).expect(
          200,
        )
      ).body;
      expect(
        list.items.find((i: { id: string }) => i.id === replacement.id),
      ).toMatchObject({
        replacesAgreement: { id: original.id, folio: original.folio },
      });
    });

    it.each(['active', 'unknown', 'already replaced', 'other tenant'])(
      'refuses to replace an agreement that is %s',
      async (kind) => {
        const sc = await scenario();
        const target = (await create(sc).expect(201)).body;
        let replacesAgreementId = target.id as string;
        if (kind === 'unknown') replacesAgreementId = v7();
        if (kind === 'already replaced') {
          await reverse(target.id).expect(201);
          await create(sc, { replacesAgreementId: target.id }).expect(201);
        }
        if (kind === 'other tenant') {
          const foreign = await scenario({ index: 1 });
          const other = (await create(foreign, {}, 1).expect(201)).body;
          await reverse(other.id, {}, 1).expect(201);
          replacesAgreementId = other.id;
        }
        const before = await counts();
        const res = await create(sc, { replacesAgreementId }).expect(422);
        expect(res.body.code).toBe('FINANCE_AGREEMENT_REPLACEMENT_INVALID');
        expect(await counts()).toEqual(before);
      },
    );
  });

  describe('reversal and reads', () => {
    it('voids an agreement without altering its document, with replay and conflicts', async () => {
      const sc = await scenario();
      const created = (await create(sc).expect(201)).body;
      const dto = reversalBody({ reason: '  Captured with a wrong period  ' });
      const res = await post(`${endpoint}/${created.id}/reversals`, dto).expect(
        201,
      );
      expect(res.body).toMatchObject({
        id: dto.id,
        agreementId: created.id,
        contextId: contexts[0],
        reason: 'Captured with a wrong period',
        occurredAt: '2026-10-09T19:00:00.000Z',
        createdByAccountId: actors[0].accountId,
        createdByMemberId: actors[0].s1,
        deviceId: actors[0].deviceId,
        original: created,
      });
      const replay = await post(
        `${endpoint}/${created.id.toUpperCase()}/reversals`,
        { ...dto, id: dto.id.toUpperCase() },
      ).expect(200);
      expect(replay.body).toEqual(res.body);
      const sameIdOtherReason = await post(
        `${endpoint}/${created.id}/reversals`,
        { ...dto, reason: 'A different reason' },
      ).expect(409);
      expect(sameIdOtherReason.body.code).toBe('FINANCE_AGREEMENT_ID_CONFLICT');
      const second = await reverse(created.id).expect(409);
      expect(second.body.code).toBe('FINANCE_AGREEMENT_ALREADY_VOIDED');

      const detail = (await get(`${endpoint}/${created.id}`).expect(200)).body;
      const { status, reversal, replacedBy, ...document } = detail;
      const { status: _s, reversal: _r, replacedBy: _b, ...original } = created;
      expect(status).toBe('voided');
      expect(replacedBy).toBeNull();
      expect(reversal).toMatchObject({
        id: dto.id,
        agreementId: created.id,
        reason: 'Captured with a wrong period',
      });
      expect(document).toEqual(original);
      expect(verifyAgreementDocument(detail)).toBe(true);
      const row = await tenant(0, () =>
        prisma.distributionAgreement.findFirstOrThrow({
          where: { id: created.id },
        }),
      );
      expect(row.receivedAt.toISOString()).toBe(created.receivedAt);
    });

    it('rejects reversals of unknown or foreign agreements with 404 and a self id with 400', async () => {
      const sc = await scenario();
      const created = (await create(sc).expect(201)).body;
      await reverse(v7()).expect(404);
      await reverse(created.id, {}, 1).expect(404);
      await post(
        `${endpoint}/${created.id}/reversals`,
        reversalBody({ id: created.id }),
      ).expect(400);
      await reverse(created.id, { reason: '   ' }).expect(400);
      await reverse(created.id, { createdByMemberId: actors[0].s2 }).expect(
        403,
      );
      await post(`${endpoint}/not-a-uuid/reversals`, reversalBody()).expect(
        400,
      );
    });

    it('lists summaries by status, exact period and folio, without internals', async () => {
      const sc = await scenario();
      const a = (await create(sc, { note: 'primera' }).expect(201)).body;
      const b = (await create(sc).expect(201)).body;
      await reverse(a.id).expect(201);
      const period = { from: sc.period.from, to: sc.period.to };
      const active = (await get(endpoint, period).expect(200)).body;
      expect(active.items.map((i: { id: string }) => i.id)).toEqual([b.id]);
      const voided = (
        await get(endpoint, { ...period, status: 'voided' }).expect(200)
      ).body;
      expect(voided.items).toHaveLength(1);
      expect(voided.items[0]).toEqual({
        id: a.id,
        folio: a.folio,
        status: 'voided',
        title: a.title,
        note: 'primera',
        from: sc.period.from,
        to: sc.period.to,
        requestedAmountMinor: 600000,
        partnerShareBps: 5000,
        workShareBps: 5000,
        workBasis: 'WORK_SHIFTS',
        financialStatus: 'complete',
        distributedMinor: 600000,
        participantCount: 2,
        occurredAt: a.occurredAt,
        receivedAt: a.receivedAt,
        replacesAgreement: null,
        voidedAt: '2026-10-09T19:00:00.000Z',
      });
      const byFolio = (
        await get(endpoint, { folio: b.folio.toLowerCase() }).expect(200)
      ).body;
      expect(byFolio.items.map((i: { id: string }) => i.id)).toEqual([b.id]);
      expect(
        (await get(endpoint, { folio: a.folio }).expect(200)).body.items,
      ).toEqual([]);
      expect(
        (
          await get(endpoint, {
            from: '2030-01-01',
            to: '2030-01-02',
            status: 'voided',
          }).expect(200)
        ).body.items,
      ).toEqual([]);
      const text = JSON.stringify([active, voided]);
      expect(text).not.toContain('requestFingerprint');
      expect(text).not.toContain('creationResponse');
      expect(text).not.toContain('snapshotFingerprint');
    });

    it('paginates by cursor across three pages and rejects tampered or foreign cursors', async () => {
      const sc = await scenario();
      const ids: string[] = [];
      for (let i = 0; i < 5; i++)
        ids.push((await create(sc, { title: `P${i}` }).expect(201)).body.id);
      const period = { from: sc.period.from, to: sc.period.to };
      const pages: { id: string }[][] = [];
      let cursor: string | null = null;
      do {
        const page: { items: { id: string }[]; nextCursor: string | null } = (
          await get(endpoint, {
            ...period,
            limit: '2',
            ...(cursor ? { cursor } : {}),
          }).expect(200)
        ).body;
        pages.push(page.items);
        cursor = page.nextCursor;
      } while (cursor);
      expect(pages.map((p) => p.length)).toEqual([2, 2, 1]);
      expect(pages.flat().map((i) => i.id)).toEqual([...ids].reverse());
      const first = (await get(endpoint, { ...period, limit: '2' }).expect(200))
        .body;
      const token: string = first.nextCursor;
      await get(endpoint, {
        ...period,
        limit: '2',
        cursor: token + 'x',
      }).expect(400);
      await get(endpoint, {
        ...period,
        limit: '2',
        cursor: 'not base64!',
      }).expect(400);
      await get(endpoint, {
        ...period,
        status: 'voided',
        cursor: token,
      }).expect(400);
      await get(endpoint, { cursor: token }).expect(400);
      await get(endpoint, { ...period, limit: '2' }, 1)
        .query({ cursor: token })
        .expect(400);
      const forged = Buffer.from(
        JSON.stringify({
          version: 1,
          scope: 'x',
          id: ids[0],
          receivedAt: new Date().toISOString(),
        }),
      ).toString('base64url');
      await get(endpoint, { ...period, cursor: forged }).expect(400);
    });

    it('rejects malformed list filters with 400', async () => {
      for (const query of [
        { from: '2033-01-01' },
        { to: '2033-01-02' },
        { from: '2033-01-02', to: '2033-01-01' },
        { status: 'reversed' },
        { limit: '0' },
        { limit: '101' },
        { limit: '1e1' },
        { folio: 'AC-1' },
        { unknown: '1' },
      ])
        await get(endpoint, query).expect(400);
    });

    it('answers 404 for an unknown id and 400 for a malformed one', async () => {
      await get(`${endpoint}/${v7()}`).expect(404);
      await get(`${endpoint}/not-a-uuid`).expect(400);
    });
  });

  describe('tenant isolation and database guarantees', () => {
    it('hides agreements from other contexts in list, detail and reversal', async () => {
      const sc = await scenario();
      const created = (await create(sc).expect(201)).body;
      const list = (await get(endpoint, {}, 1).expect(200)).body;
      expect(list.items.map((i: { id: string }) => i.id)).not.toContain(
        created.id,
      );
      await get(`${endpoint}/${created.id}`, {}, 1).expect(404);
      await reverse(created.id, {}, 1).expect(404);
      const stillThere = await counts();
      expect(stillThere.reversals).toBe(
        await tenant(0, () => prisma.distributionAgreementReversal.count()),
      );
    });

    it('does not disclose a foreign agreement through a global id collision', async () => {
      const foreign = await scenario();
      const created = (await create(foreign).expect(201)).body;
      const mine = await scenario({ index: 1 });
      const res = await create(mine, { id: created.id }, 1).expect(404);
      expect(JSON.stringify(res.body)).not.toContain(created.folio);
    });

    it('enables and forces row level security on all four new tables', async () => {
      const tables = [
        'DistributionAgreement',
        'DistributionAgreementParticipant',
        'DistributionAgreementReversal',
        'DistributionAgreementCounter',
      ];
      await prisma.$transaction(async (tx) => {
        const role = await tx.$queryRaw<
          { rolsuper: boolean; rolbypassrls: boolean }[]
        >`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
        expect(role[0]).toEqual({ rolsuper: false, rolbypassrls: false });
        const rows = await tx.$queryRaw<
          {
            relname: string;
            relrowsecurity: boolean;
            relforcerowsecurity: boolean;
          }[]
        >`SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('DistributionAgreement', 'DistributionAgreementParticipant', 'DistributionAgreementReversal', 'DistributionAgreementCounter')`;
        expect(rows.map((r) => r.relname).sort()).toEqual([...tables].sort());
        expect(
          rows.every((r) => r.relrowsecurity && r.relforcerowsecurity),
        ).toBe(true);
        const policies = await tx.$queryRaw<
          { tablename: string }[]
        >`SELECT tablename FROM pg_policies WHERE policyname = 'tenant_isolation' AND tablename LIKE 'DistributionAgreement%'`;
        expect(policies.map((p) => p.tablename).sort()).toEqual(
          [...tables].sort(),
        );
        // Without a tenant context nothing is visible.
        expect(
          await tx.$queryRaw`SELECT id FROM "DistributionAgreement"`,
        ).toEqual([]);
      });
    });

    it('rejects UPDATE and DELETE on the immutable tables, even for the same tenant', async () => {
      const sc = await scenario();
      const created = (await create(sc).expect(201)).body;
      await reverse(created.id).expect(201);
      const attempt = (sql: (tx: PrismaService) => Promise<unknown>) =>
        tenant(0, () =>
          prisma.$transaction(async (tx) => {
            await sql(tx as unknown as PrismaService);
          }),
        );
      const id = created.id as string;
      await expect(
        attempt(
          (tx) =>
            tx.$executeRaw`UPDATE "DistributionAgreement" SET "title" = 'tampered' WHERE id = ${id}::uuid`,
        ),
      ).rejects.toThrow(/immutable/);
      await expect(
        attempt(
          (tx) =>
            tx.$executeRaw`DELETE FROM "DistributionAgreement" WHERE id = ${id}::uuid`,
        ),
      ).rejects.toThrow(/immutable/);
      await expect(
        attempt(
          (tx) =>
            tx.$executeRaw`UPDATE "DistributionAgreementParticipant" SET "totalMinor" = 1 WHERE "agreementId" = ${id}::uuid`,
        ),
      ).rejects.toThrow(/immutable/);
      await expect(
        attempt(
          (tx) =>
            tx.$executeRaw`DELETE FROM "DistributionAgreementParticipant" WHERE "agreementId" = ${id}::uuid`,
        ),
      ).rejects.toThrow(/immutable/);
      await expect(
        attempt(
          (tx) =>
            tx.$executeRaw`UPDATE "DistributionAgreementReversal" SET "reason" = 'tampered' WHERE "agreementId" = ${id}::uuid`,
        ),
      ).rejects.toThrow(/immutable/);
      await expect(
        attempt(
          (tx) =>
            tx.$executeRaw`DELETE FROM "DistributionAgreementReversal" WHERE "agreementId" = ${id}::uuid`,
        ),
      ).rejects.toThrow(/immutable/);
      // The folio counter is the one mutable table by design.
      await expect(
        attempt(
          (tx) =>
            tx.$executeRaw`UPDATE "DistributionAgreementCounter" SET "lastNumber" = "lastNumber" WHERE "contextId" = ${contexts[0]}`,
        ),
      ).resolves.toBeUndefined();
      const detail = (await get(`${endpoint}/${id}`).expect(200)).body;
      expect(detail.title).toBe(created.title);
      expect(detail.status).toBe('voided');
    });

    it('enforces the database checks on direct inserts', async () => {
      const sc = await scenario();
      const created = (await create(sc).expect(201)).body;
      const insert = (patch: string, sums = true) =>
        tenant(0, () =>
          prisma.$transaction((tx) =>
            tx.$executeRawUnsafe(
              `INSERT INTO "DistributionAgreement" ("id","contextId","folio","periodFrom","periodTo","requestedAmountMinor","partnerShareBps","workShareBps","workBasis","financialStatus","potentiallyAvailableMinor","partnerPoolMinor","workPoolMinor","distributedMinor","undistributedMinor","algorithmVersion","title","createdByMemberId","createdByMemberName","createdByAccountId","deviceId","occurredAt","requestFingerprint","snapshotFingerprint","warningsSnapshot","creationResponse") VALUES ('${v7()}','${contexts[0]}','AC-2026-90001','2033-06-01','2033-06-02',100,5000,5000,'WORK_SHIFTS','complete',100,${sums ? '50,50,100,0' : '50,40,100,0'},1,'t','${actors[0].s1}','n','${actors[0].accountId}','${actors[0].deviceId}',now(),'f','s','[]','{}')${patch}`,
            ),
          ),
        );
      await expect(insert('')).resolves.toBe(1);
      await expect(insert('', false)).rejects.toThrow();
      expect(created.folio).toMatch(/^AC-\d{4}-\d{5,}$/);
    });

    it('creates no payment, settlement or withdrawal structures', async () => {
      const tables = await prisma.$queryRaw<
        { table_name: string }[]
      >`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND (table_name ILIKE '%payment%' OR table_name ILIKE '%settlement%' OR table_name ILIKE '%withdrawal%')`;
      expect(tables).toEqual([]);
    });
  });

  describe('permissions', () => {
    const routes = (id: string) => [
      () => http().post(endpoint),
      () => http().get(endpoint),
      () => http().get(`${endpoint}/${id}`),
      () => http().post(`${endpoint}/${id}/reversals`),
    ];

    it('denies anonymous callers on every route', async () => {
      for (const route of routes(v7()))
        await route()
          .send({})
          .expect((res) => expect([401]).toContain(res.status));
    });

    it('denies collaborators, inactive members, revoked devices and foreign selections on every route', async () => {
      const sc = await scenario();
      const created = (await create(sc).expect(201)).body;
      const a = actors[0];
      const selections: [string, string, string][] = [
        ['collaborator', a.collaborator, a.deviceId],
        ['inactive socio', a.inactiveSocio, a.deviceId],
        ['inactive collaborator', a.inactiveCollaborator, a.deviceId],
        ['revoked device', a.s1, a.revokedDeviceId],
        ['foreign member', actors[1].s1, a.deviceId],
        ['foreign device', a.s1, actors[1].deviceId],
      ];
      for (const [label, memberId, deviceId] of selections)
        for (const route of routes(created.id))
          await auth(route(), 0, memberId, deviceId)
            .send(body(sc))
            .expect((res) => expect([label, res.status]).toEqual([label, 403]));
      await http().get(endpoint).auth(a.token, { type: 'bearer' }).expect(403);
    });

    it('serves socios on all four routes', async () => {
      const sc = await scenario();
      const created = (await create(sc).expect(201)).body;
      await get(endpoint).expect(200);
      await get(`${endpoint}/${created.id}`).expect(200);
      await reverse(created.id).expect(201);
    });
  });

  describe('simulator purity', () => {
    it('persists nothing when simulating, and the simulation still reports persisted:false', async () => {
      const sc = await scenario();
      const before = await counts();
      const first = await simulate(sc.period, sc.rule);
      const second = await simulate(sc.period, sc.rule);
      expect(first.persisted).toBe(false);
      expect(first.simulation).toBe(true);
      expect(first).toEqual(second);
      expect(first.warnings.map((w: { code: string }) => w.code)).toEqual(
        expect.arrayContaining([
          'SIMULATION_ONLY',
          'NOT_A_PAYMENT_OR_OBLIGATION',
        ]),
      );
      expect(await counts()).toEqual(before);
    });
  });
});

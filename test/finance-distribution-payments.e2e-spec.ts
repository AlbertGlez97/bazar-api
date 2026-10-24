import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { v7 } from 'uuid';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { selectTestMigrationDatabase } from '../scripts/test-environment.js';
import { purgeAgreementData } from './agreement-cleanup.js';
import { withTestTenant } from './tenant-scope.js';

interface Actor {
  accountId: string;
  token: string;
  collaboratorToken: string;
  s1: string;
  collaborator: string;
  deviceId: string;
}
interface Fixture {
  id: string;
  members: string[];
}

const AGREEMENT_AT = '2026-10-01T00:00:00.000Z';
const PAID_AT = '2026-10-05T12:00:00-06:00';
const LATER_AT = '2026-10-06T12:00:00-06:00';
const COPY_COLUMNS = {
  payment: [
    'id',
    'contextId',
    'agreementId',
    'participantMemberId',
    'amountMinor',
    'currency',
    'occurredAt',
    'note',
    'createdByMemberId',
    'createdByAccountId',
    'deviceId',
    'receivedAt',
    'requestFingerprint',
    'creationResponse',
  ],
  reversal: [
    'id',
    'contextId',
    'paymentId',
    'reason',
    'occurredAt',
    'receivedAt',
    'createdByMemberId',
    'createdByAccountId',
    'deviceId',
    'requestFingerprint',
    'creationResponse',
  ],
} as const;

describe('finance distribution payments HTTP', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const contexts = [`pay-${randomUUID()}`, `pay-other-${randomUUID()}`];
  const actors: Actor[] = [];
  let secondAccount: { id: string; token: string; memberId: string };
  let folioCounter = 90000;
  const base = '/api/v1/finance';
  const agreementsPath = `${base}/distribution-agreements`;
  const paymentsPath = `${base}/distribution-payments`;
  const tenant = <T>(index: number, fn: () => Promise<T>) =>
    withTestTenant(contexts[index], fn);
  const http = () => request(app.getHttpServer());
  const auth = (req: request.Test, index = 0, token?: string) =>
    req
      .auth(token ?? actors[index].token, { type: 'bearer' })
      .set('x-device-id', actors[index].deviceId);
  const post = (path: string, body: unknown, index = 0, token?: string) =>
    auth(http().post(path), index, token).send(body as object);
  const get = (path: string, index = 0, query: Record<string, string> = {}) =>
    auth(http().get(path), index).query(query);

  /** Immutable agreement written straight to the tables (known exact amounts). */
  const makeAgreement = (amounts: number[], index = 0) =>
    tenant(index, async (): Promise<Fixture> => {
      const contextId = contexts[index];
      const actor = actors[index];
      const sum = amounts.reduce((a, b) => a + b, 0);
      const requested = Math.max(sum, 1);
      const id = v7();
      const members: string[] = [];
      for (let i = 0; i < amounts.length; i++)
        members.push(
          (
            await prisma.member.create({
              data: { contextId, name: `P${i + 1}`, role: 'socio' },
            })
          ).id,
        );
      await prisma.distributionAgreement.create({
        data: {
          id,
          contextId,
          folio: `AC-2026-${String(++folioCounter).padStart(5, '0')}`,
          periodFrom: new Date('2026-09-01T00:00:00Z'),
          periodTo: new Date('2026-09-02T00:00:00Z'),
          requestedAmountMinor: requested,
          partnerShareBps: 10000,
          workShareBps: 0,
          workBasis: 'WORK_SHIFTS',
          financialStatus: 'complete',
          potentiallyAvailableMinor: requested,
          partnerPoolMinor: requested,
          workPoolMinor: 0,
          distributedMinor: sum,
          undistributedMinor: requested - sum,
          algorithmVersion: 1,
          title: 'Payment fixture',
          createdByMemberId: actor.s1,
          createdByMemberName: 'Socio One',
          createdByAccountId: actor.accountId,
          deviceId: actor.deviceId,
          occurredAt: new Date(AGREEMENT_AT),
          requestFingerprint: randomUUID(),
          snapshotFingerprint: randomUUID(),
          warningsSnapshot: [],
          creationResponse: { id, fixture: true },
        },
      });
      await prisma.distributionAgreementParticipant.createMany({
        data: amounts.map((total, i) => ({
          agreementId: id,
          contextId,
          memberId: members[i],
          memberName: `P${i + 1}`,
          role: 'socio',
          isActive: true,
          partnerEligible: true,
          partnerAmountMinor: total,
          workUnits: 0,
          shiftCount: 0,
          knownMinutes: 0,
          unknownDurationCount: 0,
          workAmountMinor: 0,
          totalMinor: total,
        })),
      });
      return { id, members };
    });

  const payBody = (
    participantMemberId: string,
    amountMinor: number,
    overrides: Record<string, unknown> = {},
    index = 0,
  ) => ({
    id: v7(),
    participantMemberId,
    amountMinor,
    occurredAt: PAID_AT,
    createdByMemberId: actors[index].s1,
    deviceId: actors[index].deviceId,
    ...overrides,
  });
  const pay = (
    agreementId: string,
    participantMemberId: string,
    amountMinor: number,
    overrides: Record<string, unknown> = {},
    index = 0,
  ) =>
    post(
      `${agreementsPath}/${agreementId}/payments`,
      payBody(participantMemberId, amountMinor, overrides, index),
      index,
    );
  const reverseBody = (overrides: Record<string, unknown> = {}, index = 0) => ({
    id: v7(),
    reason: 'Typed the wrong amount',
    occurredAt: LATER_AT,
    createdByMemberId: actors[index].s1,
    deviceId: actors[index].deviceId,
    ...overrides,
  });
  const reversePayment = (
    paymentId: string,
    overrides: Record<string, unknown> = {},
    index = 0,
  ) =>
    post(
      `${paymentsPath}/${paymentId}/reversals`,
      reverseBody(overrides, index),
      index,
    );
  const voidAgreement = (agreementId: string) =>
    post(`${agreementsPath}/${agreementId}/reversals`, {
      id: v7(),
      reason: 'Agreement voided in test',
      occurredAt: LATER_AT,
      createdByMemberId: actors[0].s1,
      deviceId: actors[0].deviceId,
    });
  /** Active paid (payments without reversal) straight from the tables. */
  const activePaid = (agreementId: string, memberId: string) =>
    tenant(0, async () => {
      const rows = await prisma.distributionPayment.findMany({
        where: { agreementId, participantMemberId: memberId },
        include: { reversal: { select: { id: true } } },
      });
      return rows
        .filter((row) => !row.reversal)
        .reduce((sum, row) => sum + row.amountMinor, 0);
    });
  const owner = async <T>(
    contextId: string,
    fn: (client: pg.Client) => Promise<T>,
  ): Promise<T> => {
    const client = new pg.Client({
      connectionString: selectTestMigrationDatabase(),
    });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.context_id', $1, true)", [
        contextId,
      ]);
      return await fn(client);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      await client.end();
    }
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
    prisma = app.get(PrismaService);
    // One account (and token) per person: the token decides who acts.
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
    for (const contextId of contexts) {
      const fixture = await withTestTenant(contextId, async () => {
        const s1 = (
          await prisma.member.create({
            data: { contextId, name: 'Socio One', role: 'socio' },
          })
        ).id;
        const collaborator = (
          await prisma.member.create({
            data: { contextId, name: 'Colaborador', role: 'colaborador' },
          })
        ).id;
        const deviceId = (
          await prisma.device.create({
            data: { contextId, name: 'Tablet', authorized: true },
          })
        ).id;
        return { s1, collaborator, deviceId };
      });
      const socio = await accountFor(contextId, fixture.s1);
      const colaborador = await accountFor(contextId, fixture.collaborator);
      actors.push({
        accountId: socio.id,
        token: socio.token,
        collaboratorToken: colaborador.token,
        ...fixture,
      });
    }
    // A second socio (another person, another account) in the first context.
    const secondMemberId = await withTestTenant(
      contexts[0],
      async () =>
        (
          await prisma.member.create({
            data: { contextId: contexts[0], name: 'Socio Two', role: 'socio' },
          })
        ).id,
    );
    secondAccount = {
      ...(await accountFor(contexts[0], secondMemberId)),
      memberId: secondMemberId,
    };
  });
  afterAll(async () => {
    await purgeAgreementData(contexts);
    if (prisma)
      for (const contextId of contexts) {
        await withTestTenant(contextId, async () => {
          await prisma.expense.deleteMany({ where: { contextId } });
          await prisma.device.deleteMany({ where: { contextId } });
        });
        // Accounts before Members (Account.memberId is ON DELETE RESTRICT).
        await prisma.account.deleteMany({ where: { contextId } });
        await withTestTenant(contextId, () =>
          prisma.member.deleteMany({ where: { contextId } }),
        );
      }
    await app?.close();
  });

  describe('recording payments', () => {
    it('records a total payment with the full receipt and live summaries', async () => {
      const a = await makeAgreement([1000, 500]);
      const dto = payBody(a.members[0], 1000, { note: '  cash in hand  ' });
      const res = await post(`${agreementsPath}/${a.id}/payments`, dto).expect(
        201,
      );
      expect(res.body).toMatchObject({
        id: dto.id,
        contextId: contexts[0],
        agreementId: a.id,
        participantMemberId: a.members[0],
        participantName: 'P1',
        amountMinor: 1000,
        currency: 'MXN',
        occurredAt: '2026-10-05T18:00:00.000Z',
        note: 'cash in hand',
        status: 'active',
        reversal: null,
        createdBy: {
          memberId: actors[0].s1,
          name: 'Socio One',
          accountId: actors[0].accountId,
          deviceId: actors[0].deviceId,
        },
        participantSummary: {
          memberId: a.members[0],
          memberName: 'P1',
          agreedMinor: 1000,
          paidMinor: 1000,
          pendingMinor: 0,
          status: 'PAID',
        },
        paymentSummary: {
          status: 'PARTIALLY_PAID',
          agreedMinor: 1500,
          paidMinor: 1000,
          pendingMinor: 500,
          hasPayments: true,
          paymentCount: 1,
          activePaymentCount: 1,
        },
      });
      expect(res.body.receivedAt).toMatch(/Z$/);
      expect(res.body).not.toHaveProperty('requestFingerprint');
      expect(
        res.body.paymentSummary.participants.map(
          (p: { status: string }) => p.status,
        ),
      ).toEqual(['PAID', 'UNPAID']);
    });

    it('walks an agreement through UNPAID, PARTIALLY_PAID and PAID with several partials', async () => {
      const a = await makeAgreement([1000, 500]);
      const detail0 = await get(`${agreementsPath}/${a.id}`).expect(200);
      expect(detail0.body.paymentSummary).toMatchObject({
        status: 'UNPAID',
        agreedMinor: 1500,
        paidMinor: 0,
        pendingMinor: 1500,
        hasPayments: false,
      });
      const first = await pay(a.id, a.members[0], 300).expect(201);
      expect(first.body.participantSummary).toMatchObject({
        paidMinor: 300,
        pendingMinor: 700,
        status: 'PARTIALLY_PAID',
      });
      await pay(a.id, a.members[0], 300).expect(201);
      const exact = await pay(a.id, a.members[0], 400).expect(201);
      expect(exact.body.participantSummary.status).toBe('PAID');
      expect(exact.body.paymentSummary.status).toBe('PARTIALLY_PAID');
      const last = await pay(a.id, a.members[1], 500).expect(201);
      expect(last.body.paymentSummary).toMatchObject({
        status: 'PAID',
        paidMinor: 1500,
        pendingMinor: 0,
        paymentCount: 4,
      });
      const detail = await get(`${agreementsPath}/${a.id}`).expect(200);
      expect(detail.body.paymentSummary).toEqual(last.body.paymentSummary);
      expect(detail.body.status).toBe('active');
    });

    it('rejects amounts of zero, negative, fractional or oversized and unknown fields with 400', async () => {
      const a = await makeAgreement([1000]);
      for (const amountMinor of [0, -5, 1.5, '100', 2_147_483_648])
        await pay(a.id, a.members[0], amountMinor as number).expect(400);
      for (const extra of ['agreedMinor', 'contextId', 'participantName'])
        await pay(a.id, a.members[0], 10, { [extra]: 1 }).expect(400);
      await pay(a.id, a.members[0], 10, { occurredAt: '2026-10-05' }).expect(
        400,
      );
      await pay(a.id, a.members[0], 10, { id: randomUUID() }).expect(400);
      await post(
        `${agreementsPath}/not-a-uuid/payments`,
        payBody(a.members[0], 1),
      ).expect(400);
      expect(
        (await get(`${agreementsPath}/${a.id}/payments`)).body.items,
      ).toEqual([]);
    });

    it('turns a blank note into null', async () => {
      const a = await makeAgreement([1000]);
      const res = await pay(a.id, a.members[0], 10, { note: '   ' }).expect(
        201,
      );
      expect(res.body.note).toBeNull();
    });

    it('answers 404 for unknown or foreign agreements and non-participants', async () => {
      const a = await makeAgreement([1000]);
      const b = await makeAgreement([1000]);
      const foreign = await makeAgreement([1000], 1);
      await pay(v7(), a.members[0], 10).expect(404);
      await pay(foreign.id, foreign.members[0], 10).expect(404);
      await pay(a.id, randomUUID(), 10).expect(404);
      await pay(a.id, b.members[0], 10).expect(404);
      await pay(a.id, foreign.members[0], 10).expect(404);
      await get(`${agreementsPath}/${foreign.id}/payments`).expect(404);
    });

    it('rejects a participant with nothing agreed with 422', async () => {
      const a = await makeAgreement([1000, 0]);
      const res = await pay(a.id, a.members[1], 10).expect(422);
      expect(res.body.code).toBe('FINANCE_PAYMENT_NOTHING_AGREED');
      const detail = await get(`${agreementsPath}/${a.id}`).expect(200);
      expect(detail.body.paymentSummary.participants[1].status).toBe('NOT_DUE');
    });

    it('rejects an overpayment with the exact figures and accepts exactly the pending amount', async () => {
      const a = await makeAgreement([1000]);
      await pay(a.id, a.members[0], 300).expect(201);
      const over = await pay(a.id, a.members[0], 701).expect(422);
      expect(over.body).toMatchObject({
        code: 'FINANCE_PAYMENT_EXCEEDS_PENDING',
        agreedMinor: 1000,
        paidMinor: 300,
        pendingMinor: 700,
      });
      await pay(a.id, a.members[0], 700).expect(201);
      const full = await pay(a.id, a.members[0], 1).expect(422);
      expect(full.body).toMatchObject({ paidMinor: 1000, pendingMinor: 0 });
      expect(await activePaid(a.id, a.members[0])).toBe(1000);
    });

    it('rejects a payment on a voided agreement with 409 but keeps the history readable', async () => {
      const a = await makeAgreement([1000]);
      const paid = await pay(a.id, a.members[0], 400).expect(201);
      await voidAgreement(a.id).expect(201);
      const res = await pay(a.id, a.members[0], 100).expect(409);
      expect(res.body.code).toBe('FINANCE_PAYMENT_AGREEMENT_VOIDED');
      const list = await get(`${agreementsPath}/${a.id}/payments`).expect(200);
      expect(list.body.items.map((p: { id: string }) => p.id)).toEqual([
        paid.body.id,
      ]);
      expect(list.body.paymentSummary).toMatchObject({
        status: 'PARTIALLY_PAID',
        hasPayments: true,
      });
      const detail = await get(`${agreementsPath}/${a.id}`).expect(200);
      expect(detail.body).toMatchObject({
        status: 'voided',
        paymentSummary: { paidMinor: 400 },
      });
      // A reversal only fixes a mistaken record, so it stays possible.
      await reversePayment(paid.body.id).expect(201);
    });

    it('validates the payment time against the agreement and the server clock', async () => {
      const a = await makeAgreement([1000]);
      const before = await pay(a.id, a.members[0], 10, {
        occurredAt: '2026-09-30T23:59:59.999Z',
      }).expect(422);
      expect(before.body.code).toBe('FINANCE_PAYMENT_TIME_INVALID');
      const future = new Date(Date.now() + 24 * 3600_000).toISOString();
      const ahead = await pay(a.id, a.members[0], 10, {
        occurredAt: future,
      }).expect(422);
      expect(ahead.body.code).toBe('FINANCE_PAYMENT_TIME_INVALID');
      await pay(a.id, a.members[0], 10, { occurredAt: AGREEMENT_AT }).expect(
        201,
      );
    });

    it('orders the list by occurredAt, receivedAt and id, newest first', async () => {
      const a = await makeAgreement([1000]);
      const early = await pay(a.id, a.members[0], 10, {
        occurredAt: '2026-10-02T12:00:00Z',
      }).expect(201);
      const late = await pay(a.id, a.members[0], 10, {
        occurredAt: '2026-10-04T12:00:00Z',
      }).expect(201);
      const mid = await pay(a.id, a.members[0], 10, {
        occurredAt: '2026-10-03T12:00:00Z',
      }).expect(201);
      const list = await get(`${agreementsPath}/${a.id}/payments`).expect(200);
      expect(list.body.items.map((p: { id: string }) => p.id)).toEqual([
        late.body.id,
        mid.body.id,
        early.body.id,
      ]);
      const one = await get(`${paymentsPath}/${mid.body.id}`).expect(200);
      expect(one.body).toMatchObject({
        id: mid.body.id,
        status: 'active',
        participantName: 'P1',
      });
      expect(one.body).not.toHaveProperty('paymentSummary');
    });
  });

  describe('idempotency', () => {
    it('replays an identical request with 200 and the same frozen receipt', async () => {
      const a = await makeAgreement([1000]);
      const dto = payBody(a.members[0], 400);
      const first = await post(
        `${agreementsPath}/${a.id}/payments`,
        dto,
      ).expect(201);
      const replay = await post(`${agreementsPath}/${a.id}/payments`, {
        ...dto,
        id: dto.id.toUpperCase(),
      }).expect(200);
      expect(replay.body).toEqual(first.body);
      expect(
        (await get(`${agreementsPath}/${a.id}/payments`)).body.items,
      ).toHaveLength(1);
    });

    it('answers 200, not 422, to a retry after the payment exactly filled the balance', async () => {
      const a = await makeAgreement([1000]);
      const dto = payBody(a.members[0], 1000);
      await post(`${agreementsPath}/${a.id}/payments`, dto).expect(201);
      const retry = await post(
        `${agreementsPath}/${a.id}/payments`,
        dto,
      ).expect(200);
      expect(retry.body.participantSummary.status).toBe('PAID');
    });

    it('answers 200, not 409, to a retry after the agreement was voided, with live status', async () => {
      const a = await makeAgreement([1000]);
      const dto = payBody(a.members[0], 500);
      await post(`${agreementsPath}/${a.id}/payments`, dto).expect(201);
      await voidAgreement(a.id).expect(201);
      const retry = await post(
        `${agreementsPath}/${a.id}/payments`,
        dto,
      ).expect(200);
      expect(retry.body).toMatchObject({ status: 'active', amountMinor: 500 });
    });

    it('answers 200 with the live voided status to a retry after the payment was reversed', async () => {
      const a = await makeAgreement([1000]);
      const dto = payBody(a.members[0], 500);
      await post(`${agreementsPath}/${a.id}/payments`, dto).expect(201);
      await reversePayment(dto.id).expect(201);
      const retry = await post(
        `${agreementsPath}/${a.id}/payments`,
        dto,
      ).expect(200);
      expect(retry.body.status).toBe('voided');
      expect(retry.body.reversal).toMatchObject({
        reason: 'Typed the wrong amount',
      });
      expect(retry.body.paymentSummary.paidMinor).toBe(0);
    });

    it('rejects the same id with different content, another agreement or another account with 409', async () => {
      const a = await makeAgreement([1000]);
      const b = await makeAgreement([1000]);
      const dto = payBody(a.members[0], 400);
      await post(`${agreementsPath}/${a.id}/payments`, dto).expect(201);
      for (const patch of [
        { amountMinor: 401 },
        { note: 'now with note' },
        { occurredAt: LATER_AT },
      ]) {
        const res = await post(`${agreementsPath}/${a.id}/payments`, {
          ...dto,
          ...patch,
        }).expect(409);
        expect(res.body.code).toBe('FINANCE_PAYMENT_ID_CONFLICT');
      }
      const otherAgreement = await post(`${agreementsPath}/${b.id}/payments`, {
        ...dto,
        participantMemberId: b.members[0],
      }).expect(409);
      expect(otherAgreement.body.code).toBe('FINANCE_PAYMENT_ID_CONFLICT');
      // Another person (another account) replaying the same payment id.
      const otherAccount = await post(
        `${agreementsPath}/${a.id}/payments`,
        { ...dto, createdByMemberId: secondAccount.memberId },
        0,
        secondAccount.token,
      ).expect(409);
      expect(otherAccount.body.code).toBe('FINANCE_PAYMENT_ID_CONFLICT');
      expect(await activePaid(a.id, a.members[0])).toBe(400);
    });

    it('reports an id used in ANOTHER tenant as 409 without disclosing it', async () => {
      const a = await makeAgreement([1000]);
      const foreign = await makeAgreement([1000], 1);
      const dto = payBody(foreign.members[0], 100, {}, 1);
      await post(`${agreementsPath}/${foreign.id}/payments`, dto, 1).expect(
        201,
      );
      const res = await post(`${agreementsPath}/${a.id}/payments`, {
        ...dto,
        participantMemberId: a.members[0],
        createdByMemberId: actors[0].s1,
        deviceId: actors[0].deviceId,
      }).expect(409);
      expect(res.body.code).toBe('FINANCE_PAYMENT_ID_CONFLICT');
      expect(JSON.stringify(res.body)).not.toContain(contexts[1]);
      expect(
        (await get(`${agreementsPath}/${a.id}/payments`)).body.items,
      ).toEqual([]);
    });
  });

  describe('reversals', () => {
    it('reverses a payment, restores the balance and keeps the history', async () => {
      const a = await makeAgreement([1000, 500]);
      await pay(a.id, a.members[1], 500).expect(201);
      const paid = await pay(a.id, a.members[0], 1000).expect(201);
      expect(paid.body.paymentSummary.status).toBe('PAID');
      const dto = reverseBody({ reason: '  wrong participant  ' });
      const res = await post(
        `${paymentsPath}/${paid.body.id}/reversals`,
        dto,
      ).expect(201);
      expect(res.body).toMatchObject({
        id: paid.body.id,
        status: 'voided',
        amountMinor: 1000,
        reversal: {
          id: dto.id,
          reason: 'wrong participant',
          occurredAt: '2026-10-06T18:00:00.000Z',
          createdBy: { memberId: actors[0].s1, name: 'Socio One' },
        },
        participantSummary: {
          paidMinor: 0,
          pendingMinor: 1000,
          status: 'UNPAID',
        },
        paymentSummary: {
          status: 'PARTIALLY_PAID',
          paidMinor: 500,
          pendingMinor: 1000,
          paymentCount: 2,
          activePaymentCount: 1,
          hasPayments: true,
        },
      });
      const list = await get(`${agreementsPath}/${a.id}/payments`).expect(200);
      expect(
        list.body.items.map((p: { id: string; status: string }) => [
          p.id,
          p.status,
        ]),
      ).toContainEqual([paid.body.id, 'voided']);
      // The correction is two steps: the reversed amount can be paid again.
      await pay(a.id, a.members[0], 1000).expect(201);
    });

    it('requires a non-blank reason and a valid body', async () => {
      const a = await makeAgreement([1000]);
      const paid = await pay(a.id, a.members[0], 100).expect(201);
      for (const reason of ['', '   ', undefined, 'x'.repeat(1001)])
        await reversePayment(paid.body.id, { reason }).expect(400);
      await reversePayment(paid.body.id, { paymentId: paid.body.id }).expect(
        400,
      );
      await reversePayment(paid.body.id, { occurredAt: '2026-10-06' }).expect(
        400,
      );
    });

    it('replays with 200, rejects a double reversal and an id reused for another payment', async () => {
      const a = await makeAgreement([1000]);
      const p1 = await pay(a.id, a.members[0], 100).expect(201);
      const p2 = await pay(a.id, a.members[0], 100).expect(201);
      const dto = reverseBody();
      const first = await post(
        `${paymentsPath}/${p1.body.id}/reversals`,
        dto,
      ).expect(201);
      const replay = await post(
        `${paymentsPath}/${p1.body.id}/reversals`,
        dto,
      ).expect(200);
      expect(replay.body).toEqual(first.body);
      const double = await reversePayment(p1.body.id).expect(409);
      expect(double.body.code).toBe('FINANCE_PAYMENT_ALREADY_VOIDED');
      for (const target of [p1.body.id, p2.body.id]) {
        const clash = await post(`${paymentsPath}/${target}/reversals`, {
          ...dto,
          reason: 'different content',
        }).expect(409);
        expect(clash.body.code).toBe('FINANCE_PAYMENT_ID_CONFLICT');
      }
      const otherPayment = await post(
        `${paymentsPath}/${p2.body.id}/reversals`,
        dto,
      ).expect(409);
      expect(otherPayment.body.code).toBe('FINANCE_PAYMENT_ID_CONFLICT');
      expect((await get(`${paymentsPath}/${p2.body.id}`)).body.status).toBe(
        'active',
      );
    });

    it('answers 404 for unknown or foreign payments and 409 for a reversal id used in another tenant', async () => {
      const foreign = await makeAgreement([1000], 1);
      const fp = await pay(foreign.id, foreign.members[0], 100, {}, 1).expect(
        201,
      );
      await reversePayment(v7()).expect(404);
      await reversePayment(fp.body.id).expect(404);
      await get(`${paymentsPath}/${fp.body.id}`).expect(404);
      const frev = reverseBody({}, 1);
      await post(`${paymentsPath}/${fp.body.id}/reversals`, frev, 1).expect(
        201,
      );
      const a = await makeAgreement([1000]);
      const mine = await pay(a.id, a.members[0], 100).expect(201);
      const clash = await post(`${paymentsPath}/${mine.body.id}/reversals`, {
        ...frev,
        createdByMemberId: actors[0].s1,
        deviceId: actors[0].deviceId,
      }).expect(409);
      expect(clash.body.code).toBe('FINANCE_PAYMENT_ID_CONFLICT');
      expect((await get(`${paymentsPath}/${mine.body.id}`)).body.status).toBe(
        'active',
      );
    });

    it('validates the reversal time against the payment and the server clock', async () => {
      const a = await makeAgreement([1000]);
      const paid = await pay(a.id, a.members[0], 100).expect(201);
      const before = await reversePayment(paid.body.id, {
        occurredAt: '2026-10-05T17:59:59.999Z',
      }).expect(422);
      expect(before.body.code).toBe('FINANCE_PAYMENT_REVERSAL_TIME_INVALID');
      const future = new Date(Date.now() + 24 * 3600_000).toISOString();
      const ahead = await reversePayment(paid.body.id, {
        occurredAt: future,
      }).expect(422);
      expect(ahead.body.code).toBe('FINANCE_PAYMENT_REVERSAL_TIME_INVALID');
      await reversePayment(paid.body.id, {
        occurredAt: '2026-10-05T18:00:00.000Z',
      }).expect(201);
    });
  });

  describe('permissions and origin', () => {
    it('answers 401 without a token and 403 to a collaborator on every route', async () => {
      const a = await makeAgreement([1000]);
      const paid = await pay(a.id, a.members[0], 100).expect(201);
      const routes: [string, string, object?][] = [
        [
          'post',
          `${agreementsPath}/${a.id}/payments`,
          payBody(a.members[0], 1),
        ],
        ['get', `${agreementsPath}/${a.id}/payments`],
        ['get', `${paymentsPath}/${paid.body.id}`],
        ['post', `${paymentsPath}/${paid.body.id}/reversals`, reverseBody()],
      ];
      for (const [method, path, body] of routes) {
        const call = (m: string) =>
          (http() as unknown as Record<string, (p: string) => request.Test>)[m](
            path,
          );
        await call(method).send(body).expect(401);
        await call(method)
          .auth(actors[0].collaboratorToken, { type: 'bearer' })
          .set('x-device-id', actors[0].deviceId)
          .send(body)
          .expect(403);
      }
      expect(await activePaid(a.id, a.members[0])).toBe(100);
    });

    it('rejects an origin that does not match the selected member and device with 403', async () => {
      const a = await makeAgreement([1000]);
      await pay(a.id, a.members[0], 10, {
        createdByMemberId: randomUUID(),
      }).expect(403);
      await pay(a.id, a.members[0], 10, { deviceId: randomUUID() }).expect(403);
      const paid = await pay(a.id, a.members[0], 10).expect(201);
      await reversePayment(paid.body.id, {
        createdByMemberId: randomUUID(),
      }).expect(403);
    });
  });

  describe('concurrency', () => {
    it('serializes two simultaneous payments of 800 against 1000 pending: exactly one wins', async () => {
      for (let round = 0; round < 3; round++) {
        const a = await makeAgreement([1000]);
        const results = await Promise.all([
          pay(a.id, a.members[0], 800),
          pay(a.id, a.members[0], 800),
        ]);
        expect(results.map((r) => r.status).sort((x, y) => x - y)).toEqual([
          201, 422,
        ]);
        const loser = results.find((r) => r.status === 422)!;
        expect(loser.body).toMatchObject({
          code: 'FINANCE_PAYMENT_EXCEEDS_PENDING',
          paidMinor: 800,
          pendingMinor: 200,
        });
        expect(await activePaid(a.id, a.members[0])).toBe(800);
      }
    });

    it('never lets N parallel payments exceed the agreed amount', async () => {
      const a = await makeAgreement([1000]);
      const results = await Promise.all(
        Array.from({ length: 12 }, () => pay(a.id, a.members[0], 300)),
      );
      const statuses = results.map((r) => r.status);
      expect(statuses.filter((s) => s === 201)).toHaveLength(3);
      expect(statuses.filter((s) => s === 422)).toHaveLength(9);
      expect(await activePaid(a.id, a.members[0])).toBe(900);
      const summary = (await get(`${agreementsPath}/${a.id}/payments`)).body
        .paymentSummary;
      expect(summary).toMatchObject({
        paidMinor: 900,
        pendingMinor: 100,
        activePaymentCount: 3,
      });
    });

    it('lets different participants of one agreement pay in parallel without interference', async () => {
      const a = await makeAgreement([500, 500, 500]);
      const results = await Promise.all(
        a.members.map((m) => pay(a.id, m, 500)),
      );
      expect(results.map((r) => r.status)).toEqual([201, 201, 201]);
      expect(
        (await get(`${agreementsPath}/${a.id}/payments`)).body.paymentSummary
          .status,
      ).toBe('PAID');
    });

    it('serializes a payment racing a reversal of the same participant', async () => {
      for (let round = 0; round < 3; round++) {
        const a = await makeAgreement([1000]);
        const first = await pay(a.id, a.members[0], 600).expect(201);
        const [reversal, created] = await Promise.all([
          reversePayment(first.body.id),
          pay(a.id, a.members[0], 700),
        ]);
        expect(reversal.status).toBe(201);
        expect([201, 422]).toContain(created.status);
        // 201 only if the reversal committed first (600 reversed, 700 fits).
        expect(await activePaid(a.id, a.members[0])).toBe(
          created.status === 201 ? 700 : 0,
        );
        if (created.status === 422) expect(created.body.paidMinor).toBe(600);
      }
    });

    it('lets exactly one of two concurrent reversals of one payment win', async () => {
      const a = await makeAgreement([1000]);
      const paid = await pay(a.id, a.members[0], 300).expect(201);
      const results = await Promise.all([
        reversePayment(paid.body.id),
        reversePayment(paid.body.id),
      ]);
      expect(results.map((r) => r.status).sort((x, y) => x - y)).toEqual([
        201, 409,
      ]);
      expect(results.find((r) => r.status === 409)!.body.code).toBe(
        'FINANCE_PAYMENT_ALREADY_VOIDED',
      );
      expect(await activePaid(a.id, a.members[0])).toBe(0);
    });

    it('never records an active payment after an agreement void that raced it', async () => {
      for (let round = 0; round < 5; round++) {
        const a = await makeAgreement([1000]);
        const [paid, voided] = await Promise.all([
          pay(a.id, a.members[0], 300),
          voidAgreement(a.id),
        ]);
        expect(voided.status).toBe(201);
        expect([201, 409]).toContain(paid.status);
        const rows = await tenant(0, async () => ({
          payments: await prisma.distributionPayment.findMany({
            where: { agreementId: a.id },
          }),
          voidRow: await prisma.distributionAgreementReversal.findFirstOrThrow({
            where: { agreementId: a.id },
          }),
        }));
        if (paid.status === 409) {
          expect(paid.body.code).toBe('FINANCE_PAYMENT_AGREEMENT_VOIDED');
          expect(rows.payments).toHaveLength(0);
        } else {
          expect(rows.payments).toHaveLength(1);
          expect(rows.payments[0].receivedAt.getTime()).toBeLessThanOrEqual(
            rows.voidRow.receivedAt.getTime(),
          );
        }
      }
    });
  });

  describe('isolation of the data model', () => {
    it('hides every payment from another tenant, over HTTP and over direct SQL as the runtime role', async () => {
      const a = await makeAgreement([1000]);
      const paid = await pay(a.id, a.members[0], 100).expect(201);
      await reversePayment(paid.body.id).expect(201);
      await get(`${agreementsPath}/${a.id}/payments`, 1).expect(404);
      await get(`${paymentsPath}/${paid.body.id}`, 1).expect(404);
      await reversePayment(paid.body.id, {}, 1).expect(404);
      await pay(a.id, a.members[0], 10, {}, 1).expect(404);
      const client = new pg.Client({
        connectionString: process.env.DATABASE_URL,
      });
      await client.connect();
      try {
        for (const table of [
          'DistributionPayment',
          'DistributionPaymentReversal',
        ]) {
          const none = await client.query(
            `SELECT count(*)::int AS n FROM "${table}"`,
          );
          expect(none.rows[0].n).toBe(0);
          await client.query('BEGIN');
          await client.query("SELECT set_config('app.context_id', $1, true)", [
            contexts[1],
          ]);
          const other = await client.query(
            `SELECT count(*)::int AS n FROM "${table}" WHERE "contextId" = $1`,
            [contexts[0]],
          );
          expect(other.rows[0].n).toBe(0);
          await client.query("SELECT set_config('app.context_id', $1, true)", [
            contexts[0],
          ]);
          const own = await client.query(
            `SELECT count(*)::int AS n FROM "${table}" WHERE "contextId" = $1`,
            [contexts[0]],
          );
          expect(own.rows[0].n).toBeGreaterThan(0);
          await client.query('ROLLBACK');
        }
      } finally {
        await client.end();
      }
    });

    it('rejects UPDATE and DELETE on both tables, even for the table owner', async () => {
      const a = await makeAgreement([1000]);
      const paid = await pay(a.id, a.members[0], 100).expect(201);
      const reversal = await reversePayment(paid.body.id).expect(201);
      const statements: [string, string, string][] = [
        [
          'DistributionPayment',
          'UPDATE "DistributionPayment" SET "note" = \'tampered\' WHERE id = $1',
          paid.body.id,
        ],
        [
          'DistributionPayment',
          'DELETE FROM "DistributionPayment" WHERE id = $1',
          paid.body.id,
        ],
        [
          'DistributionPaymentReversal',
          'UPDATE "DistributionPaymentReversal" SET "reason" = \'tampered\' WHERE id = $1',
          reversal.body.reversal.id,
        ],
        [
          'DistributionPaymentReversal',
          'DELETE FROM "DistributionPaymentReversal" WHERE id = $1',
          reversal.body.reversal.id,
        ],
      ];
      for (const [, sql, id] of statements)
        await owner(contexts[0], (client) => client.query(sql, [id])).then(
          () => {
            throw new Error(`expected rejection: ${sql}`);
          },
          (error: { message: string; code?: string }) => {
            if (error.message.startsWith('expected rejection')) throw error;
            expect(error.message).toMatch(
              /distribution payments are immutable/,
            );
            expect(error.code).toBe('23001');
          },
        );
      // The runtime role is rejected too, through the application connection.
      await expect(
        tenant(0, () =>
          prisma.distributionPayment.update({
            where: { id: paid.body.id },
            data: { note: 'x' },
          }),
        ),
      ).rejects.toThrow();
      await expect(
        tenant(0, () =>
          prisma.distributionPayment.delete({ where: { id: paid.body.id } }),
        ),
      ).rejects.toThrow();
      await expect(
        tenant(0, () =>
          prisma.distributionPaymentReversal.deleteMany({
            where: { id: reversal.body.reversal.id },
          }),
        ),
      ).rejects.toThrow();
      expect(
        (await get(`${paymentsPath}/${paid.body.id}`)).body.note,
      ).toBeNull();
    });

    it('enforces the named CHECK constraints in the database', async () => {
      const a = await makeAgreement([1000]);
      const paid = await pay(a.id, a.members[0], 100).expect(201);
      const reversal = await reversePayment(paid.body.id).expect(201);
      const variant = (
        kind: 'payment' | 'reversal',
        sourceId: string,
        overrides: Record<string, unknown>,
      ) =>
        owner(contexts[0], async (client) => {
          const table =
            kind === 'payment'
              ? 'DistributionPayment'
              : 'DistributionPaymentReversal';
          const columns = COPY_COLUMNS[kind];
          const values: unknown[] = [sourceId];
          const select = columns.map((column) => {
            if (!(column in overrides)) return `"${column}"`;
            values.push(overrides[column]);
            return `$${values.length}${column === 'id' ? '::uuid' : ''}`;
          });
          await client.query(
            `INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(',')}) SELECT ${select.join(',')} FROM "${table}" WHERE id = $1`,
            values,
          );
        });
      const rejects = async (
        kind: 'payment' | 'reversal',
        sourceId: string,
        overrides: Record<string, unknown>,
        constraint: string,
      ) => {
        const error = await variant(kind, sourceId, overrides).then(
          () => null,
          (e: { constraint?: string; code?: string }) => e,
        );
        expect(error?.code).toBe('23514');
        expect(error?.constraint).toBe(constraint);
      };
      const id = () => randomUUID();
      await rejects(
        'payment',
        paid.body.id,
        { id: v7(), amountMinor: 0 },
        'DistributionPayment_amountMinor_range_check',
      );
      await rejects(
        'payment',
        paid.body.id,
        { id: v7(), amountMinor: -5 },
        'DistributionPayment_amountMinor_range_check',
      );
      await rejects(
        'payment',
        paid.body.id,
        { id: id() },
        'DistributionPayment_id_uuidv7_check',
      );
      await rejects(
        'payment',
        paid.body.id,
        { id: v7(), currency: 'mx' },
        'DistributionPayment_currency_format_check',
      );
      await rejects(
        'payment',
        paid.body.id,
        { id: v7(), note: 'n'.repeat(1001) },
        'DistributionPayment_note_length_check',
      );
      await rejects(
        'payment',
        paid.body.id,
        { id: v7(), requestFingerprint: '' },
        'DistributionPayment_requestFingerprint_check',
      );
      const rid = reversal.body.reversal.id as string;
      await rejects(
        'reversal',
        rid,
        { id: v7(), reason: '   ' },
        'DistributionPaymentReversal_reason_length_check',
      );
      await rejects(
        'reversal',
        rid,
        { id: v7(), reason: 'r'.repeat(1001) },
        'DistributionPaymentReversal_reason_length_check',
      );
      await rejects(
        'reversal',
        rid,
        { id: id() },
        'DistributionPaymentReversal_id_uuidv7_check',
      );
      await rejects(
        'reversal',
        rid,
        { id: paid.body.id },
        'DistributionPaymentReversal_id_distinct_check',
      );
      await rejects(
        'reversal',
        rid,
        { id: v7(), requestFingerprint: '' },
        'DistributionPaymentReversal_requestFingerprint_check',
      );
      // Composite FK: a payment cannot point to a member that is not a frozen participant.
      const fk = await variant('payment', paid.body.id, {
        id: v7(),
        participantMemberId: actors[0].s1,
      }).then(
        () => null,
        (e: { code?: string; constraint?: string }) => e,
      );
      expect(fk).toMatchObject({
        code: '23503',
        constraint:
          'DistributionPayment_agreementId_participantMemberId_contex_fkey',
      });
      // One reversal per payment, enforced by the database too.
      const dup = await variant('reversal', rid, { id: v7() }).then(
        () => null,
        (e: { code?: string }) => e,
      );
      expect(dup?.code).toBe('23505');
    });
  });

  describe('no side effects outside the payment tables', () => {
    it('leaves the overview, expenses and the agreement snapshot untouched', async () => {
      const a = await makeAgreement([1000, 500]);
      const snapshot = () =>
        tenant(0, async () => ({
          agreement: await prisma.distributionAgreement.findFirstOrThrow({
            where: { id: a.id },
          }),
          participants: await prisma.distributionAgreementParticipant.findMany({
            where: { agreementId: a.id },
            orderBy: { memberId: 'asc' },
          }),
          expenses: await prisma.expense.count(),
          reserves: await prisma.financeReserve.count(),
          contributions: await prisma.contribution.count(),
          shifts: await prisma.workShift.count(),
          sales: await prisma.sale.count(),
        }));
      const overview = async () =>
        (
          await get(`${base}/overview`, 0, {
            from: '2026-09-01',
            to: '2026-11-01',
          }).expect(200)
        ).body;
      const before = { snap: await snapshot(), overview: await overview() };
      const paid = await pay(a.id, a.members[0], 1000).expect(201);
      await pay(a.id, a.members[1], 200).expect(201);
      await reversePayment(paid.body.id).expect(201);
      const after = { snap: await snapshot(), overview: await overview() };
      const stable = ({
        generatedAt: _generatedAt,
        ...rest
      }: Record<string, unknown>) => rest;
      expect(stable(after.overview)).toEqual(stable(before.overview));
      expect(JSON.stringify(after.snap)).toBe(JSON.stringify(before.snap));
      expect(after.snap.expenses).toBe(0);
    });
  });
});

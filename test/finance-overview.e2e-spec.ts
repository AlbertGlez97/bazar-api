import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { v7 } from 'uuid';
import { vi } from 'vitest';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { FinanceOverviewService } from '../src/finance/finance-overview.service.js';
import { withTestTenant } from './tenant-scope.js';

describe('finance overview HTTP and tenant snapshot', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const contexts = [
    `overview-${randomUUID()}`,
    `overview-other-${randomUUID()}`,
  ];
  const actors: {
    accountId: string;
    token: string;
    memberId: string;
    collaboratorId: string;
    inactiveId: string;
    deviceId: string;
    revokedDeviceId: string;
    productId: string;
  }[] = [];
  const period = { from: '2026-10-01', to: '2026-10-02' };
  const endpoint = '/api/v1/finance/overview';
  const get = (
    index = 0,
    query: Record<string, unknown> = period,
    memberId?: string,
    deviceId?: string,
  ) =>
    request(app.getHttpServer())
      .get(endpoint)
      .auth(actors[index].token, { type: 'bearer' })
      .set('x-member-id', memberId ?? actors[index].memberId)
      .set('x-device-id', deviceId ?? actors[index].deviceId)
      .query(query);
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
            data: { contextId, name: 'Overview fixture', role, active },
          });
        const memberId = (await member('socio')).id;
        const collaboratorId = (await member('colaborador')).id;
        const inactiveId = (await member('socio', false)).id;
        const deviceId = (
          await prisma.device.create({
            data: { contextId, name: 'Overview tablet', authorized: true },
          })
        ).id;
        const revokedDeviceId = (
          await prisma.device.create({
            data: { contextId, name: 'Revoked tablet', authorized: false },
          })
        ).id;
        const productId = (
          await prisma.product.create({
            data: {
              contextId,
              name: 'Overview product',
              tipo: 'cantidad',
              unitPriceMinor: 100,
              initialStock: 100,
              stock: 100,
              purchaseCostMinor: 9999,
            },
          })
        ).id;
        return {
          memberId,
          collaboratorId,
          inactiveId,
          deviceId,
          revokedDeviceId,
          productId,
        };
      });
      actors.push({ accountId: account.id, token, ...fixture });
    }
  });
  afterAll(async () => {
    if (prisma)
      for (const contextId of contexts) {
        await withTestTenant(contextId, async () => {
          await prisma.workShiftReversal.deleteMany({ where: { contextId } });
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
          await prisma.member.deleteMany({ where: { contextId } });
        });
        await prisma.account.deleteMany({ where: { contextId } });
      }
    await app?.close();
  });
  it.each([
    {},
    { from: period.from },
    { from: '2026-02-30', to: period.to },
    { from: period.to, to: period.from },
    { ...period, surprise: 'ignored?' },
  ])('requires a strict ordered date-only query %j', async (query) => {
    await get(0, query).expect(400);
  });
  it('denies unauthenticated, non-socio, inactive, foreign and unauthorized-device contexts', async () => {
    await request(app.getHttpServer()).get(endpoint).query(period).expect(401);
    for (const memberId of [
      actors[0].collaboratorId,
      actors[0].inactiveId,
      actors[1].memberId,
    ])
      await get(0, period, memberId).expect(403);
    await get(0, period, undefined, actors[0].revokedDeviceId).expect(403);
    await get(0, period, undefined, actors[1].deviceId).expect(403);
  });
  it('separates all recorded inputs, excludes reversed/rejected/outside facts and ignores receivedAt and current product cost', async () => {
    for (let index = 0; index < 2; index++)
      await withTestTenant(contexts[index], async () => {
        const actor = actors[index];
        const contextId = contexts[index];
        const origin = {
          contextId,
          createdByMemberId: actor.memberId,
          createdByAccountId: actor.accountId,
          deviceId: actor.deviceId,
          requestFingerprint: randomUUID(),
          creationResponse: {},
        };
        const at = new Date('2026-10-01T06:00:00Z');
        const laterReceived = new Date('2026-11-01T12:00:00Z');
        const sale = (
          occurredAt: Date,
          status: 'completada' | 'rechazada_por_conflicto',
          totalMinor: number,
          items: {
            quantity: number;
            subtotalMinor: number;
            unitCostMinor: number | null;
          }[],
        ) =>
          prisma.sale.create({
            data: {
              id: v7(),
              contextId,
              memberId: actor.memberId,
              deviceId: actor.deviceId,
              occurredAt,
              receivedAt: laterReceived,
              status,
              totalMinor,
              cashReceivedMinor: totalMinor,
              items: {
                create: items.map((item) => ({
                  ...item,
                  unitPriceMinor: 100,
                  productId: actor.productId,
                  contextId,
                })),
              },
            },
          });
        await sale(at, 'completada', index ? 9000 : 1000, [
          { quantity: 2, subtotalMinor: 400, unitCostMinor: 100 },
          { quantity: 1, subtotalMinor: 100, unitCostMinor: 0 },
          { quantity: 3, subtotalMinor: 500, unitCostMinor: null },
        ]);
        await sale(new Date('2026-10-02T05:59:59.999Z'), 'completada', 100, [
          { quantity: 1, subtotalMinor: 100, unitCostMinor: 200 },
        ]);
        await sale(
          new Date('2026-10-01T05:59:59.999Z'),
          'completada',
          10000,
          [],
        );
        await sale(new Date('2026-10-02T06:00:00Z'), 'completada', 10000, []);
        await sale(at, 'rechazada_por_conflicto', 10000, []);
        const expense = (
          nature: string,
          amountMinor: number,
          occurredAt = at,
        ) =>
          prisma.expense.create({
            data: {
              ...origin,
              id: v7(),
              nature,
              amountMinor,
              occurredAt,
              receivedAt: laterReceived,
              category:
                nature === 'INVENTORY_PURCHASE' ? 'inventory' : 'transport',
              description: 'Overview expense',
              paidByMemberId: actor.memberId,
              fundsSource: 'BUSINESS',
            },
          });
        await expense('OPERATING_EXPENSE', 1100);
        await expense('INVENTORY_PURCHASE', 5000);
        await expense(
          'OPERATING_EXPENSE',
          9999,
          new Date('2026-10-02T06:00:00Z'),
        );
        const reversedExpense = await expense('OPERATING_EXPENSE', 9999);
        await prisma.expenseReversal.create({
          data: {
            ...origin,
            id: v7(),
            expenseId: reversedExpense.id,
            reason: 'Correction',
            occurredAt: at,
          },
        });
        const contribution = (occurredAt = at) =>
          prisma.contribution.create({
            data: {
              ...origin,
              id: v7(),
              memberId: actor.memberId,
              amountMinor: 10000,
              occurredAt,
              receivedAt: laterReceived,
            },
          });
        await contribution();
        await contribution(new Date('2026-10-02T06:00:00Z'));
        const reversedContribution = await contribution();
        await prisma.contributionReversal.create({
          data: {
            ...origin,
            id: v7(),
            contributionId: reversedContribution.id,
            reason: 'Correction',
            occurredAt: at,
          },
        });
        const shift = (
          minutes: number | null,
          workDate = new Date('2026-10-01T00:00:00Z'),
        ) =>
          prisma.workShift.create({
            data: {
              ...origin,
              id: v7(),
              memberId: actor.memberId,
              workDate,
              minutes,
              receivedAt: laterReceived,
            },
          });
        await shift(60);
        await shift(null);
        await shift(999, new Date('2026-10-02T00:00:00Z'));
        const reversedShift = await shift(999);
        await prisma.workShiftReversal.create({
          data: {
            ...origin,
            id: v7(),
            workShiftId: reversedShift.id,
            reason: 'Correction',
            occurredAt: at,
          },
        });
      });
    const response = await get().expect(200);
    expect(response.body.sales).toEqual({
      saleCount: 2,
      salesMinor: 1100,
      recordedCostMinor: 400,
      recordedGrossMarginMinor: 700,
    });
    expect(response.body.costCoverage).toEqual({
      status: 'partial',
      totalLineCount: 4,
      knownCostLineCount: 3,
      missingCostLineCount: 1,
      missingCostUnitCount: 3,
      salesWithoutCostMinor: 500,
      knownCostLinePercentage: 75,
    });
    expect(response.body.expenses).toEqual({
      operatingMinor: 1100,
      inventoryPurchasesMinor: 5000,
    });
    expect(response.body.contributions).toEqual({
      amountMinor: 10000,
      count: 1,
    });
    expect(response.body.workShifts).toEqual({
      shiftCount: 2,
      knownMinutes: 60,
      unknownDurationCount: 1,
    });
    expect(response.body.result).toMatchObject({
      recordedOperatingResultMinor: -400,
      potentiallyAvailableMinor: -400,
      status: 'partial',
      isCashBalance: false,
      isWithdrawableProfit: false,
    });
    expect(response.body.generatedAt).toMatch(/Z$/);
    expect((await get(1).expect(200)).body.sales.salesMinor).toBe(9100);
    const empty = await get(0, { from: '2030-01-01', to: '2030-01-02' }).expect(
      200,
    );
    expect(empty.body.result).toMatchObject({
      status: 'complete',
      potentiallyAvailableMinor: 0,
    });
    expect(empty.body.costCoverage.knownCostLinePercentage).toBeNull();
  });
  it('runs the extended transaction on one repeatable-read tenant connection', async () => {
    const original = prisma.$transaction.bind(prisma);
    const evidence: {
      isolation: string;
      tenant: string;
      transactionId: string;
    }[] = [];
    const spy = vi.spyOn(prisma, '$transaction').mockImplementation(
      async (fn: unknown, options?: unknown) =>
        original(
          async (tx) => {
            const inspect = async () => {
              const rows = await tx.$queryRaw<
                { isolation: string; tenant: string; transactionId: string }[]
              >`SELECT current_setting('transaction_isolation') AS isolation, current_setting('app.context_id') AS tenant, txid_current()::text AS "transactionId"`;
              evidence.push(rows[0]);
            };
            await inspect();
            const result = await (
              fn as (client: typeof tx) => Promise<unknown>
            )(tx);
            await inspect();
            return result;
          },
          options as { isolationLevel: 'RepeatableRead' },
        ) as never,
    );
    try {
      await withTestTenant(contexts[0], () =>
        app.get(FinanceOverviewService).overview(contexts[0], period),
      );
      expect(evidence).toHaveLength(2);
      expect(evidence[0]).toEqual(evidence[1]);
      expect(evidence[0]).toMatchObject({
        isolation: 'repeatable read',
        tenant: contexts[0],
      });
    } finally {
      spy.mockRestore();
    }
  });
});

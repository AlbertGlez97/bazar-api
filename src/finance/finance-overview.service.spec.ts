import { vi } from 'vitest';
import { FinanceOverviewService } from './finance-overview.service.js';
import type { PrismaService } from '../database/prisma.service.js';
const period = { from: '2026-10-01', to: '2026-10-02' };
function setup() {
  const tx = {
    sale: { findMany: vi.fn().mockResolvedValue([]) },
    expense: { findMany: vi.fn().mockResolvedValue([]) },
    contribution: { findMany: vi.fn().mockResolvedValue([]) },
    workShift: { findMany: vi.fn().mockResolvedValue([]) },
  };
  const transaction = vi.fn(
    async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
  );
  const service = new FinanceOverviewService({
    $transaction: transaction,
  } as unknown as PrismaService);
  return { service, tx, transaction };
}
describe('recorded finance overview', () => {
  it('uses one repeatable-read snapshot with economic half-open boundaries and active inputs', async () => {
    const { service, tx, transaction } = setup();
    const result = await service.overview('tenant', period);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'RepeatableRead',
    });
    const occurredAt = {
      gte: new Date('2026-10-01T06:00:00Z'),
      lt: new Date('2026-10-02T06:00:00Z'),
    };
    expect(tx.sale.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { contextId: 'tenant', status: 'completada', occurredAt },
      }),
    );
    for (const model of [tx.expense, tx.contribution])
      expect(model.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { contextId: 'tenant', occurredAt, reversal: { is: null } },
        }),
      );
    expect(tx.workShift.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          contextId: 'tenant',
          reversal: { is: null },
          workDate: {
            gte: new Date('2026-10-01T00:00:00Z'),
            lt: new Date('2026-10-02T00:00:00Z'),
          },
        },
      }),
    );
    expect(result.costCoverage).toEqual({
      status: 'complete',
      totalLineCount: 0,
      knownCostLineCount: 0,
      missingCostLineCount: 0,
      missingCostUnitCount: 0,
      salesWithoutCostMinor: 0,
      knownCostLinePercentage: null,
    });
    expect(result.result).toEqual({
      recordedOperatingResultMinor: 0,
      potentiallyAvailableMinor: 0,
      status: 'complete',
      isCashBalance: false,
      isWithdrawableProfit: false,
    });
    expect(result.reserves).toEqual({
      activeCount: 0,
      plannedMinor: 0,
      matching: 'EXACT_PERIOD',
    });
    expect(result.period).toMatchObject({
      ...period,
      fromInstant: '2026-10-01T06:00:00.000Z',
      toInstant: '2026-10-02T06:00:00.000Z',
      utcOffsetMinutes: -360,
      interval: '[from,to)',
    });
  });
  it('includes all sales revenue, known zero costs, and exposes unknown cost without reconstructing it', async () => {
    const { service, tx } = setup();
    tx.sale.findMany.mockResolvedValue([
      {
        totalMinor: 1000,
        items: [
          { quantity: 2, unitCostMinor: 100, subtotalMinor: 400 },
          { quantity: 1, unitCostMinor: 0, subtotalMinor: 100 },
          { quantity: 3, unitCostMinor: null, subtotalMinor: 500 },
        ],
      },
    ] as never);
    tx.expense.findMany.mockResolvedValue([
      { nature: 'OPERATING_EXPENSE', amountMinor: 1100 },
      { nature: 'INVENTORY_PURCHASE', amountMinor: 5000 },
    ] as never);
    tx.contribution.findMany.mockResolvedValue([
      { amountMinor: 10000 },
    ] as never);
    tx.workShift.findMany.mockResolvedValue([
      { minutes: 60 },
      { minutes: null },
    ] as never);
    const result = await service.overview('tenant', period);
    expect(result.sales).toEqual({
      saleCount: 1,
      salesMinor: 1000,
      recordedCostMinor: 200,
      recordedGrossMarginMinor: 800,
    });
    expect(result.costCoverage).toMatchObject({
      status: 'partial',
      totalLineCount: 3,
      knownCostLineCount: 2,
      missingCostLineCount: 1,
      missingCostUnitCount: 3,
      salesWithoutCostMinor: 500,
      knownCostLinePercentage: (2 / 3) * 100,
    });
    expect(result.expenses).toEqual({
      operatingMinor: 1100,
      inventoryPurchasesMinor: 5000,
    });
    expect(result.contributions).toEqual({ amountMinor: 10000, count: 1 });
    expect(result.workShifts).toEqual({
      shiftCount: 2,
      knownMinutes: 60,
      unknownDurationCount: 1,
    });
    expect(result.result).toMatchObject({
      recordedOperatingResultMinor: -300,
      potentiallyAvailableMinor: -300,
      status: 'partial',
    });
    expect(result.warnings.map((w) => w.code)).toContain('MISSING_SALE_COST');
    expect(result.sync).toEqual({
      source: 'SERVER_CONFIRMED',
      localPendingIncluded: false,
    });
  });
  it.each([
    { from: '2026-10-02', to: '2026-10-01' },
    { from: '2026-10-01', to: '2026-10-01' },
    { from: '2026-02-30', to: '2026-03-01' },
  ])('rejects bad ranges before querying %j', async (query) => {
    const { service, transaction } = setup();
    await expect(service.overview('tenant', query)).rejects.toThrow();
    expect(transaction).not.toHaveBeenCalled();
  });
  it('fails explicitly instead of serializing unsafe monetary arithmetic', async () => {
    const { service, tx } = setup();
    tx.sale.findMany.mockResolvedValue([
      {
        totalMinor: 1,
        items: [
          { quantity: 2147483647, unitCostMinor: 2147483647, subtotalMinor: 1 },
        ],
      },
    ] as never);
    await expect(service.overview('tenant', period)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'FINANCE_OVERVIEW_OVERFLOW' }),
    });
  });
  it('preserves early calendar years instead of Date.UTC century remapping', async () => {
    const { service } = setup();
    const result = await service.overview('tenant', {
      from: '0004-02-29',
      to: '0004-03-01',
    });
    expect(result.period.fromInstant).toBe('0004-02-29T06:00:00.000Z');
    expect(result.period.toInstant).toBe('0004-03-01T06:00:00.000Z');
  });
  it('preserves a known-cost negative result without marking coverage partial', async () => {
    const { service, tx } = setup();
    tx.sale.findMany.mockResolvedValue([
      {
        totalMinor: 100,
        items: [{ quantity: 2, unitCostMinor: 200, subtotalMinor: 100 }],
      },
    ] as never);
    const result = await service.overview('tenant', period);
    expect(result.result).toMatchObject({
      recordedOperatingResultMinor: -300,
      potentiallyAvailableMinor: -300,
      status: 'complete',
    });
    expect(result.costCoverage.knownCostLinePercentage).toBe(100);
    expect(result.warnings.map((w) => w.code)).not.toContain(
      'MISSING_SALE_COST',
    );
  });
  it('guards sums and underflow at the JSON boundary', async () => {
    const { service, tx } = setup();
    tx.contribution.findMany.mockResolvedValue([
      { amountMinor: Number.MAX_SAFE_INTEGER },
      { amountMinor: 1 },
    ] as never);
    await expect(service.overview('tenant', period)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'FINANCE_OVERVIEW_OVERFLOW' }),
    });
    tx.contribution.findMany.mockResolvedValue([]);
    tx.sale.findMany.mockResolvedValue([
      { totalMinor: Number.MIN_SAFE_INTEGER, items: [] },
    ] as never);
    tx.expense.findMany.mockResolvedValue([
      { nature: 'OPERATING_EXPENSE', amountMinor: 1 },
    ] as never);
    await expect(service.overview('tenant', period)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'FINANCE_OVERVIEW_OVERFLOW' }),
    });
  });
  it('fails closed on a null completed total or unrecognized expense nature', async () => {
    const { service, tx } = setup();
    tx.sale.findMany.mockResolvedValue([
      { totalMinor: null, items: [] },
    ] as never);
    await expect(service.overview('tenant', period)).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'FINANCE_OVERVIEW_INVALID_RECORDED_SALE',
      }),
    });
    tx.sale.findMany.mockResolvedValue([]);
    tx.expense.findMany.mockResolvedValue([
      { nature: 'UNKNOWN', amountMinor: 1 },
    ] as never);
    await expect(service.overview('tenant', period)).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'FINANCE_OVERVIEW_INVALID_EXPENSE_NATURE',
      }),
    });
  });
});

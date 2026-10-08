import {
  BadRequestException,
  Inject,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import {
  parseRangeBoundary,
  BUSINESS_TZ_OFFSET_MINUTES,
} from '../common/business-time.js';
import { isCalendarDate } from './work-shift.dto.js';
import type { FinanceOverviewDto } from './finance-overview.dto.js';

// BigInt preserves exact products and sums before the JSON number boundary.
function safeNumber(value: bigint): number {
  if (
    value > BigInt(Number.MAX_SAFE_INTEGER) ||
    value < BigInt(Number.MIN_SAFE_INTEGER)
  )
    throw new UnprocessableEntityException({
      code: 'FINANCE_OVERVIEW_OVERFLOW',
      message: 'Recorded totals exceed the safe integer range',
    });
  return Number(value);
}
function businessStart(value: string): Date {
  const instant = parseRangeBoundary(value, 'start');
  // Date.UTC maps years 01-99 to 1901-1999; preserve the validated calendar year.
  instant.setUTCFullYear(Number(value.slice(0, 4)));
  return instant;
}
@Injectable()
export class FinanceOverviewService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}
  async overview(contextId: string, query: FinanceOverviewDto) {
    const { from, to } = query;
    if (!isCalendarDate(from) || !isCalendarDate(to) || from >= to)
      throw new BadRequestException(
        'from and to must be valid YYYY-MM-DD dates with from preceding to',
      );
    return this.prisma.$transaction(
      // The injected tenant extension forwards isolation options and sets RLS
      // on this connection before executing this callback. Never use array transactions.
      (tx) => this.compute(tx, contextId, from, to),
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
  /**
   * Pure read model over one transaction client. Callers own the transaction
   * (tenant context + RepeatableRead) and must pass validated, ordered dates.
   */
  async compute(
    tx: Prisma.TransactionClient,
    contextId: string,
    from: string,
    to: string,
  ) {
    const fromInstant = businessStart(from);
    const toInstant = businessStart(to);
    const occurredAt = { gte: fromInstant, lt: toInstant };
    const sales = await tx.sale.findMany({
      where: { contextId, status: 'completada', occurredAt },
      select: {
        totalMinor: true,
        items: {
          select: {
            quantity: true,
            unitCostMinor: true,
            subtotalMinor: true,
          },
        },
      },
    });
    const expenses = await tx.expense.findMany({
      where: { contextId, occurredAt, reversal: { is: null } },
      select: { nature: true, amountMinor: true },
    });
    const contributions = await tx.contribution.findMany({
      where: { contextId, occurredAt, reversal: { is: null } },
      select: { amountMinor: true },
    });
    const shifts = await tx.workShift.findMany({
      where: {
        contextId,
        reversal: { is: null },
        workDate: {
          gte: new Date(from + 'T00:00:00.000Z'),
          lt: new Date(to + 'T00:00:00.000Z'),
        },
      },
      select: { minutes: true },
    });
    const reserves = await tx.financeReserve.findMany({
      where: {
        contextId,
        periodFrom: new Date(from + 'T00:00:00.000Z'),
        periodTo: new Date(to + 'T00:00:00.000Z'),
        reversal: { is: null },
      },
      select: { amountMinor: true },
    });
    const plannedMinor = reserves.reduce(
      (sum, row) => sum + BigInt(row.amountMinor),
      0n,
    );
    let salesMinor = 0n,
      costMinor = 0n,
      missingUnits = 0n,
      uncostedRevenue = 0n;
    let totalLines = 0,
      knownLines = 0;
    for (const sale of sales) {
      if (sale.totalMinor === null)
        throw new UnprocessableEntityException({
          code: 'FINANCE_OVERVIEW_INVALID_RECORDED_SALE',
          message: 'A completed sale has no recorded total',
        });
      salesMinor += BigInt(sale.totalMinor);
      for (const item of sale.items) {
        totalLines++;
        if (item.unitCostMinor === null) {
          missingUnits += BigInt(item.quantity);
          uncostedRevenue += BigInt(item.subtotalMinor);
        } else {
          knownLines++;
          costMinor += BigInt(item.unitCostMinor) * BigInt(item.quantity);
        }
      }
    }
    let operating = 0n,
      inventory = 0n;
    for (const expense of expenses) {
      if (expense.nature === 'OPERATING_EXPENSE')
        operating += BigInt(expense.amountMinor);
      else if (expense.nature === 'INVENTORY_PURCHASE')
        inventory += BigInt(expense.amountMinor);
      else
        throw new UnprocessableEntityException({
          code: 'FINANCE_OVERVIEW_INVALID_EXPENSE_NATURE',
          message: 'An active expense has an unsupported nature',
        });
    }
    const contributionMinor = contributions.reduce(
      (sum, row) => sum + BigInt(row.amountMinor),
      0n,
    );
    const knownMinutes = shifts.reduce(
      (sum, row) => sum + BigInt(row.minutes ?? 0),
      0n,
    );
    const missingLines = totalLines - knownLines;
    const status = missingLines ? ('partial' as const) : ('complete' as const);
    const grossMargin = salesMinor - costMinor;
    const operatingResult = grossMargin - operating;
    const warnings = [
      ...(missingLines
        ? [
            {
              code: 'MISSING_SALE_COST',
              message:
                'Some sold lines have no recorded cost; downstream results are partial.',
            },
          ]
        : []),
      {
        code: 'SYNC_TIME_COST_NO_LOT_VALUATION',
        message:
          'Sale costs are snapshots captured when processed by the server, not historical lot valuations.',
      },
      {
        code: 'NOT_CASH_OR_WITHDRAWABLE_PROFIT',
        message:
          'Cash, commitments, capital recovery and compensation are not reconciled.',
      },
    ];
    return {
      currency: 'MXN',
      period: {
        from,
        to,
        fromInstant: fromInstant.toISOString(),
        toInstant: toInstant.toISOString(),
        utcOffsetMinutes: BUSINESS_TZ_OFFSET_MINUTES,
        interval: '[from,to)',
      },
      timeBasis: {
        sales: 'occurredAt',
        expenses: 'occurredAt',
        contributions: 'occurredAt',
        workShifts: 'workDate',
        reserves: 'exactPeriod',
      },
      sales: {
        saleCount: sales.length,
        salesMinor: safeNumber(salesMinor),
        recordedCostMinor: safeNumber(costMinor),
        recordedGrossMarginMinor: safeNumber(grossMargin),
      },
      costCoverage: {
        status,
        totalLineCount: totalLines,
        knownCostLineCount: knownLines,
        missingCostLineCount: missingLines,
        missingCostUnitCount: safeNumber(missingUnits),
        salesWithoutCostMinor: safeNumber(uncostedRevenue),
        knownCostLinePercentage: totalLines
          ? (knownLines / totalLines) * 100
          : null,
      },
      expenses: {
        operatingMinor: safeNumber(operating),
        inventoryPurchasesMinor: safeNumber(inventory),
      },
      contributions: {
        amountMinor: safeNumber(contributionMinor),
        count: contributions.length,
      },
      workShifts: {
        shiftCount: shifts.length,
        knownMinutes: safeNumber(knownMinutes),
        unknownDurationCount: shifts.filter((row) => row.minutes === null)
          .length,
      },
      reserves: {
        activeCount: reserves.length,
        plannedMinor: safeNumber(plannedMinor),
        matching: 'EXACT_PERIOD',
      },
      result: {
        recordedOperatingResultMinor: safeNumber(operatingResult),
        potentiallyAvailableMinor: safeNumber(operatingResult - plannedMinor),
        status,
        isCashBalance: false,
        isWithdrawableProfit: false,
      },
      sync: { source: 'SERVER_CONFIRMED', localPendingIncluded: false },
      warnings,
      generatedAt: new Date().toISOString(),
    };
  }
}

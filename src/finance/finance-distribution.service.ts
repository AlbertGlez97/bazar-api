import {
  BadRequestException,
  Inject,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import {
  allocateByWeight,
  allocateEqual,
  splitPools,
} from './finance-distribution.allocation.js';
import type { FinanceDistributionSimulationDto } from './finance-distribution.dto.js';
import { FinanceOverviewService } from './finance-overview.service.js';
import { isCalendarDate } from './work-shift.dto.js';

export const DISTRIBUTION_ERRORS = {
  exceedsAvailable: 'FINANCE_DISTRIBUTION_EXCEEDS_AVAILABLE',
  noWork: 'FINANCE_DISTRIBUTION_NO_WORK',
  noPartners: 'FINANCE_DISTRIBUTION_NO_PARTNERS',
} as const;

interface Warning {
  code: string;
  message: string;
}
interface WorkAggregate {
  shiftCount: number;
  knownMinutes: number;
  unknownDurationCount: number;
}

/**
 * Pure simulation: reads one RepeatableRead tenant snapshot and writes nothing.
 * The financial base comes from the overview computation of the same period, so
 * reserves are already deducted and must never be subtracted again.
 */
@Injectable()
export class FinanceDistributionService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(FinanceOverviewService)
    private readonly overview: FinanceOverviewService,
  ) {}

  async simulate(contextId: string, dto: FinanceDistributionSimulationDto) {
    const { from, to } = dto;
    if (!isCalendarDate(from) || !isCalendarDate(to) || from >= to)
      throw new BadRequestException(
        'from and to must be valid YYYY-MM-DD dates with from preceding to',
      );
    return this.prisma.$transaction(
      async (tx) => {
        const base = await this.overview.compute(tx, contextId, from, to);
        const available = base.result.potentiallyAvailableMinor;
        const requested = dto.requestedAmountMinor;
        if (requested > available)
          throw new UnprocessableEntityException({
            code: DISTRIBUTION_ERRORS.exceedsAvailable,
            message:
              available > 0
                ? 'The requested amount exceeds the potentially available amount of the period'
                : 'The period has no potentially available amount to distribute',
          });

        const workDate = {
          gte: new Date(from + 'T00:00:00.000Z'),
          lt: new Date(to + 'T00:00:00.000Z'),
        };
        const activeShifts = {
          contextId,
          reversal: { is: null },
          workDate,
        };
        const grouped = await tx.workShift.groupBy({
          by: ['memberId'],
          where: activeShifts,
          _count: { _all: true },
          _sum: { minutes: true },
        });
        const unknown = await tx.workShift.groupBy({
          by: ['memberId'],
          where: { ...activeShifts, minutes: null },
          _count: { _all: true },
        });
        const work = new Map<string, WorkAggregate>();
        for (const row of grouped)
          work.set(row.memberId, {
            shiftCount: row._count._all,
            knownMinutes: row._sum.minutes ?? 0,
            unknownDurationCount: 0,
          });
        for (const row of unknown)
          work.get(row.memberId)!.unknownDurationCount = row._count._all;

        const members = await tx.member.findMany({
          where: {
            contextId,
            OR: [
              { role: 'socio', active: true },
              { id: { in: [...work.keys()] } },
            ],
          },
          select: { id: true, name: true, role: true, active: true },
        });

        const { partnerPoolMinor, workPoolMinor } = splitPools(
          BigInt(requested),
          BigInt(dto.partnerShareBps),
        );
        const partnerIds = members
          .filter((member) => member.role === 'socio' && member.active)
          .map((member) => member.id);
        if (dto.partnerShareBps > 0 && partnerIds.length === 0)
          throw new UnprocessableEntityException({
            code: DISTRIBUTION_ERRORS.noPartners,
            message:
              'There are no active socios eligible for the partner share',
          });

        const unitsOf = (aggregate: WorkAggregate) =>
          BigInt(
            dto.workBasis === 'WORK_SHIFTS'
              ? aggregate.shiftCount
              : aggregate.knownMinutes,
          );
        const weights = [...work.entries()].map(([id, aggregate]) => ({
          id,
          weight: unitsOf(aggregate),
        }));
        const totalUnits = weights.reduce((sum, w) => sum + w.weight, 0n);
        if (dto.workShareBps > 0 && totalUnits === 0n)
          throw new UnprocessableEntityException({
            code: DISTRIBUTION_ERRORS.noWork,
            message:
              work.size > 0
                ? 'All shifts of the period lack a known duration, so KNOWN_MINUTES has no work to weigh'
                : 'No active work shifts are registered in the period',
          });

        const partnerAmounts = new Map(
          allocateEqual(partnerPoolMinor, partnerIds).map((row) => [
            row.id,
            row.amount,
          ]),
        );
        const workAmounts = new Map(
          (totalUnits === 0n
            ? weights.map((w) => ({ id: w.id, amount: 0n }))
            : allocateByWeight(workPoolMinor, weights)
          ).map((row) => [row.id, row.amount]),
        );

        const rows = members
          .filter(
            (member) => partnerIds.includes(member.id) || work.has(member.id),
          )
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
          .map((member) => {
            const aggregate = work.get(member.id);
            const partnerAmount = partnerAmounts.get(member.id) ?? 0n;
            const workAmount = workAmounts.get(member.id) ?? 0n;
            return {
              memberId: member.id,
              name: member.name,
              role: member.role,
              isActive: member.active,
              partnerEligible: partnerIds.includes(member.id),
              partnerAmountMinor: Number(partnerAmount),
              workUnits: aggregate ? Number(unitsOf(aggregate)) : 0,
              shiftCount: aggregate?.shiftCount ?? 0,
              knownMinutes: aggregate?.knownMinutes ?? 0,
              unknownDurationCount: aggregate?.unknownDurationCount ?? 0,
              workAmountMinor: Number(workAmount),
              totalMinor: Number(partnerAmount + workAmount),
            };
          });
        const distributed = rows.reduce((sum, row) => sum + row.totalMinor, 0);
        if (distributed !== requested)
          throw new Error('Simulated distribution does not add up');

        return {
          period: base.period,
          simulation: true as const,
          persisted: false as const,
          currency: base.currency,
          financialBase: {
            potentiallyAvailableMinor: available,
            requestedAmountMinor: requested,
            remainingAvailableMinor: available - requested,
            status: base.result.status,
          },
          rule: {
            partnerShareBps: dto.partnerShareBps,
            workShareBps: dto.workShareBps,
            workBasis: dto.workBasis,
            partnerMode: 'EQUAL' as const,
          },
          pools: {
            partnerPoolMinor: Number(partnerPoolMinor),
            workPoolMinor: Number(workPoolMinor),
          },
          members: rows,
          totals: {
            distributedMinor: distributed,
            undistributedMinor: requested - distributed,
          },
          warnings: this.warnings(base, dto, partnerPoolMinor, rows, work),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  private warnings(
    base: Awaited<ReturnType<FinanceOverviewService['compute']>>,
    dto: FinanceDistributionSimulationDto,
    partnerPoolMinor: bigint,
    rows: { isActive: boolean; workAmountMinor: number }[],
    work: Map<string, WorkAggregate>,
  ): Warning[] {
    const warnings: Warning[] = [
      {
        code: 'SIMULATION_ONLY',
        message:
          'This is a simulation. Nothing was saved and no figure here is a recorded decision.',
      },
      {
        code: 'NOT_A_PAYMENT_OR_OBLIGATION',
        message:
          'Simulated amounts are not payments, withdrawals, debts or obligations.',
      },
    ];
    if (base.result.status === 'partial') {
      warnings.push({
        code: 'OPERATING_RESULT_PARTIAL',
        message:
          'The operating result is partial because some sold lines have no recorded cost; the available amount may be overstated.',
      });
      const missing = base.warnings.find((w) => w.code === 'MISSING_SALE_COST');
      if (missing)
        warnings.push({ code: missing.code, message: missing.message });
    }
    if (partnerPoolMinor > 0n)
      warnings.push({
        code: 'PARTNER_ELIGIBILITY_IS_CURRENT_STATE',
        message:
          'Partner eligibility uses the current active socios; membership history is not tracked.',
      });
    const unknownShifts = [...work.values()].reduce(
      (sum, aggregate) => sum + aggregate.unknownDurationCount,
      0,
    );
    if (dto.workBasis === 'KNOWN_MINUTES' && unknownShifts > 0)
      warnings.push({
        code: 'WORK_SHIFTS_WITHOUT_DURATION',
        message: `${unknownShifts} work shift(s) have no known duration and weigh 0 under KNOWN_MINUTES.`,
      });
    if (rows.some((row) => !row.isActive && row.workAmountMinor > 0))
      warnings.push({
        code: 'INACTIVE_MEMBER_RECEIVES_WORK_AMOUNT',
        message:
          'An inactive member has registered work in the period and receives a simulated work amount.',
      });
    return warnings;
  }
}

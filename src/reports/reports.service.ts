import { Inject, Injectable } from '@nestjs/common';
import { parseRangeBoundary } from '../common/business-time.js';
import { PrismaService } from '../database/prisma.service.js';
import type { DateRangeQueryDto } from './dto/date-range.dto.js';

/**
 * Two intentionally minimal, read-only sales reports for socios: total
 * sold in a period, and the same total broken down per Member. Both only
 * ever count `status: 'completada'` sales — a `rechazada_por_conflicto`
 * sale never affected inventory or cash and must not appear to have
 * generated revenue in a report, and a sale is never "partially"
 * completed (see SalesService), so there is no partial-credit case to
 * account for.
 */
@Injectable()
export class ReportsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  private range(query: DateRangeQueryDto) {
    return {
      from: parseRangeBoundary(query.from, 'start'),
      to: parseRangeBoundary(query.to, 'end'),
    };
  }

  /**
   * Total sold (sum of `totalMinor`) across every completed sale in the
   * context during the given period, regardless of who sold it.
   */
  async salesByPeriod(contextId: string, query: DateRangeQueryDto) {
    const { from, to } = this.range(query);
    const [agg, saleCount] = await this.prisma.$transaction([
      this.prisma.sale.aggregate({
        where: {
          status: 'completada',
          member: { contextId },
          receivedAt: { gte: from, lte: to },
        },
        _sum: { totalMinor: true },
      }),
      this.prisma.sale.count({
        where: {
          status: 'completada',
          member: { contextId },
          receivedAt: { gte: from, lte: to },
        },
      }),
    ]);
    return {
      from,
      to,
      totalSoldMinor: agg._sum.totalMinor ?? 0,
      saleCount,
    };
  }

  /**
   * Total sold per Member (socio or colaborador — a socio can and does
   * also register sales at the counter) during the given period.
   * Members with zero completed sales in the period are simply absent
   * from the list rather than shown with a zero row, since the list is
   * meant to answer "who sold what", not enumerate every Member that
   * exists.
   */
  async salesByMember(contextId: string, query: DateRangeQueryDto) {
    const { from, to } = this.range(query);
    const grouped = await this.prisma.sale.groupBy({
      by: ['memberId'],
      where: {
        status: 'completada',
        member: { contextId },
        receivedAt: { gte: from, lte: to },
      },
      _sum: { totalMinor: true },
    });
    const members = await this.prisma.member.findMany({
      where: { id: { in: grouped.map((g) => g.memberId) } },
    });
    const items = grouped.map((g) => {
      const member = members.find((m) => m.id === g.memberId);
      return {
        memberId: g.memberId,
        memberName: member?.name ?? null,
        role: member?.role ?? null,
        totalSoldMinor: g._sum.totalMinor ?? 0,
      };
    });
    items.sort((a, b) => b.totalSoldMinor - a.totalSoldMinor);
    return { from, to, items };
  }
}

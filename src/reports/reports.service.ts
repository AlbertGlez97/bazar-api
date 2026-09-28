import { Inject, Injectable } from '@nestjs/common';
import { add, multiply, subtract } from 'dinero.js';
import { parseRangeBoundary } from '../common/business-time.js';
import { toDinero, toMinorUnits } from '../common/money.js';
import { computeProfitTotals } from '../common/profit-totals.js';
import { PrismaService } from '../database/prisma.service.js';
import type { DateRangeQueryDto } from './dto/date-range.dto.js';
import type { SalesDetailQueryDto } from './dto/sales-detail-query.dto.js';

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

  /**
   * Per (product, member) revenue/profit breakdown for the period (BE-13,
   * D1/D2). Built from every matching `SaleItem` (never a raw-SQL
   * aggregate, matching this module's convention), reduced in application
   * code into one row per (productId, memberId) pair, sorted by revenue
   * descending, then paginated in memory over the already-aggregated rows
   * — not over the raw SaleItems, which are fetched unpaginated for the
   * whole period.
   *
   * A row's `gananciaMinor` is only ever a complete number: it is `null`
   * (and `gananciaDisponible: false`) the moment *any* SaleItem folded into
   * that row lacks `unitCostMinor`, rather than a partial sum of the known
   * subset — a partial sum would look complete while silently hiding part
   * of the picture, which is exactly what "never estimate" is meant to
   * prevent. The period `totals`, by contrast, sum profit over the
   * *individual* SaleItems that do have a cost and separately report
   * `lineasSinCosto`, so a socio sees both a real number for what is known
   * and an honest count of what is missing.
   */
  async salesDetail(contextId: string, query: SalesDetailQueryDto) {
    const { from, to } = this.range(query);
    const saleItems = await this.prisma.saleItem.findMany({
      where: {
        sale: {
          status: 'completada',
          member: { contextId },
          receivedAt: { gte: from, lte: to },
        },
      },
      select: {
        productId: true,
        quantity: true,
        subtotalMinor: true,
        unitCostMinor: true,
        product: { select: { name: true } },
        sale: {
          select: { memberId: true, member: { select: { name: true } } },
        },
      },
    });

    type Row = {
      productId: string;
      productName: string;
      memberId: string;
      memberName: string | null;
      units: number;
      ingreso: ReturnType<typeof toDinero>;
      costo: ReturnType<typeof toDinero>;
      allCosted: boolean;
    };
    const groups = new Map<string, Row>();
    for (const item of saleItems) {
      const key = `${item.productId}:${item.sale.memberId}`;
      let row = groups.get(key);
      if (!row) {
        row = {
          productId: item.productId,
          productName: item.product.name,
          memberId: item.sale.memberId,
          memberName: item.sale.member?.name ?? null,
          units: 0,
          ingreso: toDinero(0),
          costo: toDinero(0),
          allCosted: true,
        };
        groups.set(key, row);
      }
      row.units += item.quantity;
      row.ingreso = add(row.ingreso, toDinero(item.subtotalMinor));
      if (item.unitCostMinor === null) {
        row.allCosted = false;
      } else {
        row.costo = add(
          row.costo,
          multiply(toDinero(item.unitCostMinor), item.quantity),
        );
      }
    }

    const rows = Array.from(groups.values()).map((row) => {
      const ingresoMinor = toMinorUnits(row.ingreso);
      const gananciaDisponible = row.allCosted;
      return {
        productId: row.productId,
        productName: row.productName,
        memberId: row.memberId,
        memberName: row.memberName,
        units: row.units,
        ingresoMinor,
        costoMinor: gananciaDisponible ? toMinorUnits(row.costo) : null,
        gananciaMinor: gananciaDisponible
          ? toMinorUnits(subtract(row.ingreso, row.costo))
          : null,
        gananciaDisponible,
      };
    });
    // Revenue desc, then product name — both can tie (two different
    // products with the same name, or the same product sold by two
    // members with identical revenue), and a paginated result must be
    // stable across requests: productId/memberId break every remaining tie.
    rows.sort(
      (a, b) =>
        b.ingresoMinor - a.ingresoMinor ||
        a.productName.localeCompare(b.productName) ||
        a.productId.localeCompare(b.productId) ||
        a.memberId.localeCompare(b.memberId),
    );

    const total = rows.length;
    const start = (query.page - 1) * query.limit;
    const items = rows.slice(start, start + query.limit);

    const totals = computeProfitTotals(saleItems);

    return {
      items,
      total,
      page: query.page,
      limit: query.limit,
      totals,
    };
  }
}

import { Inject, Injectable } from '@nestjs/common';
import { add, subtract } from 'dinero.js';
import { currentBusinessDate, parseRangeBoundary } from '../common/business-time.js';
import { toDinero, toMinorUnits } from '../common/money.js';
import { computeProfitTotals } from '../common/profit-totals.js';
import { PrismaService } from '../database/prisma.service.js';
import type { DashboardQueryDto } from './dto/dashboard-query.dto.js';

/**
 * One read-only summary for the Gestión home screen (BE-13 D4): today/
 * yesterday sales, today's profit-with-gap, pending incidencias/deudas, and
 * low-stock products. Every number is scoped to `contextId`, following the
 * same relation-based filter convention as ReportsService (`Sale`/
 * `Incidencia`/`Deuda` via their relations, `Product` directly — it is the
 * one model here whose `contextId` is a direct column).
 */
@Injectable()
export class DashboardService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * `from`/`to` for "today" and "yesterday" (BE-13 D3): resolved from
   * {@link currentBusinessDate}, then fed into {@link parseRangeBoundary}
   * for the actual UTC-6 instant range — no new offset math here.
   * Subtracting 24h in UTC *before* formatting to a business date is what
   * correctly steps back exactly one business day, since the business
   * offset is fixed (no DST): shifting the wall-clock instant first would
   * risk landing on the wrong calendar day near the UTC-6 boundary.
   */
  private ranges(now: Date) {
    const today = currentBusinessDate(now);
    const yesterday = currentBusinessDate(new Date(now.getTime() - 86_400_000));
    return {
      today: {
        from: parseRangeBoundary(today, 'start'),
        to: parseRangeBoundary(today, 'end'),
      },
      yesterday: {
        from: parseRangeBoundary(yesterday, 'start'),
        to: parseRangeBoundary(yesterday, 'end'),
      },
    };
  }

  private async salesTotals(
    contextId: string,
    from: Date,
    to: Date,
  ): Promise<{ totalMinor: number; count: number }> {
    const [agg, count] = await this.prisma.$transaction([
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
    return { totalMinor: agg._sum.totalMinor ?? 0, count };
  }

  async summary(contextId: string, query: DashboardQueryDto) {
    const { today, yesterday } = this.ranges(new Date());

    const [ventasHoy, ventasAyer, todaySaleItems, incidenciasPendientes, deudas] =
      await Promise.all([
        this.salesTotals(contextId, today.from, today.to),
        this.salesTotals(contextId, yesterday.from, yesterday.to),
        this.prisma.saleItem.findMany({
          where: {
            sale: {
              status: 'completada',
              member: { contextId },
              receivedAt: { gte: today.from, lte: today.to },
            },
          },
          select: { subtotalMinor: true, quantity: true, unitCostMinor: true },
        }),
        this.prisma.incidencia.count({
          where: {
            resolutionStatus: 'pendiente',
            sale: { member: { contextId } },
          },
        }),
        this.prisma.deuda.findMany({
          where: { status: 'pendiente', createdByMember: { contextId } },
          include: { abonos: true, deudor: true },
        }),
      ]);

    const { gananciaMinor: gananciaHoyMinor, lineasSinCosto: lineasSinCostoHoy } =
      computeProfitTotals(todaySaleItems);

    // Same remaining-balance math as DeudasService.registerAbono:
    // totalMinor - sum(abonos.montoMinor), via dinero.js.
    let deudasTotal = toDinero(0);
    const deudores = new Set<string>();
    for (const deuda of deudas) {
      const paidMinor = deuda.abonos.reduce(
        (sum, abono) => sum + abono.montoMinor,
        0,
      );
      const remaining = subtract(
        toDinero(deuda.totalMinor),
        toDinero(paidMinor),
      );
      deudasTotal = add(deudasTotal, remaining);
      deudores.add(deuda.deudorId);
    }

    const [productosBajoStock, totalPocaExistencia] = await this.prisma.$transaction(
      [
        this.prisma.product.findMany({
          where: { contextId, active: true, stock: { lte: query.umbral } },
          select: { id: true, name: true, stock: true, category: true },
          orderBy: [{ stock: 'asc' }, { name: 'asc' }],
          take: 5,
        }),
        this.prisma.product.count({
          where: { contextId, active: true, stock: { lte: query.umbral } },
        }),
      ],
    );

    return {
      ventasHoy,
      ventasAyer,
      gananciaHoyMinor,
      lineasSinCostoHoy,
      incidenciasPendientes,
      deudasPendientes: {
        totalMinor: toMinorUnits(deudasTotal),
        personas: deudores.size,
      },
      productosPocaExistencia: {
        umbral: query.umbral,
        total: totalPocaExistencia,
        items: productosBajoStock,
      },
    };
  }
}

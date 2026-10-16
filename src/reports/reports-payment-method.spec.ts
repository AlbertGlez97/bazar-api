import { describe, expect, it, vi } from 'vitest';
import { ReportsService } from './reports.service.js';
import type { PrismaService } from '../database/prisma.service.js';

const from = '2026-10-01';
const to = '2026-10-31';

type Group = { paymentMethod: string; _sum: { totalMinor: number | null }; _count: { _all: number } };
type AbonoRow = { montoMinor: number; paymentMethod: string; receivedAt: Date; deuda: { type: string; deudor: { nombre: string } } };

const group = (paymentMethod: string, totalMinor: number, count: number): Group => ({
  paymentMethod,
  _sum: { totalMinor },
  _count: { _all: count },
});
const abono = (montoMinor: number, paymentMethod: string): AbonoRow => ({
  montoMinor,
  paymentMethod,
  receivedAt: new Date('2026-10-10T12:00:00Z'),
  deuda: { type: 'fiado', deudor: { nombre: 'Cliente' } },
});

function setup(groups: Group[], abonos: AbonoRow[]) {
  const groupBy = vi.fn().mockReturnValue('sales-by-method-query');
  const findAbonos = vi.fn().mockReturnValue('abonos-query');
  const findDeudas = vi.fn().mockReturnValue('deudas-query');
  const prisma = {
    sale: { groupBy },
    abono: { findMany: findAbonos },
    deuda: { findMany: findDeudas },
    $transaction: vi.fn().mockResolvedValue([groups, abonos, []]),
  };
  const service = new ReportsService(prisma as unknown as PrismaService);
  return { service, groupBy, findAbonos, prisma };
}

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

describe('ReportsService.salesByPeriod — total per payment method', () => {
  it('splits sales and abonos by method, always listing the three methods', async () => {
    const { service } = setup(
      [group('EFECTIVO', 10000, 2), group('TARJETA', 5000, 1)],
      [abono(300, 'EFECTIVO'), abono(700, 'TRANSFERENCIA'), abono(200, 'TARJETA')],
    );

    const report = await service.salesByPeriod('ctx', { from, to });

    expect(report.porMetodoPago).toEqual({
      EFECTIVO: { ventasMinor: 10000, abonosMinor: 300, totalMinor: 10300 },
      TRANSFERENCIA: { ventasMinor: 0, abonosMinor: 700, totalMinor: 700 },
      TARJETA: { ventasMinor: 5000, abonosMinor: 200, totalMinor: 5200 },
    });
  });

  it('the three methods add up to the combined total (ventas + abonos)', async () => {
    const { service } = setup(
      [group('EFECTIVO', 10000, 2), group('TRANSFERENCIA', 2500, 1), group('TARJETA', 5000, 1)],
      [abono(300, 'EFECTIVO'), abono(700, 'TRANSFERENCIA'), abono(200, 'TARJETA'), abono(50, 'EFECTIVO')],
    );

    const report = await service.salesByPeriod('ctx', { from, to });
    const methods = Object.values(report.porMetodoPago);

    expect(sum(methods.map((m) => m.totalMinor))).toBe(report.totalIngresadoMinor);
    expect(sum(methods.map((m) => m.ventasMinor))).toBe(report.totalSoldMinor);
    expect(sum(methods.map((m) => m.abonosMinor))).toBe(report.abonosRecibidosMinor);
    expect(report.totalIngresadoMinor).toBe(17500 + 1250);
  });

  it('keeps the existing figures: total sold, sale count and abono total', async () => {
    const { service } = setup(
      [group('EFECTIVO', 10000, 2), group('TARJETA', 5000, 1)],
      [abono(300, 'EFECTIVO')],
    );

    const report = await service.salesByPeriod('ctx', { from, to });

    expect(report).toMatchObject({
      totalSoldMinor: 15000,
      saleCount: 3,
      abonosRecibidosMinor: 300,
      totalIngresadoMinor: 15300,
      deudasLiquidadas: [],
    });
    expect(report.abonosRecibidos).toHaveLength(1);
  });

  it('each listed abono says how it was paid', async () => {
    const { service } = setup([], [abono(300, 'TRANSFERENCIA')]);

    const report = await service.salesByPeriod('ctx', { from, to });

    expect(report.abonosRecibidos[0]).toMatchObject({ montoMinor: 300, paymentMethod: 'TRANSFERENCIA' });
  });

  it('an empty period reports zeros for every method (not missing keys)', async () => {
    const { service } = setup([], []);

    const report = await service.salesByPeriod('ctx', { from, to });

    expect(report.porMetodoPago).toEqual({
      EFECTIVO: { ventasMinor: 0, abonosMinor: 0, totalMinor: 0 },
      TRANSFERENCIA: { ventasMinor: 0, abonosMinor: 0, totalMinor: 0 },
      TARJETA: { ventasMinor: 0, abonosMinor: 0, totalMinor: 0 },
    });
    expect(report).toMatchObject({ totalSoldMinor: 0, saleCount: 0, totalIngresadoMinor: 0 });
  });

  it('a method with only abonos (no sales) is reported too', async () => {
    const { service } = setup([], [abono(900, 'TARJETA')]);

    const report = await service.salesByPeriod('ctx', { from, to });

    expect(report.porMetodoPago.TARJETA).toEqual({ ventasMinor: 0, abonosMinor: 900, totalMinor: 900 });
  });

  it('a null sum (no rows) counts as zero', async () => {
    const { service } = setup([{ paymentMethod: 'EFECTIVO', _sum: { totalMinor: null }, _count: { _all: 0 } }], []);

    const report = await service.salesByPeriod('ctx', { from, to });

    expect(report.porMetodoPago.EFECTIVO.ventasMinor).toBe(0);
  });

  describe('same criteria as before', () => {
    it('only completed sales of this context in the period, grouped by method', async () => {
      const { service, groupBy } = setup([], []);

      await service.salesByPeriod('ctx', { from, to });

      const args = groupBy.mock.calls[0][0];
      expect(args.by).toEqual(['paymentMethod']);
      expect(args.where).toMatchObject({ status: 'completada', member: { contextId: 'ctx' } });
      expect(args.where.receivedAt).toEqual({ gte: expect.any(Date), lte: expect.any(Date) });
      expect(args._sum).toEqual({ totalMinor: true });
    });

    it('the abonos query is still scoped to the context and asks for the method', async () => {
      const { service, findAbonos } = setup([], []);

      await service.salesByPeriod('ctx', { from, to });

      const args = findAbonos.mock.calls[0][0];
      expect(args.where.deuda).toEqual({ createdByMember: { contextId: 'ctx' } });
      expect(args.select.paymentMethod).toBe(true);
    });

    it('everything is read in one transaction', async () => {
      const { service, prisma } = setup([], []);

      await service.salesByPeriod('ctx', { from, to });

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });
  });
});

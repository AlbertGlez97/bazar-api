import { add, multiply, subtract } from 'dinero.js';
import { toDinero, toMinorUnits } from './money.js';

export interface ProfitLineInput {
  subtotalMinor: number;
  quantity: number;
  unitCostMinor: number | null;
}

export interface ProfitTotals {
  ingresoMinor: number;
  gananciaMinor: number;
  lineasSinCosto: number;
}

/**
 * Shared "period totals" profit aggregation (BE-13 D1/D4): sums revenue
 * over every SaleItem line, but sums profit only over the lines that carry
 * a `unitCostMinor` snapshot, and separately counts the ones that don't —
 * never a partial-subset sum passed off as a complete number (see D1's
 * "never estimate" rule).
 *
 * Used identically by `ReportsService.salesDetail()`'s period `totals` and
 * `DashboardService`'s `gananciaHoyMinor`/`lineasSinCostoHoy` — extracted
 * here rather than duplicated line-by-line in both files.
 */
export function computeProfitTotals(items: ProfitLineInput[]): ProfitTotals {
  let ingreso = toDinero(0);
  let ganancia = toDinero(0);
  let lineasSinCosto = 0;
  for (const item of items) {
    ingreso = add(ingreso, toDinero(item.subtotalMinor));
    if (item.unitCostMinor === null) {
      lineasSinCosto++;
    } else {
      const costoLinea = multiply(
        toDinero(item.unitCostMinor),
        item.quantity,
      );
      ganancia = add(
        ganancia,
        subtract(toDinero(item.subtotalMinor), costoLinea),
      );
    }
  }
  return {
    ingresoMinor: toMinorUnits(ingreso),
    gananciaMinor: toMinorUnits(ganancia),
    lineasSinCosto,
  };
}

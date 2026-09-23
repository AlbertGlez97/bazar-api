import { dinero, toDecimal, toSnapshot, type Dinero } from 'dinero.js';
import { MXN } from 'dinero.js/currencies';

export const MAX_MINOR_UNITS = 2_147_483_647;

function assertMinorUnits(amount: number): void {
  if (
    !Number.isInteger(amount) ||
    amount < -2_147_483_648 ||
    amount > MAX_MINOR_UNITS
  ) {
    throw new RangeError(
      'Amount must be integer cents within the PostgreSQL Int range',
    );
  }
}

/**
 * Wraps an integer cent amount (`...Minor` fields) as an MXN Dinero value
 * for arithmetic. Plain `number`/`Decimal` math is never used for money in
 * this codebase — only dinero.js — so amounts cannot silently drift through
 * floating-point rounding.
 */
export function toDinero(amount: number): Dinero<number> {
  assertMinorUnits(amount);
  return dinero({ amount, currency: MXN });
}

/**
 * Unwraps a Dinero value back to the integer cents stored/transmitted at
 * the API boundary. Rejects a non-MXN currency, a scale other than exactly
 * two, or an out-of-range amount, so an intermediate calculation cannot
 * silently produce a value that would round or overflow when persisted —
 * such a result must fail loudly instead.
 */
export function toMinorUnits(value: Dinero<number>): number {
  const { amount, currency, scale } = toSnapshot(value);
  if (
    currency.code !== MXN.code ||
    currency.base !== 10 ||
    currency.exponent !== 2 ||
    scale !== 2
  ) {
    throw new RangeError(
      'Expected MXN with a scale of exactly two; implicit rounding is forbidden',
    );
  }
  assertMinorUnits(amount);
  return amount;
}

export function formatCurrency(amount: number): string {
  return `$${toDecimal(toDinero(amount))}`;
}

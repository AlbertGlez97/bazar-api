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

export function toDinero(amount: number): Dinero<number> {
  assertMinorUnits(amount);
  return dinero({ amount, currency: MXN });
}

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

import { toDinero, toMinorUnits } from '../common/money.js';

export interface RestockCostInput {
  /** Stock right before the restock. */
  stockBefore: number;
  /** The product's current purchase cost in cents; `null` when unknown. */
  costBeforeMinor: number | null;
  /** Pieces being added (> 0). */
  quantity: number;
  /** Unit cost of this purchase in cents; empty when the socio did not say. */
  unitCostMinor: number | null | undefined;
}

const assertWholeNumber = (value: number, name: string, min: number) => {
  if (!Number.isInteger(value) || value < min)
    throw new RangeError(`${name} must be an integer >= ${min}`);
};

/**
 * The product's purchase cost after a restock, or `undefined` when it must
 * stay as it is. Weighted average, in whole cents:
 *
 * - purchase cost empty -> untouched (`undefined`);
 * - stock was 0 -> the purchase cost becomes the product cost;
 * - stock > 0 and a current cost -> (stock x current + quantity x purchase)
 *   / (stock + quantity);
 * - stock > 0 and the current cost is unknown (`null`) -> untouched: an
 *   unknown cost is not zero, so it must not be averaged as if it were.
 *
 * Rounding: the average is rounded half up to whole cents (`x.5` goes up,
 * never to the even neighbour), the same `halfUp` convention the
 * commissions use. A product cost of 0 is a *known* cost and is averaged
 * like any other.
 *
 * Inputs and the result go through {@link toDinero}/{@link toMinorUnits}, so
 * a negative, fractional or out-of-range amount fails loudly (`RangeError`)
 * instead of being persisted. The intermediate sum of products is computed
 * with `BigInt`, not dinero.js: stock x cost can exceed 2^53 (and the Int
 * range dinero enforces on every amount), where a double would silently
 * lose cents.
 */
export function nextProductCost(input: RestockCostInput): number | undefined {
  const { stockBefore, costBeforeMinor, quantity, unitCostMinor } = input;
  assertWholeNumber(stockBefore, 'stockBefore', 0);
  assertWholeNumber(quantity, 'quantity', 1);
  if (unitCostMinor === undefined || unitCostMinor === null) return undefined;
  assertWholeNumber(unitCostMinor, 'unitCostMinor', 0);
  const purchase = toMinorUnits(toDinero(unitCostMinor));
  if (stockBefore === 0) return purchase;
  if (costBeforeMinor === null) return undefined;
  assertWholeNumber(costBeforeMinor, 'costBeforeMinor', 0);
  const current = toMinorUnits(toDinero(costBeforeMinor));

  const units = BigInt(stockBefore) + BigInt(quantity);
  const total =
    BigInt(stockBefore) * BigInt(current) + BigInt(quantity) * BigInt(purchase);
  // Round half up: floor((2 x total + units) / (2 x units)); all non-negative.
  const average = (2n * total + units) / (2n * units);
  return toMinorUnits(toDinero(Number(average)));
}

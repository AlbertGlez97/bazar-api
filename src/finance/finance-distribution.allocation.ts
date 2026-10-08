/**
 * Pure, deterministic allocation primitives for the distribution simulator.
 * Everything is BigInt: no floats, no Date, no IO. Amounts are minor units.
 */
export interface Allocation {
  id: string;
  amount: bigint;
}
export interface Weighted {
  id: string;
  weight: bigint;
}

const BPS_TOTAL = 10000n;
const byId = (a: { id: string }, b: { id: string }) =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

function assertUnique(ids: string[]): void {
  if (new Set(ids).size !== ids.length)
    throw new RangeError('Allocation ids must be unique');
}

/**
 * partnerPool = floor(requested * partnerShareBps / 10000); the work pool takes
 * the rest, so an odd minor unit always falls to the work pool.
 */
export function splitPools(requestedMinor: bigint, partnerShareBps: bigint) {
  if (requestedMinor < 0n) throw new RangeError('Requested amount is negative');
  if (partnerShareBps < 0n || partnerShareBps > BPS_TOTAL)
    throw new RangeError('partnerShareBps must be within 0..10000');
  const partnerPoolMinor = (requestedMinor * partnerShareBps) / BPS_TOTAL;
  return {
    partnerPoolMinor,
    workPoolMinor: requestedMinor - partnerPoolMinor,
  };
}

/**
 * Equal split: base = floor(pool / n); the remainder r adds one minor unit to
 * the first r ids in ascending id order. Output is sorted by id.
 */
export function allocateEqual(pool: bigint, ids: string[]): Allocation[] {
  if (pool < 0n) throw new RangeError('Pool is negative');
  assertUnique(ids);
  if (ids.length === 0) {
    if (pool === 0n) return [];
    throw new RangeError('Cannot allocate a positive pool to nobody');
  }
  const count = BigInt(ids.length);
  const base = pool / count;
  const remainder = Number(pool % count);
  return [...ids]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((id, index) => ({
      id,
      amount: base + (index < remainder ? 1n : 0n),
    }));
}

/**
 * Largest remainder (Hamilton): floor(pool * w / U) first, then each leftover
 * unit goes to the largest (pool * w) mod U, ties by id ascending. Members with
 * zero weight always receive 0 and never a leftover unit. Output is sorted by id
 * and its total is asserted to equal the pool.
 */
export function allocateByWeight(
  pool: bigint,
  items: Weighted[],
): Allocation[] {
  if (pool < 0n) throw new RangeError('Pool is negative');
  assertUnique(items.map((item) => item.id));
  if (items.some((item) => item.weight < 0n))
    throw new RangeError('Weights must not be negative');
  const total = items.reduce((sum, item) => sum + item.weight, 0n);
  if (total === 0n) {
    if (pool === 0n)
      return items.map((item) => ({ id: item.id, amount: 0n })).sort(byId);
    throw new RangeError('Cannot allocate a positive pool without weight');
  }
  const rows = items.map((item) => {
    const scaled = pool * item.weight;
    return {
      id: item.id,
      amount: scaled / total,
      remainder: scaled % total,
      weight: item.weight,
    };
  });
  let leftover = pool - rows.reduce((sum, row) => sum + row.amount, 0n);
  const ranking = rows
    .filter((row) => row.weight > 0n)
    .sort((a, b) =>
      a.remainder === b.remainder
        ? byId(a, b)
        : a.remainder > b.remainder
          ? -1
          : 1,
    );
  for (const row of ranking) {
    if (leftover === 0n) break;
    row.amount += 1n;
    leftover -= 1n;
  }
  const result = rows.map(({ id, amount }) => ({ id, amount })).sort(byId);
  const allocated = result.reduce((sum, row) => sum + row.amount, 0n);
  if (leftover !== 0n || allocated !== pool)
    throw new Error('Allocation does not add up to the pool');
  return result;
}

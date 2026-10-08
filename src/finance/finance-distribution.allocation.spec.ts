import {
  allocateByWeight,
  allocateEqual,
  splitPools,
} from './finance-distribution.allocation.js';

// Deterministic LCG so property-style checks are reproducible.
function rng(seed: number) {
  let state = seed >>> 0;
  return (max: number) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % max;
  };
}
const sum = (rows: { amount: bigint }[]) =>
  rows.reduce((total, row) => total + row.amount, 0n);
const amounts = (rows: { id: string; amount: bigint }[]) =>
  Object.fromEntries(rows.map((row) => [row.id, Number(row.amount)]));

describe('splitPools', () => {
  it.each([
    [600000n, 5000n, 300000n, 300000n],
    [1000n, 7000n, 700n, 300n],
    [1000n, 10000n, 1000n, 0n],
    [1000n, 0n, 0n, 1000n],
    // Odd cent falls to the work pool because the partner pool floors.
    [101n, 5000n, 50n, 51n],
    [1n, 5000n, 0n, 1n],
    [2147483647n, 3333n, 715756299n, 1431727348n],
  ])('splits %s at %s bps', (requested, bps, partner, work) => {
    expect(splitPools(requested, bps)).toEqual({
      partnerPoolMinor: partner,
      workPoolMinor: work,
    });
  });
  it('always conserves the requested amount', () => {
    const next = rng(7);
    for (let i = 0; i < 500; i++) {
      const requested = BigInt(1 + next(2147483646));
      const bps = BigInt(next(10001));
      const pools = splitPools(requested, bps);
      expect(pools.partnerPoolMinor + pools.workPoolMinor).toBe(requested);
      expect(pools.partnerPoolMinor).toBe((requested * bps) / 10000n);
    }
  });
  it('rejects out-of-range input', () => {
    expect(() => splitPools(-1n, 5000n)).toThrow();
    expect(() => splitPools(10n, 10001n)).toThrow();
    expect(() => splitPools(10n, -1n)).toThrow();
  });
});

describe('allocateEqual', () => {
  it('gives the remainder to the first members by id ascending', () => {
    expect(allocateEqual(10000n, ['c', 'a', 'b'])).toEqual([
      { id: 'a', amount: 3334n },
      { id: 'b', amount: 3333n },
      { id: 'c', amount: 3333n },
    ]);
  });
  it('distributes a remainder of 2 to the first two members', () => {
    expect(amounts(allocateEqual(11n, ['z', 'y', 'x']))).toEqual({
      x: 4,
      y: 4,
      z: 3,
    });
  });
  it('handles one member, zero pool and fewer cents than members', () => {
    expect(allocateEqual(7n, ['only'])).toEqual([{ id: 'only', amount: 7n }]);
    expect(amounts(allocateEqual(0n, ['a', 'b']))).toEqual({ a: 0, b: 0 });
    expect(amounts(allocateEqual(2n, ['a', 'b', 'c']))).toEqual({
      a: 1,
      b: 1,
      c: 0,
    });
  });
  it('returns an empty list for a zero pool with no members and throws otherwise', () => {
    expect(allocateEqual(0n, [])).toEqual([]);
    expect(() => allocateEqual(1n, [])).toThrow();
  });
  it('rejects duplicate ids and negative pools', () => {
    expect(() => allocateEqual(10n, ['a', 'a'])).toThrow();
    expect(() => allocateEqual(-1n, ['a'])).toThrow();
  });
  it('is exact, balanced and independent of input order', () => {
    const next = rng(11);
    for (let i = 0; i < 300; i++) {
      const count = 1 + next(12);
      const unique = [
        ...new Set(Array.from({ length: count }, () => `m-${next(99)}`)),
      ];
      const pool = BigInt(next(2147483647));
      const rows = allocateEqual(pool, unique);
      expect(sum(rows)).toBe(pool);
      const values = rows.map((row) => row.amount);
      const max = values.reduce((a, b) => (a > b ? a : b));
      const min = values.reduce((a, b) => (a < b ? a : b));
      expect(max - min).toBeLessThanOrEqual(1n);
      expect(allocateEqual(pool, [...unique].reverse())).toEqual(rows);
    }
  });
});

describe('allocateByWeight', () => {
  it('reproduces the worked example 120000 / 180000 for weights 2 and 3', () => {
    const rows = allocateByWeight(300000n, [
      { id: 'alberto', weight: 2n },
      { id: 'adid', weight: 3n },
    ]);
    expect(amounts(rows)).toEqual({ adid: 180000, alberto: 120000 });
  });
  it('breaks equal remainders by id ascending', () => {
    expect(
      amounts(
        allocateByWeight(10n, [
          { id: 'c', weight: 1n },
          { id: 'b', weight: 1n },
          { id: 'a', weight: 1n },
        ]),
      ),
    ).toEqual({ a: 4, b: 3, c: 3 });
    expect(
      amounts(
        allocateByWeight(10n, [
          { id: 'a', weight: 3n },
          { id: 'b', weight: 3n },
          { id: 'c', weight: 4n },
        ]),
      ),
    ).toEqual({ a: 3, b: 3, c: 4 });
  });
  it('prefers the larger fractional remainder over the smaller id', () => {
    // pool 5, weights 1,1,4 (U=6): floors 0,0,3; remainders 5,5,2 -> a and b win.
    expect(
      amounts(
        allocateByWeight(5n, [
          { id: 'a', weight: 1n },
          { id: 'b', weight: 1n },
          { id: 'c', weight: 4n },
        ]),
      ),
    ).toEqual({ a: 1, b: 1, c: 3 });
    // pool 7, weights 1,5 (U=6): floors 1,5; remainders 1,5 -> z wins the unit.
    expect(
      amounts(
        allocateByWeight(7n, [
          { id: 'a', weight: 1n },
          { id: 'z', weight: 5n },
        ]),
      ),
    ).toEqual({ a: 1, z: 6 });
  });
  it('gives zero-weight members nothing, never a leftover unit', () => {
    const rows = allocateByWeight(100n, [
      { id: 'a', weight: 0n },
      { id: 'b', weight: 1n },
      { id: 'c', weight: 0n },
      { id: 'd', weight: 2n },
    ]);
    expect(amounts(rows)).toEqual({ a: 0, b: 33, c: 0, d: 67 });
  });
  it('allocates a pool of zero and a single weighted member', () => {
    expect(amounts(allocateByWeight(0n, [{ id: 'a', weight: 5n }]))).toEqual({
      a: 0,
    });
    expect(amounts(allocateByWeight(9n, [{ id: 'a', weight: 5n }]))).toEqual({
      a: 9,
    });
    expect(allocateByWeight(0n, [{ id: 'a', weight: 0n }])).toEqual([
      { id: 'a', amount: 0n },
    ]);
  });
  it('throws without weight for a positive pool, on negatives and on duplicates', () => {
    expect(() => allocateByWeight(1n, [{ id: 'a', weight: 0n }])).toThrow();
    expect(() => allocateByWeight(1n, [])).toThrow();
    expect(() => allocateByWeight(-1n, [{ id: 'a', weight: 1n }])).toThrow();
    expect(() => allocateByWeight(1n, [{ id: 'a', weight: -1n }])).toThrow();
    expect(() =>
      allocateByWeight(1n, [
        { id: 'a', weight: 1n },
        { id: 'a', weight: 1n },
      ]),
    ).toThrow();
  });
  it('keeps products beyond the safe integer range exact', () => {
    const rows = allocateByWeight(2147483647n, [
      { id: 'a', weight: 9007199254740993n },
      { id: 'b', weight: 9007199254740991n },
    ]);
    expect(sum(rows)).toBe(2147483647n);
  });
  it('is exact, deterministic, order-invariant and within one unit of the ideal share', () => {
    const next = rng(2026);
    for (let i = 0; i < 500; i++) {
      const count = 1 + next(10);
      const items = Array.from({ length: count }, (_, k) => ({
        id: `id-${String(k).padStart(2, '0')}`,
        weight: BigInt(next(4) === 0 ? 0 : next(100000)),
      }));
      const total = items.reduce((t, item) => t + item.weight, 0n);
      if (total === 0n) continue;
      const pool = BigInt(next(2147483647));
      const rows = allocateByWeight(pool, items);
      expect(sum(rows)).toBe(pool);
      expect(rows.map((row) => row.id)).toEqual(items.map((item) => item.id));
      expect(allocateByWeight(pool, items)).toEqual(rows);
      const shuffled = [...items].sort(() => next(3) - 1);
      expect(allocateByWeight(pool, shuffled)).toEqual(rows);
      for (const row of rows) {
        const weight = items.find((item) => item.id === row.id)!.weight;
        const floor = (pool * weight) / total;
        expect(row.amount === floor || row.amount === floor + 1n).toBe(true);
        if (weight === 0n) expect(row.amount).toBe(0n);
      }
    }
  });
});

import { describe, expect, it } from 'vitest';
import { nextProductCost } from './restock-cost.js';

const cost = (
  stockBefore: number,
  costBeforeMinor: number | null,
  quantity: number,
  unitCostMinor: number | null | undefined,
) => nextProductCost({ stockBefore, costBeforeMinor, quantity, unitCostMinor });

describe('nextProductCost (weighted-average cost of a restock)', () => {
  describe('purchase cost left empty: the product cost is not touched', () => {
    it.each([undefined, null])('unitCostMinor=%s', (unitCostMinor) => {
      expect(cost(5, 1000, 3, unitCostMinor)).toBeUndefined();
    });

    it('even when the stock was 0 and the product had no cost', () => {
      expect(cost(0, null, 3, undefined)).toBeUndefined();
    });
  });

  describe('stock was 0: the purchase cost becomes the product cost', () => {
    it('replaces an existing cost', () => {
      expect(cost(0, 1000, 4, 1500)).toBe(1500);
    });

    it('sets a cost on a product that had none', () => {
      expect(cost(0, null, 4, 1500)).toBe(1500);
    });

    it('accepts a purchase cost of 0', () => {
      expect(cost(0, 1000, 4, 0)).toBe(0);
    });
  });

  describe('stock > 0 and a current cost: weighted average', () => {
    it('averages exactly when the division is exact', () => {
      // (3 x 1000 + 2 x 1100) / 5 = 5200 / 5
      expect(cost(3, 1000, 2, 1100)).toBe(1040);
    });

    it('keeps the cost when the purchase is at the same price', () => {
      expect(cost(7, 1250, 5, 1250)).toBe(1250);
    });

    it('treats a current cost of 0 as a known cost, not as unknown', () => {
      // (4 x 0 + 4 x 1000) / 8
      expect(cost(4, 0, 4, 1000)).toBe(500);
    });

    it('treats a purchase cost of 0 as a known cost (free pieces lower the average)', () => {
      expect(cost(2, 1000, 2, 0)).toBe(500);
    });

    describe('rounding: half up to whole cents', () => {
      it('rounds a fraction below one half down', () => {
        // (2 x 100 + 1 x 101) / 3 = 100.333...
        expect(cost(2, 100, 1, 101)).toBe(100);
      });

      it('rounds a fraction above one half up', () => {
        // (1 x 100 + 2 x 101) / 3 = 100.666...
        expect(cost(1, 100, 2, 101)).toBe(101);
      });

      it('rounds exactly one half up (not to even)', () => {
        // (1 x 100 + 1 x 101) / 2 = 100.5 -> 101 (half-even would give 100)
        expect(cost(1, 100, 1, 101)).toBe(101);
        // (1 x 101 + 1 x 100) / 2 = 100.5 -> 101
        expect(cost(1, 101, 1, 100)).toBe(101);
        // (1 x 102 + 1 x 103) / 2 = 102.5 -> 103 (half-even would give 102)
        expect(cost(1, 102, 1, 103)).toBe(103);
      });

      it('rounds half up when the average is below the current cost', () => {
        // (3 x 1001 + 1 x 1000) / 4 = 1000.75 -> 1001
        expect(cost(3, 1001, 1, 1000)).toBe(1001);
        // (1 x 1001 + 1 x 1000) / 2 = 1000.5 -> 1001
        expect(cost(1, 1001, 1, 1000)).toBe(1001);
      });
    });

    it('stays exact where a double would lose precision (products above 2^53)', () => {
      const stock = 2_000_000_000;
      const current = 2_000_000_000;
      const quantity = 100;
      // exact value: floor((stock x current x 2 + d) / (2d)) with d = stock + quantity
      const d = BigInt(stock + quantity);
      const expected = Number(
        (BigInt(stock) * BigInt(current) * 2n + d) / (2n * d),
      );

      expect(cost(stock, current, quantity, 0)).toBe(expected);
    });

    it('never leaves the integer-cents range', () => {
      const max = 2_147_483_647;
      expect(cost(max - 1, max, 1, max)).toBe(max);
    });
  });

  describe('stock > 0 and the current cost is unknown: not touched', () => {
    it('unknown is not zero', () => {
      expect(cost(5, null, 3, 1000)).toBeUndefined();
    });
  });

  describe('invalid input fails loudly', () => {
    it.each([
      ['a negative purchase cost', () => cost(1, 100, 1, -1)],
      ['a fractional purchase cost', () => cost(1, 100, 1, 10.5)],
      ['a purchase cost above the Int range', () => cost(1, 100, 1, 2_147_483_648)],
      ['a negative current cost', () => cost(1, -5, 1, 100)],
    ])('rejects %s', (_label, run) => {
      expect(run).toThrow(RangeError);
    });

    it.each([
      ['quantity 0', () => cost(1, 100, 0, 100)],
      ['a fractional quantity', () => cost(1, 100, 1.5, 100)],
      ['a negative stock', () => cost(-1, 100, 1, 100)],
    ])('rejects %s', (_label, run) => {
      expect(run).toThrow(RangeError);
    });
  });
});

import { add, dinero, subtract, toSnapshot } from 'dinero.js';
import { MXN, USD } from 'dinero.js/currencies';
import { validate } from 'class-validator';
import { ProductPriceDto } from '../products/dto/product-price.dto.js';
import { SalePaymentDto } from '../sales/dto/sale-payment.dto.js';
import { formatCurrency, toDinero, toMinorUnits } from './money.js';

describe('MXN cents', () => {
  it('preserves integer cents and MXN currency', () => {
    expect(toSnapshot(toDinero(12550))).toEqual({
      amount: 12550,
      currency: MXN,
      scale: 2,
    });
    expect(toMinorUnits(toDinero(0))).toBe(0);
  });
  it('adds cents using Dinero rather than floating-point pesos', () => {
    expect(
      toMinorUnits(add(add(toDinero(10), toDinero(20)), toDinero(30))),
    ).toBe(60);
  });
  it('calculates a change example using Dinero subtraction', () => {
    expect(toMinorUnits(subtract(toDinero(20000), toDinero(12550)))).toBe(7450);
  });
  it('formats the requested deterministic currency representation', () => {
    expect(formatCurrency(12550)).toBe('$125.50');
    expect(formatCurrency(0)).toBe('$0.00');
  });
  it.each([125.5, NaN, Infinity, -Infinity, 2147483648, -2147483649])(
    'rejects invalid storage input %s',
    (amount) => {
      expect(() => toDinero(amount)).toThrow(RangeError);
    },
  );
  it('rejects foreign currency, sub-cent scale and result overflow', () => {
    expect(() => toMinorUnits(dinero({ amount: 1, currency: USD }))).toThrow();
    expect(() =>
      toMinorUnits(dinero({ amount: 1255, currency: MXN, scale: 3 })),
    ).toThrow();
    expect(() =>
      toMinorUnits(add(toDinero(2147483647), toDinero(1))),
    ).toThrow();
  });
  it('retains signed intermediate results without deciding insufficient-cash policy', () => {
    expect(toMinorUnits(subtract(toDinero(0), toDinero(1)))).toBe(-1);
  });
});

describe('monetary DTO contracts', () => {
  it.each([0, 12550, 2147483647])(
    'accepts nonnegative integer cents %s',
    async (amount) => {
      expect(
        await validate(
          Object.assign(new ProductPriceDto(), { unitPriceMinor: amount }),
        ),
      ).toEqual([]);
      expect(
        await validate(
          Object.assign(new SalePaymentDto(), { cashReceivedMinor: amount }),
        ),
      ).toEqual([]);
    },
  );
  it.each([125.5, -1, 2147483648, NaN, Infinity, '12550', undefined])(
    'rejects invalid monetary input %s',
    async (amount) => {
      expect(
        (
          await validate(
            Object.assign(new ProductPriceDto(), { unitPriceMinor: amount }),
          )
        ).length,
      ).toBeGreaterThan(0);
      expect(
        (
          await validate(
            Object.assign(new SalePaymentDto(), { cashReceivedMinor: amount }),
          )
        ).length,
      ).toBeGreaterThan(0);
    },
  );
});

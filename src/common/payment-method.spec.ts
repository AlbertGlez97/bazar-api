import { describe, expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  DEFAULT_PAYMENT_METHOD,
  PAYMENT_METHODS,
  isCashPayment,
  resolvePaymentMethod,
} from './payment-method.js';
import { CreateAbonoDto } from '../deudas/dto/create-abono.dto.js';
import { CreateDeudaDto } from '../deudas/dto/create-deuda.dto.js';
import { CreateSaleDto } from '../sales/dto/create-sale.dto.js';

describe('payment method helpers', () => {
  it('lists the three methods in Spanish upper case, like StockMovementType', () => {
    expect([...PAYMENT_METHODS]).toEqual(['EFECTIVO', 'TRANSFERENCIA', 'TARJETA']);
  });

  it('an absent method (or null) means EFECTIVO', () => {
    expect(DEFAULT_PAYMENT_METHOD).toBe('EFECTIVO');
    expect(resolvePaymentMethod(undefined)).toBe('EFECTIVO');
    expect(resolvePaymentMethod(null)).toBe('EFECTIVO');
    expect(resolvePaymentMethod('TARJETA')).toBe('TARJETA');
  });

  it('only EFECTIVO is a cash payment', () => {
    expect(isCashPayment(undefined)).toBe(true);
    expect(isCashPayment('EFECTIVO')).toBe(true);
    expect(isCashPayment('TRANSFERENCIA')).toBe(false);
    expect(isCashPayment('TARJETA')).toBe(false);
  });
});

const failing = async (cls: new () => object, body: Record<string, unknown>) =>
  (
    await validate(plainToInstance(cls, body), {
      whitelist: true,
      forbidNonWhitelisted: true,
    })
  ).map((error) => error.property);

const sale = {
  id: '0199a10c-4b80-7000-8000-000000000001',
  memberId: '0199a10c-4b80-7000-8000-000000000002',
  deviceId: '0199a10c-4b80-7000-8000-000000000003',
  occurredAt: '2026-10-16T12:00:00.000Z',
  currency: 'MXN',
  items: [{ productId: '0199a10c-4b80-7000-8000-000000000004', quantity: 1 }],
};

describe('CreateSaleDto payment method', () => {
  it('a legacy payload without the field (offline queue) is still valid', async () => {
    expect(await failing(CreateSaleDto, { ...sale, cashReceivedMinor: 5000 })).toEqual([]);
  });

  it('an explicit EFECTIVO needs the cash received', async () => {
    expect(
      await failing(CreateSaleDto, { ...sale, paymentMethod: 'EFECTIVO', cashReceivedMinor: 5000 }),
    ).toEqual([]);
    expect(await failing(CreateSaleDto, { ...sale, paymentMethod: 'EFECTIVO' })).toEqual([
      'cashReceivedMinor',
    ]);
  });

  it('a null method counts as absent, so the cash is required', async () => {
    expect(await failing(CreateSaleDto, { ...sale, paymentMethod: null })).toEqual([
      'cashReceivedMinor',
    ]);
  });

  it('no method and no cash is still invalid (the legacy rule)', async () => {
    expect(await failing(CreateSaleDto, sale)).toEqual(['cashReceivedMinor']);
  });

  it.each(['TRANSFERENCIA', 'TARJETA'])(
    '%s is paid in full: no cash field is needed',
    async (paymentMethod) => {
      expect(await failing(CreateSaleDto, { ...sale, paymentMethod })).toEqual([]);
    },
  );

  it.each(['TRANSFERENCIA', 'TARJETA'])(
    '%s rejects a cash received (it does not apply, and 0 is not "nothing")',
    async (paymentMethod) => {
      expect(
        await failing(CreateSaleDto, { ...sale, paymentMethod, cashReceivedMinor: 5000 }),
      ).toEqual(['cashReceivedMinor']);
      expect(
        await failing(CreateSaleDto, { ...sale, paymentMethod, cashReceivedMinor: 0 }),
      ).toEqual(['cashReceivedMinor']);
    },
  );

  it.each(['efectivo', 'Tarjeta', 'CHEQUE', 'CASH', '', 1, true])(
    'rejects the unknown method %j',
    async (paymentMethod) => {
      const properties = await failing(CreateSaleDto, {
        ...sale,
        paymentMethod,
        cashReceivedMinor: 5000,
      });
      expect(properties).toContain('paymentMethod');
    },
  );
});

describe('CreateAbonoDto payment method', () => {
  it('is optional', async () => {
    expect(await failing(CreateAbonoDto, { montoMinor: 100 })).toEqual([]);
    expect(await failing(CreateAbonoDto, { montoMinor: 100, paymentMethod: null })).toEqual([]);
  });

  it.each(PAYMENT_METHODS)('accepts %s', async (paymentMethod) => {
    expect(await failing(CreateAbonoDto, { montoMinor: 100, paymentMethod })).toEqual([]);
  });

  it.each(['efectivo', 'CHEQUE', 7])('rejects the unknown method %j', async (paymentMethod) => {
    expect(await failing(CreateAbonoDto, { montoMinor: 100, paymentMethod })).toEqual([
      'paymentMethod',
    ]);
  });
});

describe('CreateDeudaDto initial abono payment method', () => {
  const deuda = {
    type: 'fiado',
    productId: '0199a10c-4b80-7000-8000-000000000002',
    cantidad: 1,
    deudor: { nombre: 'Cliente' },
    abonoInicialMinor: 100,
  };

  it('is optional', async () => {
    expect(await failing(CreateDeudaDto, deuda)).toEqual([]);
  });

  it.each(PAYMENT_METHODS)('accepts %s', async (abonoInicialPaymentMethod) => {
    expect(await failing(CreateDeudaDto, { ...deuda, abonoInicialPaymentMethod })).toEqual([]);
  });

  it('rejects an unknown method', async () => {
    expect(
      await failing(CreateDeudaDto, { ...deuda, abonoInicialPaymentMethod: 'CHEQUE' }),
    ).toEqual(['abonoInicialPaymentMethod']);
  });
});

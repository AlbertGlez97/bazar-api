import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { SalesService } from './sales.service.js';
import type { PrismaService } from '../database/prisma.service.js';
import type { CreateSaleDto } from './dto/create-sale.dto.js';

const actor = {
  account: { id: 'account', contextId: 'context', email: 'a@example.test', active: true },
  selection: { memberId: 'member', deviceId: 'device' },
};
const occurredAt = new Date().toISOString();
const base = {
  id: '0199a10c-4b80-7000-8000-000000000001',
  memberId: 'member',
  deviceId: 'device',
  currency: 'MXN',
  occurredAt,
  cashReceivedMinor: 1000,
  items: [{ productId: 'product', quantity: 1 }],
};

/** The fingerprint exactly as it was stored before payment methods existed. */
function legacyFingerprint(dto: CreateSaleDto) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        memberId: dto.memberId,
        deviceId: dto.deviceId,
        currency: dto.currency,
        cashReceivedMinor: dto.cashReceivedMinor,
        occurredAt: new Date(dto.occurredAt).toISOString(),
        items: dto.items.map(({ productId, quantity }) => ({ productId, quantity })),
      }),
    )
    .digest('hex');
}

function setup(existing: Record<string, unknown> | null = null) {
  const create = vi.fn(({ data }) => Promise.resolve({ ...data, items: [] }));
  const productRow = { id: 'product', active: true, stock: 5, unitPriceMinor: 500, purchaseCostMinor: null };
  const tx = {
    account: { findFirst: vi.fn().mockResolvedValue(actor.account) },
    member: { findFirst: vi.fn().mockResolvedValue({ id: 'member' }) },
    device: { findFirst: vi.fn().mockResolvedValue({ id: 'device' }) },
    product: { findFirst: vi.fn().mockResolvedValue(productRow), update: vi.fn().mockResolvedValue({}) },
    $queryRaw: vi.fn().mockResolvedValue([]),
    sale: { create },
  };
  const prisma = {
    sale: { findUnique: vi.fn().mockResolvedValue(existing), create: vi.fn((args) => Promise.resolve({ ...args.data, items: [] })) },
    $transaction: vi.fn((callback) => callback(tx)),
  };
  const service = new SalesService(prisma as unknown as PrismaService);
  return { service, tx, prisma, create, productRow };
}

const { cashReceivedMinor: _cash, ...baseNoCash } = base;

describe('SalesService.create — payment method', () => {
  describe('EFECTIVO (the existing rules, unchanged)', () => {
    it.each([undefined, null, 'EFECTIVO'] as const)(
      'method %s: stores EFECTIVO with the cash received and the change',
      async (paymentMethod) => {
        const { service, create } = setup();

        await service.create(actor, { ...base, cashReceivedMinor: 1000, paymentMethod });

        expect(create.mock.calls[0][0].data).toMatchObject({
          paymentMethod: 'EFECTIVO',
          totalMinor: 500,
          cashReceivedMinor: 1000,
          changeMinor: 500,
        });
      },
    );

    it.each([undefined, 'EFECTIVO'] as const)(
      'method %s: cash below the total is still a 400',
      async (paymentMethod) => {
        const { service } = setup();

        await expect(
          service.create(actor, { ...base, cashReceivedMinor: 499, paymentMethod }),
        ).rejects.toThrow(BadRequestException);
      },
    );

    it('exact cash gives zero change, not null', async () => {
      const { service, create } = setup();

      await service.create(actor, { ...base, cashReceivedMinor: 500 });

      expect(create.mock.calls[0][0].data).toMatchObject({ cashReceivedMinor: 500, changeMinor: 0 });
    });
  });

  describe('TRANSFERENCIA / TARJETA (the full total is charged)', () => {
    it.each(['TRANSFERENCIA', 'TARJETA'] as const)(
      '%s stores the method and null cash and change (never 0)',
      async (paymentMethod) => {
        const { service, create } = setup();

        const result = await service.create(actor, { ...baseNoCash, paymentMethod });

        const data = create.mock.calls[0][0].data;
        expect(data).toMatchObject({ paymentMethod, totalMinor: 500, status: 'completada' });
        expect(data.cashReceivedMinor).toBeNull();
        expect(data.changeMinor).toBeNull();
        expect(result.created).toBe(true);
        expect(result.sale.paymentMethod).toBe(paymentMethod);
      },
    );

    it.each(['TRANSFERENCIA', 'TARJETA'] as const)(
      '%s does not run the insufficient-cash rule',
      async (paymentMethod) => {
        const { service } = setup();

        await expect(service.create(actor, { ...baseNoCash, paymentMethod })).resolves.toMatchObject({ created: true });
      },
    );

    it.each(['TRANSFERENCIA', 'TARJETA'] as const)(
      '%s still moves the inventory exactly like cash',
      async (paymentMethod) => {
        const { service, tx } = setup();

        await service.create(actor, { ...baseNoCash, paymentMethod });

        expect(tx.product.update).toHaveBeenCalledWith({ where: { id: 'product' }, data: { stock: 4 } });
      },
    );

    it('a sale lost to a stock race keeps its method and null cash', async () => {
      const { service, tx, prisma } = setup();
      // Enough stock when read before the lock, none once the lock is held.
      tx.product.findFirst
        .mockResolvedValueOnce({ id: 'product', active: true, stock: 1, unitPriceMinor: 500, purchaseCostMinor: null })
        .mockResolvedValueOnce({ id: 'product', active: true, stock: 0, unitPriceMinor: 500, purchaseCostMinor: null });

      await service.create(actor, { ...baseNoCash, paymentMethod: 'TARJETA' });

      const data = prisma.sale.create.mock.calls[0][0].data;
      expect(data).toMatchObject({ status: 'rechazada_por_conflicto', paymentMethod: 'TARJETA' });
      expect(data.cashReceivedMinor).toBeNull();
    });
  });

  describe('idempotency (an unchanged resend is never a 409)', () => {
    /** A sale stored before this version: no method column value other than the default, legacy fingerprint. */
    const legacyRow = (overrides: Record<string, unknown> = {}) => ({
      id: base.id,
      memberId: 'member',
      deviceId: 'device',
      currency: 'MXN',
      occurredAt: new Date(occurredAt),
      status: 'completada',
      totalMinor: 500,
      paymentMethod: 'EFECTIVO',
      cashReceivedMinor: 1000,
      changeMinor: 500,
      requestFingerprint: legacyFingerprint(base),
      items: [{ productId: 'product', quantity: 1, id: 'i', unitPriceMinor: 500, subtotalMinor: 500, createdAt: new Date() }],
      ...overrides,
    });

    it('a sale queued before this version (no method) replays against its stored legacy fingerprint', async () => {
      const { service, create } = setup(legacyRow());

      const result = await service.create(actor, base);

      expect(result.created).toBe(false);
      expect(create).not.toHaveBeenCalled();
    });

    it('an explicit EFECTIVO compares equal to an absent method', async () => {
      const { service } = setup(legacyRow());

      await expect(service.create(actor, { ...base, paymentMethod: 'EFECTIVO' })).resolves.toMatchObject({ created: false });
      await expect(service.create(actor, { ...base, paymentMethod: null })).resolves.toMatchObject({ created: false });
    });

    it('a stored legacy sale without a fingerprint (older rows) also replays', async () => {
      const { service } = setup(legacyRow({ requestFingerprint: null }));

      await expect(service.create(actor, base)).resolves.toMatchObject({ created: false });
    });

    it('the same id resent with another method is a different request: 409', async () => {
      const { service } = setup(legacyRow());

      await expect(
        service.create(actor, { ...baseNoCash, paymentMethod: 'TARJETA' }),
      ).rejects.toThrow(ConflictException);
    });

    it('a sale stored as TRANSFERENCIA replays when resent unchanged', async () => {
      const first = setup();
      await first.service.create(actor, { ...baseNoCash, paymentMethod: 'TRANSFERENCIA' });
      const stored = first.create.mock.calls[0][0].data;
      const { service, create } = setup({
        ...stored,
        occurredAt: new Date(occurredAt),
        items: [{ productId: 'product', quantity: 1 }],
      });

      const result = await service.create(actor, { ...baseNoCash, paymentMethod: 'TRANSFERENCIA' });

      expect(result.created).toBe(false);
      expect(create).not.toHaveBeenCalled();
    });

    it('a sale stored as TRANSFERENCIA resent as TARJETA, or as EFECTIVO, is a 409', async () => {
      const first = setup();
      await first.service.create(actor, { ...baseNoCash, paymentMethod: 'TRANSFERENCIA' });
      const stored = { ...first.create.mock.calls[0][0].data, occurredAt: new Date(occurredAt), items: [{ productId: 'product', quantity: 1 }] };

      await expect(
        setup(stored).service.create(actor, { ...baseNoCash, paymentMethod: 'TARJETA' }),
      ).rejects.toThrow(ConflictException);
      await expect(
        setup(stored).service.create(actor, { ...base, cashReceivedMinor: 1000 }),
      ).rejects.toThrow(ConflictException);
    });

    it('the fingerprint of an EFECTIVO sale is byte-identical to the legacy one', async () => {
      const { service, create } = setup();

      await service.create(actor, base);

      expect(create.mock.calls[0][0].data.requestFingerprint).toBe(legacyFingerprint(base));
    });
  });
});

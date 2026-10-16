import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { MAX_MINOR_UNITS } from '../common/money.js';
import { ProductsService } from './products.service.js';
import type { PrismaService } from '../database/prisma.service.js';
import type { StorageService } from '../storage/storage.service.js';

const CONTEXT = 'ctx-1';
const PRODUCT = '0192f0aa-0000-7000-8000-000000000001';
const MEMBER = '0192f0aa-0000-7000-8000-0000000000aa';

const product = (overrides: Record<string, unknown> = {}) => ({
  id: PRODUCT,
  name: 'Lámpara',
  tipo: 'cantidad',
  unitPriceMinor: 5000,
  contextId: CONTEXT,
  imagePath: null,
  initialStock: 10,
  stock: 10,
  category: null,
  purchaseCostMinor: 1000,
  supplier: null,
  notes: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  active: true,
  ...overrides,
});

const notFound = () =>
  new Prisma.PrismaClientKnownRequestError('No record', {
    code: 'P2025',
    clientVersion: 'test',
  });

function setup() {
  const tx = {
    account: { findFirst: vi.fn().mockResolvedValue({ id: 'acc' }) },
    member: { findFirst: vi.fn().mockResolvedValue({ id: MEMBER }) },
    device: { findFirst: vi.fn().mockResolvedValue({ id: 'dev' }) },
    product: { update: vi.fn(), findFirst: vi.fn() },
    productAudit: { create: vi.fn().mockResolvedValue({}) },
    stockMovement: {
      create: vi.fn().mockImplementation(({ data }) => Promise.resolve(data)),
    },
  };
  const prisma = {
    $transaction: vi.fn((fn: (client: typeof tx) => unknown) => fn(tx)),
  };
  const service = new ProductsService(
    prisma as unknown as PrismaService,
    { getUrl: (path: string) => `/uploads/${path}` } as unknown as StorageService,
  );
  const actor = {
    account: { id: 'acc', contextId: CONTEXT },
    selection: { memberId: MEMBER, deviceId: 'dev' },
  } as never;
  /** Stock/cost the product has right after the atomic increment. */
  const afterIncrement = (stockAfter: number, cost: number | null) =>
    tx.product.update.mockResolvedValueOnce(
      product({ stock: stockAfter, purchaseCostMinor: cost }),
    );
  return { tx, prisma, service, actor, afterIncrement };
}

describe('ProductsService.restock', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  describe('the atomic increment', () => {
    it('adds the quantity with an increment, never read-modify-write', async () => {
      ctx.afterIncrement(15, 1000);

      await ctx.service.restock(ctx.actor, PRODUCT, { quantity: 5 });

      expect(ctx.tx.product.update).toHaveBeenCalledTimes(1);
      expect(ctx.tx.product.update).toHaveBeenCalledWith({
        where: {
          id: PRODUCT,
          contextId: CONTEXT,
          tipo: 'cantidad',
          active: true,
          stock: { lte: MAX_MINOR_UNITS - 5 },
        },
        data: { stock: { increment: 5 } },
      });
      // The stock is never read first, so there is no stale value to write back.
      expect(ctx.tx.product.findFirst).not.toHaveBeenCalled();
    });

    it('runs everything inside one transaction', async () => {
      ctx.afterIncrement(15, 1000);

      await ctx.service.restock(ctx.actor, PRODUCT, { quantity: 5 });

      expect(ctx.prisma.$transaction).toHaveBeenCalledTimes(1);
    });
  });

  describe('result', () => {
    it('returns the updated product and the movement', async () => {
      ctx.afterIncrement(15, 1000);

      const result = await ctx.service.restock(ctx.actor, PRODUCT, {
        quantity: 5,
        note: 'Compra del sábado',
      });

      expect(result.product).toMatchObject({ id: PRODUCT, stock: 15, image: null });
      expect(result.product).not.toHaveProperty('imagePath');
      expect(result.movement).toMatchObject({
        contextId: CONTEXT,
        productId: PRODUCT,
        memberId: MEMBER,
        type: 'REPOSICION',
        quantity: 5,
        stockBefore: 10,
        stockAfter: 15,
        unitCostMinor: null,
        note: 'Compra del sábado',
      });
      expect(result.movement.id).toEqual(expect.any(String));
    });

    it('records the audit trail (who, stock before and after) in the same transaction', async () => {
      ctx.afterIncrement(15, 1000);

      await ctx.service.restock(ctx.actor, PRODUCT, { quantity: 5 });

      const audit = ctx.tx.productAudit.create.mock.calls[0][0].data;
      expect(audit.memberId).toBe(MEMBER);
      expect(audit.productId).toBe(PRODUCT);
      expect(audit.before).toMatchObject({ stock: 10 });
      expect(audit.after).toMatchObject({ stock: 15 });
    });
  });

  describe('weighted-average cost', () => {
    it('empty purchase cost: the product cost is not touched', async () => {
      ctx.afterIncrement(15, 1000);

      await ctx.service.restock(ctx.actor, PRODUCT, { quantity: 5 });

      expect(ctx.tx.product.update).toHaveBeenCalledTimes(1);
    });

    it('stock was 0: the purchase cost becomes the product cost', async () => {
      ctx.afterIncrement(4, 1000);
      ctx.tx.product.update.mockResolvedValueOnce(
        product({ stock: 4, purchaseCostMinor: 1500 }),
      );

      const result = await ctx.service.restock(ctx.actor, PRODUCT, {
        quantity: 4,
        unitCostMinor: 1500,
      });

      expect(ctx.tx.product.update).toHaveBeenLastCalledWith({
        where: { id: PRODUCT },
        data: { purchaseCostMinor: 1500 },
      });
      expect(result.product.purchaseCostMinor).toBe(1500);
      expect(result.movement).toMatchObject({ stockBefore: 0, unitCostMinor: 1500 });
    });

    it('stock > 0 and a current cost: weighted average', async () => {
      ctx.afterIncrement(5, 1000); // before: 3
      ctx.tx.product.update.mockResolvedValueOnce(
        product({ stock: 5, purchaseCostMinor: 1040 }),
      );

      await ctx.service.restock(ctx.actor, PRODUCT, {
        quantity: 2,
        unitCostMinor: 1100,
      });

      // (3 x 1000 + 2 x 1100) / 5
      expect(ctx.tx.product.update).toHaveBeenLastCalledWith({
        where: { id: PRODUCT },
        data: { purchaseCostMinor: 1040 },
      });
    });

    it('stock > 0 and an unknown cost: not touched (unknown is not zero)', async () => {
      ctx.afterIncrement(15, null);

      const result = await ctx.service.restock(ctx.actor, PRODUCT, {
        quantity: 5,
        unitCostMinor: 1100,
      });

      expect(ctx.tx.product.update).toHaveBeenCalledTimes(1);
      expect(result.product.purchaseCostMinor).toBeNull();
      // The cost of the purchase is still recorded on the movement.
      expect(result.movement.unitCostMinor).toBe(1100);
    });

    it('a purchase at the same cost writes nothing extra', async () => {
      ctx.afterIncrement(15, 1000);

      await ctx.service.restock(ctx.actor, PRODUCT, {
        quantity: 5,
        unitCostMinor: 1000,
      });

      expect(ctx.tx.product.update).toHaveBeenCalledTimes(1);
    });

    it('records the cost change in the audit snapshot', async () => {
      ctx.afterIncrement(5, 1000);
      ctx.tx.product.update.mockResolvedValueOnce(
        product({ stock: 5, purchaseCostMinor: 1040 }),
      );

      await ctx.service.restock(ctx.actor, PRODUCT, { quantity: 2, unitCostMinor: 1100 });

      const audit = ctx.tx.productAudit.create.mock.calls[0][0].data;
      expect(audit.before).toMatchObject({ stock: 3, purchaseCostMinor: 1000 });
      expect(audit.after).toMatchObject({ stock: 5, purchaseCostMinor: 1040 });
    });
  });

  describe('rejections (no movement and no audit row are written)', () => {
    const expectNothingWritten = () => {
      expect(ctx.tx.stockMovement.create).not.toHaveBeenCalled();
      expect(ctx.tx.productAudit.create).not.toHaveBeenCalled();
    };

    it('404 when the product does not exist in this context', async () => {
      ctx.tx.product.update.mockRejectedValueOnce(notFound());
      ctx.tx.product.findFirst.mockResolvedValueOnce(null);

      await expect(
        ctx.service.restock(ctx.actor, PRODUCT, { quantity: 1 }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expectNothingWritten();
    });

    it('400 for a unique piece ("única" is never restocked)', async () => {
      ctx.tx.product.update.mockRejectedValueOnce(notFound());
      ctx.tx.product.findFirst.mockResolvedValueOnce(product({ tipo: 'unica', stock: 0 }));

      await expect(
        ctx.service.restock(ctx.actor, PRODUCT, { quantity: 1 }),
      ).rejects.toThrow(BadRequestException);
      expectNothingWritten();
    });

    it('400 for a deactivated product', async () => {
      ctx.tx.product.update.mockRejectedValueOnce(notFound());
      ctx.tx.product.findFirst.mockResolvedValueOnce(product({ active: false }));

      await expect(
        ctx.service.restock(ctx.actor, PRODUCT, { quantity: 1 }),
      ).rejects.toThrow(/reactivate/i);
      expectNothingWritten();
    });

    it('400 when the resulting stock would exceed the maximum', async () => {
      ctx.tx.product.update.mockRejectedValueOnce(notFound());
      ctx.tx.product.findFirst.mockResolvedValueOnce(product({ stock: MAX_MINOR_UNITS }));

      await expect(
        ctx.service.restock(ctx.actor, PRODUCT, { quantity: 1 }),
      ).rejects.toThrow(/maximum/i);
      expectNothingWritten();
    });

    it('rethrows any other database error untouched', async () => {
      const failure = new Error('connection lost');
      ctx.tx.product.update.mockRejectedValueOnce(failure);

      await expect(
        ctx.service.restock(ctx.actor, PRODUCT, { quantity: 1 }),
      ).rejects.toBe(failure);
    });

    it('rethrows a Prisma error that is not "record not found"', async () => {
      const failure = new Prisma.PrismaClientKnownRequestError('boom', {
        code: 'P2002',
        clientVersion: 'test',
      });
      ctx.tx.product.update.mockRejectedValueOnce(failure);

      await expect(
        ctx.service.restock(ctx.actor, PRODUCT, { quantity: 1 }),
      ).rejects.toBe(failure);
    });
  });

  describe('authorization', () => {
    it('403 without a selected member/device, before touching any stock', async () => {
      await expect(
        ctx.service.restock(
          { account: { id: 'acc', contextId: CONTEXT }, selection: undefined } as never,
          PRODUCT,
          { quantity: 1 },
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(ctx.tx.product.update).not.toHaveBeenCalled();
    });

    it('403 when the member is not an active socio of this context', async () => {
      ctx.tx.member.findFirst.mockResolvedValueOnce(null);

      await expect(
        ctx.service.restock(ctx.actor, PRODUCT, { quantity: 1 }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(ctx.tx.product.update).not.toHaveBeenCalled();
    });
  });
});

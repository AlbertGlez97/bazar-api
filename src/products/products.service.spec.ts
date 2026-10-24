import { describe, expect, it, vi } from 'vitest';
import { ProductsService } from './products.service.js';
import { ProductListDto } from './dto/product.dto.js';
import type { PrismaService } from '../database/prisma.service.js';
import type { StorageService } from '../storage/storage.service.js';

function setup() {
  const findMany = vi.fn().mockReturnValue('findMany-query');
  const count = vi.fn().mockReturnValue('count-query');
  const prisma = {
    product: { findMany, count },
    $transaction: vi.fn().mockResolvedValue([[], 0]),
  };
  const service = new ProductsService(
    prisma as unknown as PrismaService,
    {} as StorageService,
  );
  const list = (query: Partial<ProductListDto>) =>
    service.list(
      'ctx-1',
      Object.assign(new ProductListDto(), query),
      null,
    );
  const whereOf = () =>
    (findMany.mock.calls[0][0] as { where: Record<string, unknown> }).where;
  return { list, whereOf, count, findMany };
}

describe('ProductsService.list catalog filters', () => {
  it('applies no extra filter when none is sent', async () => {
    const { list, whereOf } = setup();

    await list({});

    expect(whereOf()).toEqual({ contextId: 'ctx-1', active: true });
  });

  it('agotados=true keeps only products with no stock', async () => {
    const { list, whereOf } = setup();

    await list({ agotados: true });

    expect(whereOf()).toMatchObject({ stock: 0 });
  });

  it('agotados=false means "no filter", not "only in stock"', async () => {
    const { list, whereOf } = setup();

    await list({ agotados: false });

    expect(whereOf()).not.toHaveProperty('stock');
  });

  it('sinCosto=true keeps only products without a purchase cost', async () => {
    const { list, whereOf } = setup();

    await list({ sinCosto: true });

    expect(whereOf()).toMatchObject({ purchaseCostMinor: null });
  });

  it('sinCosto=false means "no filter"', async () => {
    const { list, whereOf } = setup();

    await list({ sinCosto: false });

    expect(whereOf()).not.toHaveProperty('purchaseCostMinor');
  });

  it('filters by tipo', async () => {
    const { list, whereOf } = setup();

    await list({ tipo: 'unica' });

    expect(whereOf()).toMatchObject({ tipo: 'unica' });
  });

  it('agotados wins over umbral: stock <= umbral AND stock = 0 is stock = 0', async () => {
    const { list, whereOf } = setup();

    await list({ umbral: 2, agotados: true });

    // umbral is validated >= 0, so "out of stock" is always inside it.
    expect(whereOf()).toMatchObject({ stock: 0 });
  });

  it('umbral alone keeps its inclusive stock <= umbral filter', async () => {
    const { list, whereOf } = setup();

    await list({ umbral: 2 });

    expect(whereOf()).toMatchObject({ stock: { lte: 2 } });
  });

  it('uses the same where for the page and the total', async () => {
    const { list, findMany, count } = setup();

    await list({ tipo: 'cantidad', sinCosto: true, agotados: true });

    expect((count.mock.calls[0][0] as { where: unknown }).where).toBe(
      (findMany.mock.calls[0][0] as { where: unknown }).where,
    );
  });
});

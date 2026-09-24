import { vi } from 'vitest';
import type { PrismaService } from '../src/database/prisma.service.js';
import type { Prisma } from '../src/generated/prisma/client.js';

/** Make both real transactions observe stock before either attempts its lock. */
export async function withStockRace<T>(
  prisma: PrismaService,
  run: () => Promise<T>,
) {
  const transaction = prisma.$transaction.bind(prisma);
  let arrivals = 0;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const spy = vi.spyOn(prisma, '$transaction').mockImplementation((async (
    callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
  ) =>
    transaction(async (tx) => {
      const find = tx.product.findFirst.bind(tx.product);
      let first = true;
      tx.product.findFirst = (async (...args: Parameters<typeof find>) => {
        const product = await find(...args);
        if (first) {
          first = false;
          if (++arrivals === 2) release();
          await ready;
        }
        return product;
      }) as typeof tx.product.findFirst;
      return callback(tx);
    })) as typeof prisma.$transaction);
  try {
    return await run();
  } finally {
    spy.mockRestore();
  }
}

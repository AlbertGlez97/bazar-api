import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SalesService } from './sales.service.js';
import type { PrismaService } from '../database/prisma.service.js';

describe('sale device clock tolerance', () => {
  const now = new Date('2026-10-01T12:00:00.000Z');
  const actor = {
    account: {
      id: 'account',
      contextId: 'context',
      email: 'a@example.test',
      active: true,
    },
    selection: { memberId: 'member', deviceId: 'device' },
  };

  beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }).setSystemTime(now));
  afterEach(() => vi.useRealTimers());

  async function register(offset: number) {
    const create = vi.fn(({ data }) => Promise.resolve({ ...data, items: [] }));
    const tx = {
      account: { findFirst: vi.fn().mockResolvedValue(actor.account) },
      member: { findFirst: vi.fn().mockResolvedValue({ id: 'member' }) },
      device: { findFirst: vi.fn().mockResolvedValue({ id: 'device' }) },
      product: {
        findFirst: vi
          .fn()
          .mockResolvedValue({
            id: 'product',
            active: true,
            stock: 2,
            unitPriceMinor: 500,
            purchaseCostMinor: null,
          }),
        update: vi.fn().mockResolvedValue({}),
      },
      $queryRaw: vi.fn().mockResolvedValue([]),
      sale: { create },
    };
    const prisma = {
      sale: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn((callback) => callback(tx)),
    };
    const service = new SalesService(prisma as unknown as PrismaService);
    await service.create(actor, {
      id: 'sale',
      memberId: 'member',
      deviceId: 'device',
      currency: 'MXN',
      occurredAt: new Date(now.getTime() + offset).toISOString(),
      cashReceivedMinor: 500,
      items: [{ productId: 'product', quantity: 1 }],
    });
    return create.mock.calls[0][0].data;
  }

  it.each([0, 1, 10_000, 60_000, 299_999, 300_000])(
    'accepts %i ms ahead without an incident',
    async (offset) => {
      const sale = await register(offset);
      expect(sale.status).toBe('completada');
      expect(sale).not.toHaveProperty('incidencias');
    },
  );

  it.each([300_001, 3 * 3_600_000])(
    'flags %i ms ahead with a human-readable reason',
    async (offset) => {
      const sale = await register(offset);
      expect(sale.status).toBe('completada');
      expect(sale.incidencias.create.type).toBe('incidencia_fecha');
      expect(sale.incidencias.create.reason).toBe(
        'La fecha registrada por el dispositivo parece estar adelantada. Revisa el reloj de la tablet.',
      );
    },
  );

  it('preserves the exact two-day past boundary', async () => {
    expect(await register(-2 * 86_400_000)).not.toHaveProperty('incidencias');
    expect((await register(-2 * 86_400_000 - 1)).incidencias.create.type).toBe(
      'incidencia_fecha',
    );
  });
});

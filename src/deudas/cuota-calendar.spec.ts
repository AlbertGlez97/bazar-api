import { afterEach, describe, expect, it, vi } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { readFileSync } from 'node:fs';
import { DeudasService } from './deudas.service.js';
import { CreateCuotaDto, UpdateCuotaDto } from './dto/cuota-planeada.dto.js';
import type { PrismaService } from '../database/prisma.service.js';

describe('installment calendar contract', () => {
  afterEach(() => vi.useRealTimers());

  it.each([
    null,
    '0000-01-01',
    '2026-02-30',
    '2025-02-29',
    '2026-13-01',
    '2026-10-01T00:00:00.000Z',
    '2026-1-1',
  ])('rejects %s on create and patch', async (fechaEsperada) => {
    for (const Dto of [CreateCuotaDto, UpdateCuotaDto]) {
      const errors = await validate(
        plainToInstance(Dto, { fechaEsperada, montoEsperadoMinor: 100 }),
      );
      expect(errors.map((e) => e.property)).toContain('fechaEsperada');
    }
  });

  it.each(['2026-10-01', '2028-02-29'])(
    'accepts real day %s',
    async (fechaEsperada) => {
      expect(
        await validate(
          plainToInstance(CreateCuotaDto, {
            fechaEsperada,
            montoEsperadoMinor: 100,
          }),
        ),
      ).toEqual([]);
    },
  );

  it('uses DATE storage and explicitly preserves historical UTC days', () => {
    const schema = readFileSync('prisma/schema.prisma', 'utf8');
    expect(schema).toMatch(/fechaEsperada\s+DateTime\s+@db.Date\b/);
    const migration = readFileSync(
      'prisma/migrations/20261001160000_installment_calendar_date/migration.sql',
      'utf8',
    );
    expect(migration).toContain('TYPE DATE');
    expect(migration).toContain("AT TIME ZONE 'UTC'");
  });

  function fixture() {
    const cuota = {
      id: 'cuota',
      deudaId: 'deuda',
      contextId: 'context',
      fechaEsperada: new Date('2026-10-01T00:00:00.000Z'),
      montoEsperadoMinor: 100,
      createdAt: new Date('2026-09-01T12:00:00.000Z'),
    };
    const deuda = {
      id: 'deuda',
      createdAt: new Date('2026-09-01T12:00:00.000Z'),
      totalMinor: 100,
      abonos: [],
      cuotasPlaneadas: [cuota],
    };
    const tx = {
      account: { findFirst: vi.fn().mockResolvedValue({ id: 'account' }) },
      member: { findFirst: vi.fn().mockResolvedValue({ id: 'member' }) },
      device: { findFirst: vi.fn().mockResolvedValue({ id: 'device' }) },
      deuda: { findFirst: vi.fn().mockResolvedValue(deuda) },
      cuotaPlaneada: {
        create: vi.fn().mockResolvedValue(cuota),
        update: vi.fn().mockResolvedValue(cuota),
        delete: vi.fn().mockResolvedValue(cuota),
        findFirst: vi.fn().mockResolvedValue(cuota),
      },
    };
    const prisma = {
      deuda: {
        findFirst: vi.fn().mockResolvedValue(deuda),
        findMany: vi.fn().mockResolvedValue([deuda]),
        count: vi.fn().mockResolvedValue(1),
      },
      $transaction: vi.fn((arg) =>
        typeof arg === 'function' ? arg(tx) : Promise.all(arg),
      ),
    };
    const actor = {
      account: {
        id: 'account',
        contextId: 'context',
        email: 'a@example.test',
        active: true,
      },
      selection: { memberId: 'member', deviceId: 'device' },
    };
    return {
      service: new DeudasService(prisma as unknown as PrismaService),
      actor,
      tx,
    };
  }

  it('returns days, not timestamps, from detail and all cuota mutation responses', async () => {
    const { service, actor, tx } = fixture();
    expect(
      (await service.findOne('context', 'deuda')).cuotasPlaneadas[0]
        .fechaEsperada,
    ).toBe('2026-10-01');
    const input = { fechaEsperada: '2026-10-01', montoEsperadoMinor: 100 };
    expect((await service.addCuota(actor, 'deuda', input)).fechaEsperada).toBe(
      '2026-10-01',
    );
    expect(
      (await service.updateCuota(actor, 'deuda', 'cuota', input)).fechaEsperada,
    ).toBe('2026-10-01');
    expect(
      (await service.deleteCuota(actor, 'deuda', 'cuota')).fechaEsperada,
    ).toBe('2026-10-01');
    expect(
      tx.cuotaPlaneada.create.mock.calls[0][0].data.fechaEsperada.toISOString(),
    ).toBe('2026-10-01T00:00:00.000Z');
  });

  it('serializes both list paths and becomes overdue only after business midnight', async () => {
    const { service } = fixture();
    vi.useFakeTimers({ toFake: ['Date'] });
    const query = {
      orderBy: 'createdAt' as const,
      sort: 'asc' as const,
      page: 1,
      limit: 20,
    };
    expect(
      (await service.list('context', query)).items[0].cuotasPlaneadas[0]
        .fechaEsperada,
    ).toBe('2026-10-01');
    vi.setSystemTime(new Date('2026-10-02T05:59:59.999Z'));
    expect(
      (await service.list('context', { ...query, atrasado: true })).total,
    ).toBe(0);
    vi.setSystemTime(new Date('2026-10-02T06:00:00.000Z'));
    const result = await service.list('context', { ...query, atrasado: true });
    expect(result.total).toBe(1);
    expect(result.items[0].cuotasPlaneadas[0].fechaEsperada).toBe('2026-10-01');
  });
});

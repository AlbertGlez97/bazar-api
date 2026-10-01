import { describe, expect, it, vi } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import type { PrismaService } from '../database/prisma.service.js';
import { DeudasService } from './deudas.service.js';
import { CreateDeudaDto } from './dto/create-deuda.dto.js';

const id = '0199a10c-4b80-7000-8000-000000000001';
const actor = {
  account: {
    id: 'account',
    contextId: 'context',
    email: 'a@example.test',
    active: true,
  },
  selection: { memberId: 'member', deviceId: 'device' },
};
const payload = {
  id,
  type: 'fiado',
  productId: '0199a10c-4b80-7000-8000-000000000002',
  cantidad: 1,
  deudor: { nombre: 'Customer' },
  abonoInicialMinor: 100,
  cuotasPlaneadas: [{ fechaEsperada: '2026-10-15', montoEsperadoMinor: 900 }],
} satisfies CreateDeudaDto & { id: string };

function fixture() {
  let stored: Record<string, unknown> | null = null;
  const tx = {
    account: { findFirst: vi.fn().mockResolvedValue({ id: 'account' }) },
    member: { findFirst: vi.fn().mockResolvedValue({ id: 'member' }) },
    device: { findFirst: vi.fn().mockResolvedValue({ id: 'device' }) },
    deudor: {
      create: vi.fn().mockResolvedValue({ id: 'debtor' }),
      findFirst: vi.fn().mockResolvedValue({ id: 'debtor' }),
    },
    product: {
      findFirst: vi.fn().mockResolvedValue({
        id: payload.productId,
        stock: 1,
        active: true,
        unitPriceMinor: 1000,
        purchaseCostMinor: 500,
      }),
      update: vi.fn().mockResolvedValue({}),
    },
    abono: { create: vi.fn().mockResolvedValue({}) },
    cuotaPlaneada: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
    deuda: {
      findFirst: vi.fn(async () => stored),
      create: vi.fn(async ({ data }) => {
        stored = {
          ...data,
          status: 'pendiente',
          saldadaAt: null,
          createdAt: new Date('2026-10-01T12:00:00Z'),
        };
        return stored;
      }),
      findUniqueOrThrow: vi.fn(async () => ({
        ...stored,
        abonos: [
          {
            id: 'initial',
            montoMinor: 100,
            receivedAt: new Date('2026-10-01T12:00:00Z'),
          },
        ],
        cuotasPlaneadas: [
          { id: 'schedule', fechaEsperada: new Date('2026-10-15T00:00:00Z') },
        ],
      })),
      update: vi.fn(async ({ data }) => {
        stored = { ...stored, ...data };
        return stored;
      }),
    },
    $queryRaw: vi.fn().mockResolvedValue([]),
  };
  const prisma = { $transaction: vi.fn(async (fn) => fn(tx)) };
  return {
    tx,
    prisma,
    service: new DeudasService(prisma as unknown as PrismaService),
    mutate: (data: Record<string, unknown>) => {
      stored = { ...stored, ...data };
    },
  };
}

describe('debt client idempotency', () => {
  it('validates a supplied UUID and preserves legacy clients without an id', async () => {
    for (const candidate of ['invalid', null, '']) {
      const errors = await validate(
        plainToInstance(CreateDeudaDto, { ...payload, id: candidate }),
      );
      expect(errors.map((error) => error.property)).toContain('id');
    }
    const { id: _id, ...legacy } = payload;
    expect(await validate(plainToInstance(CreateDeudaDto, legacy))).toEqual([]);
    expect(await validate(plainToInstance(CreateDeudaDto, payload))).toEqual(
      [],
    );
    const f = fixture();
    await f.service.create(actor, legacy);
    expect(f.tx.deuda.create.mock.calls[0][0].data.id).not.toBe(id);
  });

  it.each(['fiado', 'apartado'] as const)(
    'replays %s with no duplicated effects or internal fields',
    async (type) => {
      const f = fixture();
      const dto = { ...payload, type };
      const first = await f.service.create(actor, dto);
      expect(first).toMatchObject({ id });
      expect(first).not.toHaveProperty('requestFingerprint');
      expect(first).not.toHaveProperty('creationResponse');
      f.mutate({ status: 'saldada', totalMinor: 2000 });
      f.tx.product.findFirst.mockResolvedValue(null);
      expect(await f.service.create(actor, dto)).toEqual(first);
      expect(f.tx.product.update).toHaveBeenCalledTimes(1);
      expect(f.tx.deudor.create).toHaveBeenCalledTimes(1);
      expect(f.tx.deuda.create).toHaveBeenCalledTimes(1);
      expect(f.tx.abono.create).toHaveBeenCalledTimes(1);
      expect(f.tx.cuotaPlaneada.createMany).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { cantidad: 2 },
    { type: 'apartado' },
    { abonoInicialMinor: 0 },
    { deudor: { nombre: 'Other' } },
    { deudor: { nombre: 'Customer', telefono: '123' } },
    {
      cuotasPlaneadas: [
        { fechaEsperada: '2026-10-16', montoEsperadoMinor: 900 },
      ],
    },
  ])('rejects changed input %j with 409', async (change) => {
    const f = fixture();
    await f.service.create(actor, payload);
    await expect(
      f.service.create(actor, { ...payload, ...change } as typeof payload),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(f.tx.product.update).toHaveBeenCalledTimes(1);
  });

  it('canonicalizes nested key order without changing payment schedule semantics', async () => {
    const f = fixture();
    const first = await f.service.create(actor, payload);
    expect(
      await f.service.create(actor, {
        ...payload,
        cuotasPlaneadas: [
          { montoEsperadoMinor: 900, fechaEsperada: '2026-10-15' },
        ],
      }),
    ).toEqual(first);
  });

  it.each(['memberId', 'deviceId'] as const)(
    'rejects a changed originating %s',
    async (field) => {
      const f = fixture();
      await f.service.create(actor, payload);
      await expect(
        f.service.create(
          { ...actor, selection: { ...actor.selection, [field]: 'other' } },
          payload,
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    },
  );

  it('reauthorizes replay before reading any receipt', async () => {
    const f = fixture();
    await f.service.create(actor, payload);
    f.tx.device.findFirst.mockResolvedValue(null);
    await expect(f.service.create(actor, payload)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(f.tx.deuda.findFirst).toHaveBeenCalledTimes(1);
  });

  it('scopes receipt lookup to the authenticated tenant and rejects historical IDs', async () => {
    const f = fixture();
    f.mutate({
      id,
      contextId: 'context',
      requestFingerprint: null,
      creationResponse: null,
    });
    await expect(f.service.create(actor, payload)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(f.tx.deuda.findFirst).toHaveBeenCalledWith({
      where: { id, contextId: 'context' },
    });
  });

  it.each([
    new BadRequestException('Insufficient stock'),
    new Prisma.PrismaClientKnownRequestError('Duplicate debt', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { modelName: 'Deuda', target: ['id'] },
    }),
  ])(
    'rereads the committed winner after a known concurrent transaction failure',
    async (error) => {
      const f = fixture();
      const first = await f.service.create(actor, payload);
      f.prisma.$transaction.mockRejectedValueOnce(error);
      expect(await f.service.create(actor, payload)).toEqual(first);
      expect(f.tx.product.update).toHaveBeenCalledTimes(1);
      expect(f.tx.device.findFirst).toHaveBeenCalledTimes(2);
    },
  );

  it('preserves genuine stock failures and unrelated infrastructure errors', async () => {
    const f = fixture();
    f.tx.product.findFirst.mockResolvedValue({
      id: payload.productId,
      stock: 0,
      active: true,
      unitPriceMinor: 1000,
      purchaseCostMinor: 500,
    });
    await expect(f.service.create(actor, payload)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    const error = new Error('Connection unavailable');
    f.prisma.$transaction.mockRejectedValueOnce(error);
    await expect(f.service.create(actor, payload)).rejects.toBe(error);
  });

  it('does not reinterpret another model unique constraint as a debt-ID race', async () => {
    const f = fixture();
    await f.service.create(actor, payload);
    const error = new Prisma.PrismaClientKnownRequestError('Other unique key', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { modelName: 'Deudor', target: ['id'] },
    });
    f.prisma.$transaction.mockRejectedValueOnce(error);
    await expect(f.service.create(actor, payload)).rejects.toBe(error);
  });

  it('returns a generic conflict for a debt ID hidden by tenant isolation', async () => {
    const f = fixture();
    const error = new Prisma.PrismaClientKnownRequestError('Duplicate debt', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { modelName: 'Deuda', target: ['id'] },
    });
    f.prisma.$transaction.mockRejectedValueOnce(error);
    const result = f.service.create(actor, payload);
    await expect(result).rejects.toBeInstanceOf(ConflictException);
    await expect(result).rejects.toThrow('Debt creation ID is unavailable');
    expect(f.tx.deuda.findFirst).toHaveBeenCalledWith({
      where: { id, contextId: 'context' },
    });
    expect(f.tx.deuda.create).not.toHaveBeenCalled();
  });

  it('compares payload and reauthorizes when recovering a concurrent winner', async () => {
    const f = fixture();
    await f.service.create(actor, payload);
    f.prisma.$transaction.mockRejectedValueOnce(
      new BadRequestException('Stock'),
    );
    await expect(
      f.service.create(actor, { ...payload, abonoInicialMinor: 200 }),
    ).rejects.toBeInstanceOf(ConflictException);
    f.tx.device.findFirst.mockResolvedValue(null);
    f.prisma.$transaction.mockRejectedValueOnce(
      new BadRequestException('Stock'),
    );
    await expect(f.service.create(actor, payload)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});

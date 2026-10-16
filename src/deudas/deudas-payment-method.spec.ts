import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ConflictException } from '@nestjs/common';
import type { PrismaService } from '../database/prisma.service.js';
import { DeudasService } from './deudas.service.js';
import type { CreateDeudaDto } from './dto/create-deuda.dto.js';

const id = '0199a10c-4b80-7000-8000-000000000001';
const deudaId = '0199a10c-4b80-7000-8000-0000000000dd';
const actor = {
  account: { id: 'account', contextId: 'context', email: 'a@example.test', active: true },
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

/** The fingerprint exactly as it was stored before payment methods existed. */
function legacyFingerprint(dto: typeof payload) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        contextId: actor.account.contextId,
        accountId: actor.account.id,
        memberId: actor.selection.memberId,
        deviceId: actor.selection.deviceId,
        type: dto.type,
        productId: dto.productId.toLowerCase(),
        cantidad: dto.cantidad,
        deudorId: null,
        deudor: { nombre: dto.deudor.nombre, telefono: null, notas: null },
        abonoInicialMinor: dto.abonoInicialMinor,
        cuotasPlaneadas: dto.cuotasPlaneadas.map((cuota) => ({
          fechaEsperada: cuota.fechaEsperada,
          montoEsperadoMinor: cuota.montoEsperadoMinor,
        })),
      }),
    )
    .digest('hex');
}

function fixture(initiallyStored: Record<string, unknown> | null = null) {
  let stored: Record<string, unknown> | null = initiallyStored;
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
    abono: {
      create: vi.fn().mockResolvedValue({}),
      aggregate: vi.fn().mockResolvedValue({ _sum: { montoMinor: 100 } }),
    },
    cuotaPlaneada: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
    deuda: {
      // registerAbono looks the debt up through its member's context; create()
      // only looks for an already-stored receipt (a replay) by id + context.
      findFirst: vi.fn(async (args?: { where?: { createdByMember?: unknown } }) =>
        args?.where?.createdByMember ? { id: deudaId, totalMinor: 1000 } : stored,
      ),
      create: vi.fn(async ({ data }) => {
        stored = { ...data, status: 'pendiente', saldadaAt: null, createdAt: new Date('2026-10-01T12:00:00Z') };
        return stored;
      }),
      update: vi.fn(async ({ data }) => {
        stored = { ...stored, ...data };
        return stored;
      }),
      findUniqueOrThrow: vi.fn(async () => ({
        ...(stored ?? { id: deudaId, totalMinor: 1000 }),
        abonos: [],
        cuotasPlaneadas: [],
      })),
    },
    $queryRaw: vi.fn().mockResolvedValue([]),
  };
  const prisma = { $transaction: vi.fn(async (fn) => fn(tx)) };
  return { tx, service: new DeudasService(prisma as unknown as PrismaService) };
}

const abonoData = (f: ReturnType<typeof fixture>) => f.tx.abono.create.mock.calls[0][0].data;

describe('POST /deudas — the initial abono payment method', () => {
  it.each([undefined, null, 'EFECTIVO'] as const)(
    'method %s: the initial abono is stored as EFECTIVO',
    async (abonoInicialPaymentMethod) => {
      const f = fixture();

      await f.service.create(actor, { ...payload, abonoInicialPaymentMethod });

      expect(abonoData(f)).toMatchObject({ montoMinor: 100, paymentMethod: 'EFECTIVO' });
    },
  );

  it.each(['TRANSFERENCIA', 'TARJETA'] as const)('%s is stored on the initial abono', async (abonoInicialPaymentMethod) => {
    const f = fixture();

    await f.service.create(actor, { ...payload, abonoInicialPaymentMethod });

    expect(abonoData(f)).toMatchObject({ montoMinor: 100, paymentMethod: abonoInicialPaymentMethod });
  });

  it('the method changes neither the inventory nor the debt itself', async () => {
    const cash = fixture();
    const card = fixture();

    await cash.service.create(actor, payload);
    await card.service.create(actor, { ...payload, abonoInicialPaymentMethod: 'TARJETA' });

    expect(card.tx.product.update.mock.calls).toEqual(cash.tx.product.update.mock.calls);
    const strip = ({ requestFingerprint: _f, creationResponse: _c, ...rest }: Record<string, unknown>) => rest;
    expect(strip(card.tx.deuda.create.mock.calls[0][0].data)).toEqual(
      strip(cash.tx.deuda.create.mock.calls[0][0].data),
    );
  });

  it('with no initial abono there is no abono to carry a method', async () => {
    const f = fixture();

    await f.service.create(actor, { ...payload, abonoInicialMinor: 0, abonoInicialPaymentMethod: 'TARJETA' });

    expect(f.tx.abono.create).not.toHaveBeenCalled();
  });
});

describe('POST /deudas — idempotency with and without the method', () => {
  /** A debt stored before this version: legacy fingerprint, receipt snapshot saved. */
  const legacyDebt = () => ({
    id,
    contextId: 'context',
    requestFingerprint: legacyFingerprint(payload),
    creationResponse: { id, snapshot: 'stored-before-this-version' },
  });

  it('a debt queued before this version (no method) replays: no 409 and no new effects', async () => {
    const f = fixture(legacyDebt());

    const result = await f.service.create(actor, payload);

    expect(result).toEqual({ id, snapshot: 'stored-before-this-version' });
    expect(f.tx.deuda.create).not.toHaveBeenCalled();
    expect(f.tx.abono.create).not.toHaveBeenCalled();
    expect(f.tx.product.update).not.toHaveBeenCalled();
  });

  it('an explicit EFECTIVO (or null) compares equal to an absent method', async () => {
    const f = fixture(legacyDebt());

    await expect(f.service.create(actor, { ...payload, abonoInicialPaymentMethod: 'EFECTIVO' })).resolves.toMatchObject({ id });
    await expect(f.service.create(actor, { ...payload, abonoInicialPaymentMethod: null })).resolves.toMatchObject({ id });
  });

  it('the same id resent with another method for the initial abono is a different request: 409', async () => {
    const f = fixture(legacyDebt());

    await expect(
      f.service.create(actor, { ...payload, abonoInicialPaymentMethod: 'TRANSFERENCIA' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('a debt created with TARJETA replays unchanged, and 409s as EFECTIVO or TRANSFERENCIA', async () => {
    const f = fixture();
    const first = await f.service.create(actor, { ...payload, abonoInicialPaymentMethod: 'TARJETA' });

    await expect(f.service.create(actor, { ...payload, abonoInicialPaymentMethod: 'TARJETA' })).resolves.toEqual(first);
    await expect(f.service.create(actor, payload)).rejects.toBeInstanceOf(ConflictException);
    await expect(
      f.service.create(actor, { ...payload, abonoInicialPaymentMethod: 'TRANSFERENCIA' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('the fingerprint of an EFECTIVO debt is byte-identical to the legacy one', async () => {
    const f = fixture();

    await f.service.create(actor, payload);

    expect(f.tx.deuda.create.mock.calls[0][0].data.requestFingerprint).toBe(legacyFingerprint(payload));
  });
});

describe('POST /deudas/:id/abonos — the abono payment method', () => {
  it.each([undefined, null, 'EFECTIVO'] as const)('method %s: stored as EFECTIVO', async (paymentMethod) => {
    const f = fixture();

    await f.service.registerAbono(actor, deudaId, { montoMinor: 200, paymentMethod });

    expect(abonoData(f)).toMatchObject({ montoMinor: 200, paymentMethod: 'EFECTIVO' });
  });

  it.each(['TRANSFERENCIA', 'TARJETA'] as const)('%s is stored on the abono', async (paymentMethod) => {
    const f = fixture();

    await f.service.registerAbono(actor, deudaId, { montoMinor: 200, paymentMethod });

    expect(abonoData(f)).toMatchObject({ montoMinor: 200, paymentMethod });
  });

  it('the method does not change the balance rules: settling works the same with a card', async () => {
    const cash = fixture();
    const card = fixture();

    await cash.service.registerAbono(actor, deudaId, { montoMinor: 900 });
    await card.service.registerAbono(actor, deudaId, { montoMinor: 900, paymentMethod: 'TARJETA' });

    expect(card.tx.deuda.update.mock.calls[0][0].data.status).toBe('saldada');
    expect(card.tx.deuda.update.mock.calls[0][0].data.status).toBe(cash.tx.deuda.update.mock.calls[0][0].data.status);
  });

  it('an abono over the balance is rejected whatever the method', async () => {
    const f = fixture();

    await expect(
      f.service.registerAbono(actor, deudaId, { montoMinor: 901, paymentMethod: 'TRANSFERENCIA' }),
    ).rejects.toThrow(/exceeds the remaining balance/);
    expect(f.tx.abono.create).not.toHaveBeenCalled();
  });
});

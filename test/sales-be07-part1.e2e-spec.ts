import { withStockRace } from './stock-race.js';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { expectUuidV7 } from './uuid-v7.js';

/**
 * BE-07 Part 1 fixes: the P2002 same-brand-new-id race, and occurredAt
 * range validation producing an Incidencia instead of blocking the sale.
 */
describe('sale creation fixes (BE-07 part 1)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  let memberId: string;
  let deviceId: string;
  const contextId = `be07-part1-${randomUUID()}`;

  const write = (req: request.Test) =>
    req
      .auth(token, { type: 'bearer' })
      .set('x-member-id', memberId)
      .set('x-device-id', deviceId);

  const createProduct = (data: {
    name: string;
    tipo: 'unica' | 'cantidad';
    unitPriceMinor: number;
    stock: number;
  }) =>
    prisma.product.create({
      data: {
        name: data.name,
        tipo: data.tipo,
        unitPriceMinor: data.unitPriceMinor,
        initialStock: data.stock,
        stock: data.stock,
        contextId,
      },
    });

  const saleBody = (
    overrides: Partial<{
      id: string;
      occurredAt: string;
      cashReceivedMinor: number;
      items: { productId: string; quantity: number }[];
    }> = {},
  ) => ({
    id: overrides.id ?? randomUUID(),
    memberId,
    deviceId,
    occurredAt: overrides.occurredAt ?? new Date().toISOString(),
    currency: 'MXN',
    cashReceivedMinor: overrides.cashReceivedMinor ?? 0,
    items: overrides.items ?? [],
  });

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    const account = await prisma.account.create({
      data: {
        username: randomUUID(),
        passwordHash: 'not-a-login-fixture',
        contextId,
      },
    });
    token = await app.get(JwtService).signAsync({ sub: account.id });
    memberId = (
      await prisma.member.create({
        data: { name: 'Socio BE07', role: 'socio', contextId },
      })
    ).id;
    deviceId = (
      await prisma.device.create({
        data: {
          name: 'BE07 tablet',
          identifier: randomUUID(),
          contextId,
          authorized: true,
        },
      })
    ).id;
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.incidencia.deleteMany({
        where: { sale: { member: { contextId } } },
      });
      await prisma.saleItem.deleteMany({
        where: { sale: { member: { contextId } } },
      });
      await prisma.sale.deleteMany({ where: { member: { contextId } } });
      await prisma.product.deleteMany({ where: { contextId } });
      await prisma.account.deleteMany({ where: { contextId } });
      await prisma.device.deleteMany({ where: { contextId } });
      await prisma.member.deleteMany({ where: { contextId } });
    }
    await app?.close();
  });

  it('resolves two truly simultaneous requests for the same brand-new id without a 500, discounting stock exactly once', async () => {
    const product = await createProduct({
      name: 'P2002 race fixture',
      tipo: 'cantidad',
      unitPriceMinor: 1000,
      stock: 10,
    });
    const id = randomUUID();
    const body = saleBody({
      id,
      cashReceivedMinor: 2000,
      items: [{ productId: product.id, quantity: 2 }],
    });
    const [resA, resB] = await Promise.all([
      write(request(app.getHttpServer()).post('/sales')).send(body),
      write(request(app.getHttpServer()).post('/sales')).send(body),
    ]);
    // Whichever request the database processed first gets 201 (a genuine
    // creation); the other observes the P2002 unique-violation on Sale.id,
    // re-reads what its sibling persisted, recognizes the identical
    // payload, and answers 200 — neither may surface as a 500, and neither
    // may silently create a second Sale row for the same id.
    expect([200, 201]).toContain(resA.status);
    expect([200, 201]).toContain(resB.status);
    expect(resA.body.id).toBe(id);
    expect(resB.body.id).toBe(id);
    expect(resA.body).toEqual(resB.body);
    expect(await prisma.sale.count({ where: { id } })).toBe(1);
    expect(await prisma.saleItem.count({ where: { saleId: id } })).toBe(1);
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: product.id } }))
        .stock,
    ).toBe(8); // decremented once, not twice.
  });

  it('replays simultaneous identical sales after the winner consumes all stock', async () => {
    const product = await createProduct({
      name: 'Exact stock retry',
      tipo: 'unica',
      unitPriceMinor: 1000,
      stock: 1,
    });
    const body = saleBody({
      cashReceivedMinor: 1000,
      items: [{ productId: product.id, quantity: 1 }],
    });
    const results = await withStockRace(prisma, () =>
      Promise.all([
        write(request(app.getHttpServer()).post('/sales')).send(body),
        write(request(app.getHttpServer()).post('/sales')).send(body),
      ]),
    );
    expect(
      results.map((result) => result.status).sort((a, b) => a - b),
    ).toEqual([200, 201]);
    expect(await prisma.sale.count({ where: { id: body.id } })).toBe(1);
    expect(await prisma.incidencia.count({ where: { saleId: body.id } })).toBe(
      0,
    );
  });

  it('creates an incidencia_fecha Incidencia (and keeps the sale completada) when occurredAt is in the future', async () => {
    const product = await createProduct({
      name: 'Future occurredAt fixture',
      tipo: 'cantidad',
      unitPriceMinor: 500,
      stock: 5,
    });
    const id = randomUUID();
    const future = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
    const res = await write(request(app.getHttpServer()).post('/sales'))
      .send(
        saleBody({
          id,
          occurredAt: future.toISOString(),
          cashReceivedMinor: 500,
          items: [{ productId: product.id, quantity: 1 }],
        }),
      )
      .expect(201);
    expect(res.body.status).toBe('completada');
    const incidencias = await prisma.incidencia.findMany({
      where: { saleId: id },
    });
    expect(incidencias).toHaveLength(1);
    expectUuidV7(incidencias[0].id);
    expect(incidencias[0].type).toBe('incidencia_fecha');
    expect(incidencias[0].resolutionStatus).toBe('pendiente');
  });

  it('creates an incidencia_fecha Incidencia when occurredAt is more than 2 days in the past', async () => {
    const product = await createProduct({
      name: 'Stale occurredAt fixture',
      tipo: 'cantidad',
      unitPriceMinor: 500,
      stock: 5,
    });
    const id = randomUUID();
    const stale = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const res = await write(request(app.getHttpServer()).post('/sales'))
      .send(
        saleBody({
          id,
          occurredAt: stale.toISOString(),
          cashReceivedMinor: 500,
          items: [{ productId: product.id, quantity: 1 }],
        }),
      )
      .expect(201);
    expect(res.body.status).toBe('completada');
    const incidencias = await prisma.incidencia.findMany({
      where: { saleId: id },
    });
    expect(incidencias).toHaveLength(1);
    expect(incidencias[0].type).toBe('incidencia_fecha');
  });

  it('does not create an Incidencia when occurredAt is within the valid range', async () => {
    const product = await createProduct({
      name: 'Valid occurredAt fixture',
      tipo: 'cantidad',
      unitPriceMinor: 500,
      stock: 5,
    });
    const id = randomUUID();
    const withinRange = new Date(Date.now() - 60 * 60 * 1000); // 1h ago
    await write(request(app.getHttpServer()).post('/sales'))
      .send(
        saleBody({
          id,
          occurredAt: withinRange.toISOString(),
          cashReceivedMinor: 500,
          items: [{ productId: product.id, quantity: 1 }],
        }),
      )
      .expect(201);
    expect(await prisma.incidencia.count({ where: { saleId: id } })).toBe(0);
  });

  it('records a real stock conflict and rejects a replay with changed items', async () => {
    const product = await createProduct({
      name: 'Conflict Incidencia fixture',
      tipo: 'unica',
      unitPriceMinor: 15000,
      stock: 1,
    });
    const idA = randomUUID();
    const idB = randomUUID();
    const [resA, resB] = await withStockRace(prisma, () =>
      Promise.all([
        write(request(app.getHttpServer()).post('/sales')).send(
          saleBody({
            id: idA,
            cashReceivedMinor: 15000,
            items: [{ productId: product.id, quantity: 1 }],
          }),
        ),
        write(request(app.getHttpServer()).post('/sales')).send(
          saleBody({
            id: idB,
            cashReceivedMinor: 15000,
            items: [{ productId: product.id, quantity: 1 }],
          }),
        ),
      ]),
    );
    const rejectedId =
      resA.body.status === 'rechazada_por_conflicto' ? idA : idB;
    const incidencias = await prisma.incidencia.findMany({
      where: { saleId: rejectedId },
    });
    expect(incidencias).toHaveLength(1);
    expectUuidV7(incidencias[0].id);
    expect(incidencias[0].type).toBe('conflicto_stock');
    expect(incidencias[0].reason).toMatch(/stock insuficiente al sincronizar/);
    const rejected =
      resA.body.status === 'rechazada_por_conflicto' ? resA.body : resB.body;
    const replay = saleBody({
      id: rejectedId,
      occurredAt: rejected.occurredAt,
      cashReceivedMinor: 15000,
      items: [{ productId: product.id, quantity: 1 }],
    });
    await write(request(app.getHttpServer()).post('/sales'))
      .send(replay)
      .expect(200);
    await write(request(app.getHttpServer()).post('/sales'))
      .send({
        ...replay,
        items: [{ productId: product.id, quantity: 2 }],
      })
      .expect(409);
    expect(
      await prisma.incidencia.count({ where: { saleId: rejectedId } }),
    ).toBe(1);
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: product.id } }))
        .stock,
    ).toBe(0);
    // Historical rejected rows cannot be reconstructed from missing items.
    await prisma.sale.update({
      where: { id: rejectedId },
      data: { requestFingerprint: null },
    });
    await write(request(app.getHttpServer()).post('/sales'))
      .send(replay)
      .expect(409);
  });
});

import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/database/prisma.service.js';

describe('sale idempotency and offline conflict handling (BE-06)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  let memberId: string;
  let deviceId: string;
  const contextId = `be06-${randomUUID()}`;
  const occurredAt = new Date().toISOString();

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
      cashReceivedMinor: number;
      items: { productId: string; quantity: number; unitPriceMinor?: number }[];
    }> = {},
  ) => ({
    id: overrides.id ?? randomUUID(),
    memberId,
    deviceId,
    occurredAt,
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
        data: { name: 'Socio', role: 'socio', contextId },
      })
    ).id;
    deviceId = (
      await prisma.device.create({
        data: {
          name: 'BE06 tablet',
          identifier: randomUUID(),
          contextId,
          authorized: true,
        },
      })
    ).id;
  });

  afterAll(async () => {
    if (prisma) {
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

  it('replays the stored result for a resend with an identical payload, without discounting stock twice', async () => {
    const product = await createProduct({
      name: 'Replayed unica',
      tipo: 'unica',
      unitPriceMinor: 8000,
      stock: 1,
    });
    const body = saleBody({
      cashReceivedMinor: 8000,
      items: [{ productId: product.id, quantity: 1 }],
    });
    const first = await write(request(app.getHttpServer()).post('/sales'))
      .send(body)
      .expect(201);
    const second = await write(request(app.getHttpServer()).post('/sales'))
      .send(body)
      .expect(201);
    expect(second.body).toEqual(first.body);
    expect(second.body.status).toBe('completada');
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: product.id } }))
        .stock,
    ).toBe(0);
    expect(
      await prisma.saleItem.count({ where: { saleId: body.id } }),
    ).toBe(1);
  });

  it('rejects a resend of the same id with a different payload with 409', async () => {
    const product = await createProduct({
      name: 'Conflicting resend',
      tipo: 'cantidad',
      unitPriceMinor: 1000,
      stock: 10,
    });
    const id = randomUUID();
    await write(request(app.getHttpServer()).post('/sales'))
      .send(
        saleBody({
          id,
          cashReceivedMinor: 2000,
          items: [{ productId: product.id, quantity: 2 }],
        }),
      )
      .expect(201);
    await write(request(app.getHttpServer()).post('/sales'))
      .send(
        saleBody({
          id,
          cashReceivedMinor: 3000,
          items: [{ productId: product.id, quantity: 3 }],
        }),
      )
      .expect(409);
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: product.id } }))
        .stock,
    ).toBe(8);
  });

  it('lets exactly one of two racing sales for a single unica product win, persisting the other as rechazada_por_conflicto', async () => {
    const product = await createProduct({
      name: 'Racing unica',
      tipo: 'unica',
      unitPriceMinor: 12000,
      stock: 1,
    });
    const idA = randomUUID();
    const idB = randomUUID();
    // Both requests are individually valid (quantity 1 against stock 1);
    // only their real arrival/processing order at the server, serialized by
    // the FOR UPDATE row lock, decides the winner.
    const [resA, resB] = await Promise.all([
      write(request(app.getHttpServer()).post('/sales')).send(
        saleBody({
          id: idA,
          cashReceivedMinor: 12000,
          items: [{ productId: product.id, quantity: 1 }],
        }),
      ),
      write(request(app.getHttpServer()).post('/sales')).send(
        saleBody({
          id: idB,
          cashReceivedMinor: 12000,
          items: [{ productId: product.id, quantity: 1 }],
        }),
      ),
    ]);
    expect(resA.status).toBe(201);
    expect(resB.status).toBe(201);
    const statuses = [resA.body.status, resB.body.status].sort();
    expect(statuses).toEqual(['completada', 'rechazada_por_conflicto']);
    const rejected = resA.body.status === 'rechazada_por_conflicto' ? resA.body : resB.body;
    expect(rejected.conflictReason).toContain(product.id);
    expect(rejected.conflictReason).toMatch(/stock insuficiente al sincronizar/);
    expect(rejected.conflictDetectedAt).toBeTruthy();
    expect(rejected.totalMinor).toBeNull();
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: product.id } }))
        .stock,
    ).toBe(0);
    expect(
      await prisma.saleItem.count({
        where: { saleId: { in: [idA, idB] } },
      }),
    ).toBe(1);
  });

  it('lists only rejected sales when filtered by status', async () => {
    const completedProduct = await createProduct({
      name: 'Listing fixture completed',
      tipo: 'cantidad',
      unitPriceMinor: 500,
      stock: 3,
    });
    await write(request(app.getHttpServer()).post('/sales'))
      .send(
        saleBody({
          cashReceivedMinor: 500,
          items: [{ productId: completedProduct.id, quantity: 1 }],
        }),
      )
      .expect(201);

    const oversell = randomUUID();
    await write(request(app.getHttpServer()).post('/sales'))
      .send(
        saleBody({
          id: oversell,
          cashReceivedMinor: 500_000,
          items: [{ productId: completedProduct.id, quantity: 999 }],
        }),
      )
      .expect(400); // BE-05 plain invalid input: not a race, never persisted.

    const racingProduct = await createProduct({
      name: 'Listing fixture racing',
      tipo: 'unica',
      unitPriceMinor: 9000,
      stock: 1,
    });
    const idA = randomUUID();
    const idB = randomUUID();
    const [resA, resB] = await Promise.all([
      write(request(app.getHttpServer()).post('/sales')).send(
        saleBody({
          id: idA,
          cashReceivedMinor: 9000,
          items: [{ productId: racingProduct.id, quantity: 1 }],
        }),
      ),
      write(request(app.getHttpServer()).post('/sales')).send(
        saleBody({
          id: idB,
          cashReceivedMinor: 9000,
          items: [{ productId: racingProduct.id, quantity: 1 }],
        }),
      ),
    ]);
    const rejectedId =
      resA.body.status === 'rechazada_por_conflicto' ? idA : idB;

    const res = await write(
      request(app.getHttpServer()).get('/sales?status=rechazada_por_conflicto'),
    ).expect(200);
    const bodies = res.body as { id: string; status: string }[];
    expect(bodies.every((sale) => sale.status === 'rechazada_por_conflicto')).toBe(
      true,
    );
    expect(bodies.some((sale) => sale.id === rejectedId)).toBe(true);
    expect(bodies.some((sale) => sale.id === oversell)).toBe(false);
  });
});

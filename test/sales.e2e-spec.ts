import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { SalesService } from '../src/sales/sales.service.js';

describe('multi-item cash sales', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sales: SalesService;
  let token: string;
  let accountId: string;
  let memberId: string;
  let deviceId: string;
  const contextId = `be05-${randomUUID()}`;
  const otherContext = `be05-other-${randomUUID()}`;
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
    sales = app.get(SalesService);
    const account = await prisma.account.create({
      data: {
        username: randomUUID(),
        passwordHash: 'not-a-login-fixture',
        contextId,
      },
    });
    accountId = account.id;
    token = await app.get(JwtService).signAsync({ sub: accountId });
    memberId = (
      await prisma.member.create({
        data: { name: 'Socio', role: 'socio', contextId },
      })
    ).id;
    deviceId = (
      await prisma.device.create({
        data: {
          name: 'BE05 tablet',
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
      await prisma.product.deleteMany({
        where: { contextId: { in: [contextId, otherContext] } },
      });
      await prisma.account.deleteMany({ where: { contextId } });
      await prisma.device.deleteMany({ where: { contextId } });
      await prisma.member.deleteMany({ where: { contextId } });
    }
    await app?.close();
  });

  it('sells a unica product, moving stock from one to zero', async () => {
    const product = await createProduct({
      name: 'Bonsai unico',
      tipo: 'unica',
      unitPriceMinor: 15000,
      stock: 1,
    });
    const res = await write(request(app.getHttpServer()).post('/sales'))
      .send(
        saleBody({
          cashReceivedMinor: 15000,
          items: [{ productId: product.id, quantity: 1 }],
        }),
      )
      .expect(201);
    expect(res.body.totalMinor).toBe(15000);
    expect(res.body.changeMinor).toBe(0);
    expect(res.body.items[0].unitPriceMinor).toBe(15000);
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: product.id } }))
        .stock,
    ).toBe(0);
  });

  it('discounts a cantidad product by the sold quantity', async () => {
    const product = await createProduct({
      name: 'Maceta',
      tipo: 'cantidad',
      unitPriceMinor: 5000,
      stock: 10,
    });
    await write(request(app.getHttpServer()).post('/sales'))
      .send(
        saleBody({
          cashReceivedMinor: 10000,
          items: [{ productId: product.id, quantity: 2 }],
        }),
      )
      .expect(201);
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: product.id } }))
        .stock,
    ).toBe(8);
  });

  it('sums multiple lines using the server price, ignoring the client unitPriceMinor', async () => {
    const bonsai = await createProduct({
      name: 'Bonsai',
      tipo: 'unica',
      unitPriceMinor: 15000,
      stock: 1,
    });
    const maceta = await createProduct({
      name: 'Maceta barata',
      tipo: 'cantidad',
      unitPriceMinor: 5000,
      stock: 10,
    });
    const res = await write(request(app.getHttpServer()).post('/sales'))
      .send(
        saleBody({
          cashReceivedMinor: 50000,
          items: [
            { productId: bonsai.id, quantity: 1, unitPriceMinor: 1 },
            { productId: maceta.id, quantity: 2, unitPriceMinor: 1 },
          ],
        }),
      )
      .expect(201);
    expect(res.body.totalMinor).toBe(15000 + 5000 * 2);
    expect(res.body.changeMinor).toBe(50000 - (15000 + 5000 * 2));
    const priced = res.body.items.map(
      (item: { unitPriceMinor: number }) => item.unitPriceMinor,
    );
    expect(priced).toEqual(expect.arrayContaining([15000, 5000]));
    const getRes = await write(
      request(app.getHttpServer()).get(`/sales/${res.body.id}`),
    ).expect(200);
    expect(getRes.body.totalMinor).toBe(res.body.totalMinor);
    expect(getRes.body.memberId).toBe(memberId);
    expect(getRes.body.deviceId).toBe(deviceId);
  });

  it('rejects insufficient cash with 400 and applies no stock change', async () => {
    const product = await createProduct({
      name: 'Cactus',
      tipo: 'cantidad',
      unitPriceMinor: 10000,
      stock: 5,
    });
    await write(request(app.getHttpServer()).post('/sales'))
      .send(
        saleBody({
          cashReceivedMinor: 9999,
          items: [{ productId: product.id, quantity: 1 }],
        }),
      )
      .expect(400);
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: product.id } }))
        .stock,
    ).toBe(5);
  });

  it('rejects the whole sale when one line exceeds stock, leaving valid lines untouched', async () => {
    const plentiful = await createProduct({
      name: 'Plentiful',
      tipo: 'cantidad',
      unitPriceMinor: 1000,
      stock: 10,
    });
    const scarce = await createProduct({
      name: 'Scarce',
      tipo: 'cantidad',
      unitPriceMinor: 1000,
      stock: 1,
    });
    await write(request(app.getHttpServer()).post('/sales'))
      .send(
        saleBody({
          cashReceivedMinor: 1_000_000,
          items: [
            { productId: plentiful.id, quantity: 3 },
            { productId: scarce.id, quantity: 5 },
          ],
        }),
      )
      .expect(400);
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: plentiful.id } }))
        .stock,
    ).toBe(10);
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: scarce.id } }))
        .stock,
    ).toBe(1);
  });

  it('rolls back every line when a mid-sale product does not exist', async () => {
    const first = await createProduct({
      name: 'First',
      tipo: 'cantidad',
      unitPriceMinor: 2000,
      stock: 10,
    });
    const third = await createProduct({
      name: 'Third',
      tipo: 'cantidad',
      unitPriceMinor: 3000,
      stock: 10,
    });
    const saleId = randomUUID();
    await write(request(app.getHttpServer()).post('/sales'))
      .send(
        saleBody({
          id: saleId,
          cashReceivedMinor: 1_000_000,
          items: [
            { productId: first.id, quantity: 2 },
            { productId: randomUUID(), quantity: 1 },
            { productId: third.id, quantity: 1 },
          ],
        }),
      )
      .expect(400);
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: first.id } }))
        .stock,
    ).toBe(10);
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: third.id } }))
        .stock,
    ).toBe(10);
    expect(await prisma.sale.findUnique({ where: { id: saleId } })).toBeNull();
  });

  it('rejects a productId belonging to another context as if it did not exist', async () => {
    const foreign = await prisma.product.create({
      data: {
        name: 'Foreign catalog item',
        tipo: 'cantidad',
        unitPriceMinor: 100,
        initialStock: 10,
        stock: 10,
        contextId: otherContext,
      },
    });
    await write(request(app.getHttpServer()).post('/sales'))
      .send(
        saleBody({
          cashReceivedMinor: 1000,
          items: [{ productId: foreign.id, quantity: 1 }],
        }),
      )
      .expect(400);
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: foreign.id } }))
        .stock,
    ).toBe(10);
  });

  it('rejects a sale whose declared member/device does not match the authenticated selection', async () => {
    const product = await createProduct({
      name: 'Mismatch',
      tipo: 'cantidad',
      unitPriceMinor: 1000,
      stock: 5,
    });
    const impostor = randomUUID();
    await write(request(app.getHttpServer()).post('/sales'))
      .send({
        ...saleBody({
          cashReceivedMinor: 1000,
          items: [{ productId: product.id, quantity: 1 }],
        }),
        memberId: impostor,
      })
      .expect(403);
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: product.id } }))
        .stock,
    ).toBe(5);
  });

  it.each([
    { items: [] },
    { items: [{ productId: 'not-a-uuid', quantity: 1 }] },
    { items: [{ productId: randomUUID(), quantity: 0 }] },
    { items: [{ productId: randomUUID(), quantity: 1.5 }] },
    { currency: 'USD' },
    { occurredAt: 'not-a-date' },
    { cashReceivedMinor: -1 },
  ])('rejects malformed sale input %o', async (change) => {
    await write(request(app.getHttpServer()).post('/sales'))
      .send({
        ...saleBody({
          cashReceivedMinor: 1000,
          items: [{ productId: randomUUID(), quantity: 1 }],
        }),
        ...change,
      })
      .expect(400);
  });

  it('requires authentication and an authorized member/device selection', async () => {
    await request(app.getHttpServer())
      .post('/sales')
      .send(saleBody({ items: [] }))
      .expect(401);
    await request(app.getHttpServer())
      .post('/sales')
      .auth(token, { type: 'bearer' })
      .send(saleBody({ items: [] }))
      .expect(403);
  });

  it('isolates GET /sales/:id per context', async () => {
    const product = await createProduct({
      name: 'Isolated',
      tipo: 'cantidad',
      unitPriceMinor: 1000,
      stock: 5,
    });
    const res = await write(request(app.getHttpServer()).post('/sales'))
      .send(
        saleBody({
          cashReceivedMinor: 1000,
          items: [{ productId: product.id, quantity: 1 }],
        }),
      )
      .expect(201);
    await request(app.getHttpServer())
      .get(`/sales/${res.body.id}`)
      .expect(401);
    await request(app.getHttpServer())
      .get(`/sales/${randomUUID()}`)
      .auth(token, { type: 'bearer' })
      .expect(404);
    const foreignAccount = await prisma.account.create({
      data: {
        username: randomUUID(),
        passwordHash: 'not-a-login-fixture',
        contextId: otherContext,
      },
    });
    const foreignToken = await app
      .get(JwtService)
      .signAsync({ sub: foreignAccount.id });
    try {
      await request(app.getHttpServer())
        .get(`/sales/${res.body.id}`)
        .auth(foreignToken, { type: 'bearer' })
        .expect(404);
    } finally {
      await prisma.account.delete({ where: { id: foreignAccount.id } });
    }
  });

  it('rolls back stock and creation when persistence fails mid-transaction', async () => {
    const product = await createProduct({
      name: 'Injected failure',
      tipo: 'cantidad',
      unitPriceMinor: 1000,
      stock: 5,
    });
    const transaction = prisma.$transaction.bind(prisma);
    const spy = vi.spyOn(prisma, '$transaction').mockImplementation(((
      callback: unknown,
    ) =>
      transaction(async (tx) => {
        const fake = Object.assign(Object.create(tx), {
          sale: {
            create: () => {
              throw new Error('Injected sale persistence failure');
            },
          },
        });
        return (callback as (value: typeof tx) => Promise<unknown>)(fake);
      })) as typeof prisma.$transaction);
    try {
      await expect(
        sales.create(
          {
            account: { id: accountId, contextId },
            selection: { memberId, deviceId },
          },
          saleBody({
            cashReceivedMinor: 1000,
            items: [{ productId: product.id, quantity: 1 }],
          }) as never,
        ),
      ).rejects.toThrow('Injected sale persistence failure');
    } finally {
      spy.mockRestore();
    }
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: product.id } }))
        .stock,
    ).toBe(5);
  });
});

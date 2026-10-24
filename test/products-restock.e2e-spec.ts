import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { withTestTenant } from './tenant-scope.js';

/** POST /products/:id/restock against a real PostgreSQL. */
describe('product restock', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const contextA = `rs-a-${randomUUID()}`;
  const contextB = `rs-b-${randomUUID()}`;
  let tokenA: string;
  let tokenB: string;
  let collaboratorTokenA: string;
  let socioA: string;
  let collaboratorA: string;
  let deviceA: string;
  let socioB: string;
  let deviceB: string;

  const as = (
    req: request.Test,
    who: { token: string; device: string },
  ) =>
    req.auth(who.token, { type: 'bearer' }).set('x-device-id', who.device);
  const socio = () => ({ token: tokenA, device: deviceA });

  const newProduct = (
    overrides: Record<string, unknown> = {},
    contextId = contextA,
  ) =>
    withTestTenant(contextId, () =>
      prisma.product.create({
        data: {
          name: `Producto ${randomUUID()}`,
          tipo: 'cantidad',
          unitPriceMinor: 5000,
          initialStock: 10,
          stock: 10,
          purchaseCostMinor: 1000,
          contextId,
          ...overrides,
        },
      }),
    );
  const restock = (
    productId: string,
    body: Record<string, unknown>,
    who = socio(),
  ) => as(request(app.getHttpServer()).post(`/products/${productId}/restock`), who).send(body);
  const reload = (productId: string, contextId = contextA) =>
    withTestTenant(contextId, () =>
      prisma.product.findUniqueOrThrow({ where: { id: productId } }),
    );
  const movements = (productId: string, contextId = contextA) =>
    withTestTenant(contextId, () =>
      prisma.stockMovement.findMany({
        where: { productId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    );

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    const jwt = app.get(JwtService);
    // One account per person: the token's account carries the acting member.
    const accountToken = async (contextId: string, memberId: string) => {
      const created = await prisma.account.create({
        data: { username: randomUUID(), passwordHash: 'not-a-login-fixture', contextId, memberId },
      });
      return jwt.signAsync({ sub: created.id });
    };
    await withTestTenant(contextA, async () => {
      socioA = (await prisma.member.create({ data: { name: 'Socio A', role: 'socio', contextId: contextA } })).id;
      collaboratorA = (await prisma.member.create({ data: { name: 'Colab A', role: 'colaborador', contextId: contextA } })).id;
      deviceA = (await prisma.device.create({ data: { name: 'Tablet A', identifier: randomUUID(), contextId: contextA, authorized: true } })).id;
    });
    await withTestTenant(contextB, async () => {
      socioB = (await prisma.member.create({ data: { name: 'Socio B', role: 'socio', contextId: contextB } })).id;
      deviceB = (await prisma.device.create({ data: { name: 'Tablet B', identifier: randomUUID(), contextId: contextB, authorized: true } })).id;
    });
    tokenA = await accountToken(contextA, socioA);
    collaboratorTokenA = await accountToken(contextA, collaboratorA);
    tokenB = await accountToken(contextB, socioB);
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('a restock', () => {
    it('adds the pieces and returns the updated product and the movement', async () => {
      const product = await newProduct({ stock: 10 });

      const res = await restock(product.id, { quantity: 5, note: 'Compra del sábado' }).expect(201);

      expect(res.body.product).toMatchObject({ id: product.id, stock: 15, initialStock: 10 });
      expect(res.body.product).not.toHaveProperty('imagePath');
      expect(res.body.movement).toMatchObject({
        productId: product.id,
        memberId: socioA,
        type: 'REPOSICION',
        quantity: 5,
        stockBefore: 10,
        stockAfter: 15,
        unitCostMinor: null,
        note: 'Compra del sábado',
      });
      expect((await reload(product.id)).stock).toBe(15);
      expect(await movements(product.id)).toHaveLength(1);
    });

    it('leaves who/when/before/after in the product audit trail', async () => {
      const product = await newProduct({ stock: 4 });

      await restock(product.id, { quantity: 6 }).expect(201);

      const audit = await request(app.getHttpServer())
        .get(`/products/${product.id}/audit`)
        .auth(tokenA, { type: 'bearer' })
        .expect(200);
      const last = audit.body.items.at(-1);
      expect(last.memberId).toBe(socioA);
      expect(last.before.stock).toBe(4);
      expect(last.after.stock).toBe(10);
      expect(last.changedAt).toEqual(expect.any(String));
    });

    it('works on a product that sold out (stock 0)', async () => {
      const product = await newProduct({ stock: 0 });

      const res = await restock(product.id, { quantity: 3 }).expect(201);

      expect(res.body.movement).toMatchObject({ stockBefore: 0, stockAfter: 3 });
    });

    it('stacks: two restocks one after the other keep a consistent chain', async () => {
      const product = await newProduct({ stock: 2 });

      await restock(product.id, { quantity: 3 }).expect(201);
      await restock(product.id, { quantity: 4 }).expect(201);

      const rows = await movements(product.id);
      expect(rows.map((row) => [row.stockBefore, row.stockAfter])).toEqual([[2, 5], [5, 9]]);
      expect((await reload(product.id)).stock).toBe(9);
    });
  });

  describe('product cost (weighted average)', () => {
    it('no purchase cost: the product cost is not touched', async () => {
      const product = await newProduct({ stock: 5, purchaseCostMinor: 1000 });

      const res = await restock(product.id, { quantity: 5 }).expect(201);

      expect(res.body.product.purchaseCostMinor).toBe(1000);
      expect(res.body.movement.unitCostMinor).toBeNull();
    });

    it('stock was 0: the purchase cost becomes the product cost', async () => {
      const product = await newProduct({ stock: 0, purchaseCostMinor: 1000 });

      const res = await restock(product.id, { quantity: 4, unitCostMinor: 1500 }).expect(201);

      expect(res.body.product.purchaseCostMinor).toBe(1500);
      expect((await reload(product.id)).purchaseCostMinor).toBe(1500);
    });

    it('stock > 0 with a known cost: weighted average', async () => {
      const product = await newProduct({ stock: 3, purchaseCostMinor: 1000 });

      const res = await restock(product.id, { quantity: 2, unitCostMinor: 1100 }).expect(201);

      // (3 x 1000 + 2 x 1100) / 5
      expect(res.body.product.purchaseCostMinor).toBe(1040);
      expect(res.body.movement.unitCostMinor).toBe(1100);
    });

    it('rounds half up to whole cents', async () => {
      const product = await newProduct({ stock: 1, purchaseCostMinor: 100 });

      const res = await restock(product.id, { quantity: 1, unitCostMinor: 101 }).expect(201);

      // 100.5 -> 101
      expect(res.body.product.purchaseCostMinor).toBe(101);
    });

    it('stock > 0 with an unknown cost: not touched, but the purchase is recorded', async () => {
      const product = await newProduct({ stock: 5, purchaseCostMinor: null });

      const res = await restock(product.id, { quantity: 5, unitCostMinor: 1100 }).expect(201);

      expect(res.body.product.purchaseCostMinor).toBeNull();
      expect(res.body.movement.unitCostMinor).toBe(1100);
    });

    it('the audit trail shows the cost before and after', async () => {
      const product = await newProduct({ stock: 3, purchaseCostMinor: 1000 });

      await restock(product.id, { quantity: 2, unitCostMinor: 1100 }).expect(201);

      // The cost is part of the audit only for a socio (the account's person).
      const audit = await as(
        request(app.getHttpServer()).get(`/products/${product.id}/audit`),
        socio(),
      ).expect(200);
      const last = audit.body.items.at(-1);
      expect(last.before.purchaseCostMinor).toBe(1000);
      expect(last.after.purchaseCostMinor).toBe(1040);
    });
  });

  describe('rejections', () => {
    const noMovement = async (productId: string) => expect(await movements(productId)).toHaveLength(0);

    it('401 without a token', async () => {
      const product = await newProduct();

      await request(app.getHttpServer()).post(`/products/${product.id}/restock`).send({ quantity: 1 }).expect(401);
      await noMovement(product.id);
    });

    it('403 for a colaborador (socios only)', async () => {
      const product = await newProduct();

      await restock(product.id, { quantity: 1 }, { token: collaboratorTokenA, device: deviceA }).expect(403);

      expect((await reload(product.id)).stock).toBe(10);
      await noMovement(product.id);
    });

    it('403 without the device header', async () => {
      const product = await newProduct();

      await request(app.getHttpServer())
        .post(`/products/${product.id}/restock`)
        .auth(tokenA, { type: 'bearer' })
        .send({ quantity: 1 })
        .expect(403);
    });

    it('400 for a unique piece, which is never restocked', async () => {
      const product = await newProduct({ tipo: 'unica', initialStock: 1, stock: 0 });

      await restock(product.id, { quantity: 1 }).expect(400);

      expect((await reload(product.id)).stock).toBe(0);
      await noMovement(product.id);
    });

    it('400 for a deactivated product', async () => {
      const product = await newProduct({ active: false });

      await restock(product.id, { quantity: 1 }).expect(400);

      expect((await reload(product.id)).stock).toBe(10);
      await noMovement(product.id);
    });

    it('400 when the stock would exceed the maximum, and nothing changes', async () => {
      const product = await newProduct({ stock: 2_147_483_600 });

      await restock(product.id, { quantity: 100 }).expect(400);

      expect((await reload(product.id)).stock).toBe(2_147_483_600);
      await noMovement(product.id);
    });

    it('accepts exactly up to the maximum', async () => {
      const product = await newProduct({ stock: 2_147_483_600 });

      const res = await restock(product.id, { quantity: 47 }).expect(201);

      expect(res.body.product.stock).toBe(2_147_483_647);
    });

    it('404 for a product that does not exist', async () => {
      await restock(randomUUID(), { quantity: 1 }).expect(404);
    });

    it('400 for a malformed id', async () => {
      await as(request(app.getHttpServer()).post('/products/not-a-uuid/restock'), socio()).send({ quantity: 1 }).expect(400);
    });

    it.each([
      ['no quantity', {}],
      ['quantity 0', { quantity: 0 }],
      ['a negative quantity', { quantity: -2 }],
      ['a fractional quantity', { quantity: 1.5 }],
      ['a text quantity', { quantity: '3' }],
      ['a negative cost', { quantity: 1, unitCostMinor: -1 }],
      ['a fractional cost', { quantity: 1, unitCostMinor: 10.5 }],
      ['an unknown field (stock)', { quantity: 1, stock: 99 }],
      ['an unknown field (contextId)', { quantity: 1, contextId: 'x' }],
    ])('400 for %s', async (_label, body) => {
      const product = await newProduct();

      await restock(product.id, body).expect(400);

      expect((await reload(product.id)).stock).toBe(10);
      await noMovement(product.id);
    });
  });

  describe('multi-tenant isolation', () => {
    it("404 for another context's product; its stock and movements are untouched", async () => {
      const productA = await newProduct({ stock: 7 });

      await restock(productA.id, { quantity: 5 }, { token: tokenB, device: deviceB }).expect(404);

      expect((await reload(productA.id)).stock).toBe(7);
      expect(await movements(productA.id)).toHaveLength(0);
    });

    it("a restock in one context is invisible to the other and never touches its products", async () => {
      const productA = await newProduct({ stock: 1 });
      const productB = await newProduct({ stock: 1 }, contextB);

      await restock(productA.id, { quantity: 2 }).expect(201);

      expect((await reload(productB.id, contextB)).stock).toBe(1);
      expect(await movements(productA.id, contextB)).toEqual([]);
      const seenByB = await withTestTenant(contextB, () => prisma.stockMovement.count({}));
      expect(seenByB).toBe(0);
    });

    it('each context restocks its own products independently', async () => {
      const productB = await newProduct({ stock: 1 }, contextB);

      await restock(productB.id, { quantity: 4 }, { token: tokenB, device: deviceB }).expect(201);

      expect((await reload(productB.id, contextB)).stock).toBe(5);
      expect((await movements(productB.id, contextB))[0]?.memberId).toBe(socioB);
    });
  });

  describe('concurrency', () => {
    it('two simultaneous restocks add up both of them', async () => {
      const product = await newProduct({ stock: 10 });

      const [first, second] = await Promise.all([
        restock(product.id, { quantity: 3 }),
        restock(product.id, { quantity: 4 }),
      ]);

      expect([first.status, second.status]).toEqual([201, 201]);
      expect((await reload(product.id)).stock).toBe(17);
      const rows = await movements(product.id);
      expect(rows).toHaveLength(2);
      // Whichever ran first, the second one started where the first ended.
      const ordered = [...rows].sort((a, b) => a.stockBefore - b.stockBefore);
      expect(ordered[0]?.stockBefore).toBe(10);
      expect(ordered[0]?.stockAfter).toBe(ordered[1]?.stockBefore);
      expect(ordered[1]?.stockAfter).toBe(17);
    });

    it('many simultaneous restocks never lose a piece or repeat a "before"', async () => {
      const product = await newProduct({ stock: 0 });
      const quantities = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

      const responses = await Promise.all(quantities.map((quantity) => restock(product.id, { quantity })));

      expect(responses.map((res) => res.status)).toEqual(quantities.map(() => 201));
      const total = quantities.reduce((sum, quantity) => sum + quantity, 0);
      expect((await reload(product.id)).stock).toBe(total);
      const rows = [...(await movements(product.id))].sort((a, b) => a.stockBefore - b.stockBefore);
      expect(rows).toHaveLength(quantities.length);
      expect(rows[0]?.stockBefore).toBe(0);
      rows.slice(1).forEach((row, index) => expect(row.stockBefore).toBe(rows[index]?.stockAfter));
      expect(rows.at(-1)?.stockAfter).toBe(total);
    });

    it('simultaneous restocks with costs average one after the other (no lost update)', async () => {
      // Stock 0, then two simultaneous purchases. Whichever runs second sees the
      // first one's stock and cost: the result must be a valid weighted average
      // of both purchases, never just one of them.
      const product = await newProduct({ stock: 0, purchaseCostMinor: null });

      await Promise.all([
        restock(product.id, { quantity: 2, unitCostMinor: 1000 }).expect(201),
        restock(product.id, { quantity: 2, unitCostMinor: 2000 }).expect(201),
      ]);

      const final = await reload(product.id);
      expect(final.stock).toBe(4);
      expect(final.purchaseCostMinor).toBe(1500);
    });

    it('a restock and a concurrent sale both count', async () => {
      const product = await newProduct({ stock: 5 });
      const sale = as(request(app.getHttpServer()).post('/sales'), socio()).send({
        id: randomUUID(),
        memberId: socioA,
        deviceId: deviceA,
        occurredAt: new Date().toISOString(),
        currency: 'MXN',
        cashReceivedMinor: 10000,
        items: [{ productId: product.id, quantity: 2 }],
      });

      const [restocked, sold] = await Promise.all([restock(product.id, { quantity: 10 }), sale]);

      expect([restocked.status, sold.status]).toEqual([201, 201]);
      // 5 + 10 - 2: neither the restock's increment nor the sale's decrement is lost.
      expect((await reload(product.id)).stock).toBe(13);
    });
  });
});

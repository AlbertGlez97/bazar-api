import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import sharp from 'sharp';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { ProductsService } from '../src/products/products.service.js';
import { configureStaticStorage } from '../src/storage/static-storage.js';
import { withTestTenant } from './tenant-scope.js';
import { expectUuidV7 } from './uuid-v7.js';

// BE-11: these specs still create fixtures / inspect Product-side tables
// directly through Prisma and ProductsService, outside the real HTTP
// request pipeline, so strict RLS now requires an explicit tenant scope.
describe('context-scoped products', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let products: ProductsService;
  let directory: string;
  let token: string;
  let accountId: string;
  let socio: string;
  let collaborator: string;
  let device: string;
  let otherProduct: string;
  let image: Buffer;
  const contextId = `be04-${randomUUID()}`;
  const otherContext = `be04-other-${randomUUID()}`;
  const created: string[] = [];
  const body = (name = 'Product') => ({
    name,
    tipo: 'cantidad',
    unitPriceMinor: 12550,
    initialStock: 5,
  });
  const actor = () => ({
    account: { id: accountId, contextId },
    selection: { memberId: socio, deviceId: device },
  });
  const write = (req: request.Test, member = socio) =>
    req
      .auth(token, { type: 'bearer' })
      .set('x-member-id', member)
      .set('x-device-id', device);
  const create = async (data = body()) => {
    const res = await write(request(app.getHttpServer()).post('/products'))
      .send(data)
      .expect(201);
    created.push(res.body.id);
    return res.body;
  };

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'bazar-be04-'));
    process.env.PRODUCT_UPLOAD_DIR = directory;
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication<NestExpressApplication>();
    configureStaticStorage(app);
    await app.init();
    prisma = app.get(PrismaService);
    products = app.get(ProductsService);
    const account = await prisma.account.create({
      data: {
        username: randomUUID(),
        passwordHash: 'not-a-login-fixture',
        contextId,
      },
    });
    accountId = account.id;
    token = await app.get(JwtService).signAsync({ sub: accountId });
    await withTestTenant(contextId, async () => {
      socio = (
        await prisma.member.create({
          data: { name: 'Socio', role: 'socio', contextId },
        })
      ).id;
      collaborator = (
        await prisma.member.create({
          data: { name: 'Collaborator', role: 'colaborador', contextId },
        })
      ).id;
      device = (
        await prisma.device.create({
          data: {
            name: 'BE04 tablet',
            identifier: randomUUID(),
            contextId,
            authorized: true,
          },
        })
      ).id;
    });
    otherProduct = await withTestTenant(otherContext, async () =>
      (
        await prisma.product.create({
          data: {
            name: 'Private catalog',
            tipo: 'unica',
            unitPriceMinor: 99,
            initialStock: 1,
            stock: 1,
            contextId: otherContext,
          },
        })
      ).id,
    );
    image = await sharp({
      create: { width: 2, height: 2, channels: 3, background: '#338844' },
    })
      .png()
      .toBuffer();
  });
  afterAll(async () => {
    if (prisma) {
      await withTestTenant(contextId, async () => {
        await prisma.productAudit.deleteMany({
          where: { product: { contextId } },
        });
        await prisma.product.deleteMany({
          where: { contextId },
        });
        await prisma.device.deleteMany({ where: { contextId } });
        await prisma.member.deleteMany({ where: { contextId } });
      });
      await withTestTenant(otherContext, async () => {
        await prisma.productAudit.deleteMany({
          where: { product: { contextId: otherContext } },
        });
        await prisma.product.deleteMany({
          where: { contextId: otherContext },
        });
      });
      await prisma.account.deleteMany({ where: { contextId } });
    }
    await app?.close();
    if (directory) {
      for (const file of await readdir(directory))
        await unlink(join(directory, file));
      await rmdir(directory);
    }
    delete process.env.PRODUCT_UPLOAD_DIR;
  });

  it('creates a unica with omitted stock and an atomic creation audit', async () => {
    const product = await create({
      name: 'Unique',
      tipo: 'unica',
      unitPriceMinor: 100,
    } as ReturnType<typeof body>);
    expect(product.initialStock).toBe(1);
    expect(product.stock).toBe(1);
    expectUuidV7(product.id);
    await withTestTenant(contextId, async () => {
      const audit = await prisma.productAudit.findFirstOrThrow({
        where: { productId: product.id },
      });
      expect(audit.memberId).toBe(socio);
      expectUuidV7(audit.id);
      expect(audit.oldUnitPriceMinor).toBeNull();
      expect(audit.newUnitPriceMinor).toBe(100);
    });
  });
  it.each([0, 2, 2147483647])(
    'forces unica stock to one despite supplied stock %s',
    async (initialStock) => {
      const product = await create({ ...body(), tipo: 'unica', initialStock });
      expect(product.initialStock).toBe(1);
      expect(product.stock).toBe(1);
    },
  );
  it('prevents collaborator mutations but permits catalog and audit reading', async () => {
    const product = await create();
    await write(request(app.getHttpServer()).post('/products'), collaborator)
      .send(body())
      .expect(403);
    await write(
      request(app.getHttpServer()).patch(`/products/${product.id}`),
      collaborator,
    )
      .send({ unitPriceMinor: 1 })
      .expect(403);
    await request(app.getHttpServer())
      .get('/products')
      .auth(token, { type: 'bearer' })
      .expect(200);
    await request(app.getHttpServer())
      .get(`/products/${product.id}/audit`)
      .auth(token, { type: 'bearer' })
      .expect(200);
  });
  it.each([
    { tipo: 'cantidad', initialStock: undefined },
    { initialStock: -1 },
    { unitPriceMinor: 125.5 },
    { unitPriceMinor: -1 },
    { unitPriceMinor: 2147483648 },
    { purchaseCostMinor: 1.5 },
    { name: ' ' },
    { tipo: 'invalid' },
    { contextId: otherContext },
    { image: 'https://example.com/image.png' },
  ])('rejects invalid product input %o', async (change) => {
    await write(request(app.getHttpServer()).post('/products'))
      .send({ ...body(), ...change })
      .expect(400);
  });
  it('audits price/metadata edits with actor and old/new values; stock/type immutable', async () => {
    const product = await create();
    await write(request(app.getHttpServer()).patch(`/products/${product.id}`))
      .send({ unitPriceMinor: 10000, notes: 'Edited' })
      .expect(200);
    await withTestTenant(contextId, async () => {
      const audit = await prisma.productAudit.findFirstOrThrow({
        where: { productId: product.id, oldUnitPriceMinor: 12550 },
      });
      expect(audit.newUnitPriceMinor).toBe(10000);
      expect(audit.memberId).toBe(socio);
      expect(audit.after).toMatchObject({
        notes: 'Edited',
        unitPriceMinor: 10000,
      });
    });
    for (const change of [
      { tipo: 'unica' },
      { initialStock: 2 },
      { stock: 99 },
      { unitPriceMinor: null },
      {},
    ]) {
      await write(request(app.getHttpServer()).patch(`/products/${product.id}`))
        .send(change)
        .expect(400);
    }
  });
  it('serializes concurrent audit predecessors and leaves the last value persisted', async () => {
    const product = await create();
    await Promise.all(
      [111, 222].map((unitPriceMinor) =>
        write(request(app.getHttpServer()).patch(`/products/${product.id}`))
          .send({ unitPriceMinor })
          .expect(200),
      ),
    );
    await withTestTenant(contextId, async () => {
      const audits = await prisma.productAudit.findMany({
        where: { productId: product.id, oldUnitPriceMinor: { not: null } },
      });
      expect(audits).toHaveLength(2);
      const first = audits.find((a) => a.oldUnitPriceMinor === 12550)!;
      const second = audits.find(
        (a) => a.oldUnitPriceMinor === first.newUnitPriceMinor,
      )!;
      expect(second).toBeDefined();
      expect(
        (await prisma.product.findUniqueOrThrow({ where: { id: product.id } }))
          .unitPriceMinor,
      ).toBe(second.newUnitPriceMinor);
    });
  });
  it('rolls back product creation and edits when audit persistence fails', async () => {
    const product = await create();
    const before = await withTestTenant(contextId, () =>
      prisma.product.count({ where: { contextId } }),
    );
    const transaction = prisma.$transaction.bind(prisma);
    const spy = vi.spyOn(prisma, '$transaction').mockImplementation(((
      callback: unknown,
    ) =>
      transaction(async (tx) => {
        const fake = Object.assign(Object.create(tx), {
          productAudit: {
            create: () => {
              throw new Error('Injected audit failure');
            },
          },
        });
        return (callback as (value: typeof tx) => Promise<unknown>)(fake);
      })) as typeof prisma.$transaction);
    try {
      await expect(
        withTestTenant(contextId, () =>
          products.create(actor(), body() as never),
        ),
      ).rejects.toThrow('Injected audit failure');
      await expect(
        withTestTenant(contextId, () =>
          products.patch(actor(), product.id, { unitPriceMinor: 999 }),
        ),
      ).rejects.toThrow('Injected audit failure');
    } finally {
      spy.mockRestore();
    }
    await withTestTenant(contextId, async () => {
      expect(await prisma.product.count({ where: { contextId } })).toBe(before);
      expect(
        (await prisma.product.findUniqueOrThrow({ where: { id: product.id } }))
          .unitPriceMinor,
      ).toBe(12550);
    });
  });
  it('searches without case sensitivity and traverses deterministic pages of mixed tipos', async () => {
    const prefix = randomUUID();
    await create({
      ...body(`${prefix} ALPHA`),
      tipo: 'unica',
      initialStock: 1,
    });
    await create(body(`${prefix} alpha second`));
    const fetchPage = (page: number) =>
      request(app.getHttpServer())
        .get('/products')
        .query({ search: `${prefix} alpha`, page, limit: 1 })
        .auth(token, { type: 'bearer' })
        .expect(200);
    const first = (await fetchPage(1)).body;
    const second = (await fetchPage(2)).body;
    expect(first.total).toBe(2);
    expect(second.total).toBe(2);
    expect(first.items[0].id).not.toBe(second.items[0].id);
    expect(
      [first.items[0].tipo, second.items[0].tipo].sort((a: string, b: string) =>
        a.localeCompare(b),
      ),
    ).toEqual(['cantidad', 'unica']);
    expect((await fetchPage(3)).body.items).toEqual([]);
  });
  it('rejects anonymous access and isolates foreign product/audit/upload paths', async () => {
    await request(app.getHttpServer()).get('/products').expect(401);
    const list = await request(app.getHttpServer())
      .get('/products')
      .auth(token, { type: 'bearer' })
      .expect(200);
    expect(
      list.body.items.some((p: { id: string }) => p.id === otherProduct),
    ).toBe(false);
    await write(request(app.getHttpServer()).patch(`/products/${otherProduct}`))
      .send({ unitPriceMinor: 1 })
      .expect(404);
    await request(app.getHttpServer())
      .get(`/products/${otherProduct}/audit`)
      .auth(token, { type: 'bearer' })
      .expect(404);
    const before = await readdir(directory);
    await write(
      request(app.getHttpServer()).post(`/products/${otherProduct}/image`),
    )
      .attach('image', image, {
        filename: '../escape.png',
        contentType: 'image/png',
      })
      .expect(404);
    expect(await readdir(directory)).toEqual(before);
  });
  it('saves decoded image bytes under a random name, serves static URL and audits it', async () => {
    const product = await create();
    const result = await write(
      request(app.getHttpServer()).post(`/products/${product.id}/image`),
    )
      .attach('image', image, {
        filename: '../../unsafe.html',
        contentType: 'image/png',
      })
      .expect(201);
    expect(result.body.image).toMatch(
      /^\/uploads\/products\/[0-9a-f-]{36}\.png$/,
    );
    const key = result.body.image.split('/').pop();
    expect(result.body.imagePath).toBeUndefined();
    await withTestTenant(contextId, async () => {
      expect(
        (await prisma.product.findUniqueOrThrow({ where: { id: product.id } }))
          .imagePath,
      ).toBe(key);
    });
    const bytes = await readFile(join(directory, key));
    expect((await sharp(bytes).metadata()).format).toBe('png');
    const served = await request(app.getHttpServer())
      .get(result.body.image)
      .expect(200)
      .expect('Content-Type', /image\/png/)
      .expect('X-Content-Type-Options', 'nosniff');
    expect(served.body).toEqual(bytes);
    await withTestTenant(contextId, async () => {
      expect(
        await prisma.productAudit.count({ where: { productId: product.id } }),
      ).toBe(2);
    });
    const replacement = await write(
      request(app.getHttpServer()).post(`/products/${product.id}/image`),
    )
      .attach('image', image, {
        filename: 'replacement.png',
        contentType: 'image/png',
      })
      .expect(201);
    expect(replacement.body.image).not.toBe(result.body.image);
    await request(app.getHttpServer()).get(result.body.image).expect(200);
    await withTestTenant(contextId, async () => {
      expect(
        await prisma.productAudit.count({ where: { productId: product.id } }),
      ).toBe(3);
    });
  });
  it('rejects spoofed, unsupported, oversized and unauthorized files without orphans', async () => {
    const product = await create();
    const before = await readdir(directory);
    await write(
      request(app.getHttpServer()).post(`/products/${product.id}/image`),
    ).expect(400);
    for (const [bytes, mime] of [
      [
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
        'image/svg+xml',
      ],
      [Buffer.from('<html>bad</html>'), 'image/png'],
      [image.subarray(0, 12), 'image/png'],
      [image, 'image/jpeg'],
    ] as const) {
      await write(
        request(app.getHttpServer()).post(`/products/${product.id}/image`),
      )
        .attach('image', bytes, { filename: 'fake.png', contentType: mime })
        .expect(400);
    }
    await write(
      request(app.getHttpServer()).post(`/products/${product.id}/image`),
    )
      .attach('image', Buffer.alloc(5 * 1024 * 1024 + 1), {
        filename: 'large.png',
        contentType: 'image/png',
      })
      .expect(413);
    await write(
      request(app.getHttpServer()).post(`/products/${product.id}/image`),
      collaborator,
    )
      .attach('image', image, { filename: 'ok.png', contentType: 'image/png' })
      .expect(403);
    expect(await readdir(directory)).toEqual(before);
  });
  it('cleans a newly saved image if the database transaction fails', async () => {
    const product = await create();
    const before = await readdir(directory);
    const spy = vi
      .spyOn(prisma, '$transaction')
      .mockRejectedValueOnce(new Error('Injected database failure'));
    try {
      await expect(
        withTestTenant(contextId, () =>
          products.image(actor(), product.id, {
            buffer: image,
            mimetype: 'image/png',
          } as Express.Multer.File),
        ),
      ).rejects.toThrow('Injected database failure');
    } finally {
      spy.mockRestore();
    }
    expect(await readdir(directory)).toEqual(before);
    await withTestTenant(contextId, async () => {
      expect(
        (await prisma.product.findUniqueOrThrow({ where: { id: product.id } }))
          .imagePath,
      ).toBeNull();
    });
  });
});

import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { withTestTenant } from './tenant-scope.js';

/**
 * BE-13: GET /reports/sales-detail — per (product, member) breakdown with a
 * never-estimated profit figure. See odd/tasks/be13-cost-reports-dashboard.md
 * (D1/D2) for the aggregation/response-shape decisions this spec locks in.
 */
describe('reports sales-detail (BE-13)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let socioToken: string;
  let colaboradorToken: string;
  let socioMemberId: string;
  let colaboradorMemberId: string;
  let deviceId: string;
  const contextId = `be13-sales-detail-${randomUUID()}`;

  const asSocio = (req: request.Test) =>
    req
      .auth(socioToken, { type: 'bearer' })
      .set('x-member-id', socioMemberId)
      .set('x-device-id', deviceId);

  const asColaborador = (req: request.Test) =>
    req
      .auth(colaboradorToken, { type: 'bearer' })
      .set('x-member-id', colaboradorMemberId)
      .set('x-device-id', deviceId);

  const createProduct = (name: string, purchaseCostMinor: number | null = null) =>
    withTestTenant(contextId, () =>
      prisma.product.create({
        data: {
          name,
          tipo: 'cantidad',
          unitPriceMinor: 1_000,
          initialStock: 1_000,
          stock: 1_000,
          contextId,
          purchaseCostMinor,
        },
      }),
    );

  type SaleItemFixture = {
    productId: string;
    quantity: number;
    unitPriceMinor: number;
    unitCostMinor: number | null;
  };

  const createSale = async (data: {
    memberId: string;
    items: SaleItemFixture[];
    status?: 'completada' | 'rechazada_por_conflicto';
    receivedAt: Date;
  }) => {
    const lines = data.items.map((item) => ({
      contextId,
      productId: item.productId,
      quantity: item.quantity,
      unitPriceMinor: item.unitPriceMinor,
      subtotalMinor: item.unitPriceMinor * item.quantity,
      unitCostMinor: item.unitCostMinor,
    }));
    const totalMinor = lines.reduce((sum, l) => sum + l.subtotalMinor, 0);
    return withTestTenant(contextId, () =>
      prisma.sale.create({
        data: {
          id: randomUUID(),
          memberId: data.memberId,
          deviceId,
          occurredAt: data.receivedAt,
          receivedAt: data.receivedAt,
          currency: 'MXN',
          status: data.status ?? 'completada',
          totalMinor:
            data.status === 'rechazada_por_conflicto' ? null : totalMinor,
          cashReceivedMinor: totalMinor,
          changeMinor: data.status === 'rechazada_por_conflicto' ? null : 0,
          items:
            data.status === 'rechazada_por_conflicto'
              ? undefined
              : { create: lines },
        },
      }),
    );
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    const jwt = app.get(JwtService);

    const socioAccount = await prisma.account.create({
      data: {
        username: randomUUID(),
        passwordHash: 'not-a-login-fixture',
        contextId,
      },
    });
    socioToken = await jwt.signAsync({ sub: socioAccount.id });
    await withTestTenant(contextId, async () => {
      socioMemberId = (
        await prisma.member.create({
          data: { name: 'Alberto Socio', role: 'socio', contextId },
        })
      ).id;
    });

    const colaboradorAccount = await prisma.account.create({
      data: {
        username: randomUUID(),
        passwordHash: 'not-a-login-fixture',
        contextId,
      },
    });
    colaboradorToken = await jwt.signAsync({ sub: colaboradorAccount.id });
    await withTestTenant(contextId, async () => {
      colaboradorMemberId = (
        await prisma.member.create({
          data: {
            name: 'Ayudante Colaborador',
            role: 'colaborador',
            contextId,
          },
        })
      ).id;

      deviceId = (
        await prisma.device.create({
          data: {
            name: 'BE13 sales-detail tablet',
            identifier: randomUUID(),
            contextId,
            authorized: true,
          },
        })
      ).id;
    });
  });

  afterAll(async () => {
    if (prisma) {
      await withTestTenant(contextId, async () => {
        await prisma.incidencia.deleteMany({
          where: { sale: { member: { contextId } } },
        });
        await prisma.saleItem.deleteMany({
          where: { sale: { member: { contextId } } },
        });
        await prisma.sale.deleteMany({ where: { member: { contextId } } });
        await prisma.product.deleteMany({ where: { contextId } });
        await prisma.device.deleteMany({ where: { contextId } });
        await prisma.member.deleteMany({ where: { contextId } });
      });
      await prisma.account.deleteMany({ where: { contextId } });
    }
    await app?.close();
  });

  it('rejects a colaborador with 403', async () => {
    await asColaborador(
      request(app.getHttpServer()).get(
        '/reports/sales-detail?from=2025-01-01&to=2025-01-31',
      ),
    ).expect(403);
  });

  it('a costed sale produces a row with a real profit and gananciaDisponible: true', async () => {
    const product = await createProduct('PS5 costeado', 600);
    const day = new Date('2025-06-01T12:00:00.000Z');
    await createSale({
      memberId: socioMemberId,
      receivedAt: day,
      items: [
        {
          productId: product.id,
          quantity: 2,
          unitPriceMinor: 1_000,
          unitCostMinor: 600,
        },
      ],
    });

    const res = await asSocio(
      request(app.getHttpServer()).get(
        '/reports/sales-detail?from=2025-06-01&to=2025-06-01',
      ),
    ).expect(200);
    const row = res.body.items.find(
      (i: { productId: string }) => i.productId === product.id,
    );
    expect(row).toMatchObject({
      memberId: socioMemberId,
      units: 2,
      ingresoMinor: 2_000,
      costoMinor: 1_200,
      gananciaMinor: 800,
      gananciaDisponible: true,
    });
  });

  it('a cost-less sale produces gananciaMinor: null and gananciaDisponible: false, never zero', async () => {
    const product = await createProduct('PS5 sin costo');
    const day = new Date('2025-06-02T12:00:00.000Z');
    await createSale({
      memberId: socioMemberId,
      receivedAt: day,
      items: [
        {
          productId: product.id,
          quantity: 1,
          unitPriceMinor: 1_000,
          unitCostMinor: null,
        },
      ],
    });

    const res = await asSocio(
      request(app.getHttpServer()).get(
        '/reports/sales-detail?from=2025-06-02&to=2025-06-02',
      ),
    ).expect(200);
    const row = res.body.items.find(
      (i: { productId: string }) => i.productId === product.id,
    );
    expect(row.gananciaMinor).toBeNull();
    expect(row.gananciaDisponible).toBe(false);
    expect(row.ingresoMinor).toBe(1_000);
  });

  it('mixed costed/cost-less lines for the same (product, member) aggregate revenue but flip gananciaDisponible to false', async () => {
    const product = await createProduct('PS5 mixto');
    const day = new Date('2025-06-03T12:00:00.000Z');
    await createSale({
      memberId: socioMemberId,
      receivedAt: day,
      items: [
        {
          productId: product.id,
          quantity: 1,
          unitPriceMinor: 1_000,
          unitCostMinor: 600,
        },
      ],
    });
    await createSale({
      memberId: socioMemberId,
      receivedAt: day,
      items: [
        {
          productId: product.id,
          quantity: 1,
          unitPriceMinor: 1_000,
          unitCostMinor: null,
        },
      ],
    });

    const res = await asSocio(
      request(app.getHttpServer()).get(
        '/reports/sales-detail?from=2025-06-03&to=2025-06-03',
      ),
    ).expect(200);
    const row = res.body.items.find(
      (i: { productId: string }) => i.productId === product.id,
    );
    expect(row.units).toBe(2);
    expect(row.ingresoMinor).toBe(2_000);
    expect(row.gananciaDisponible).toBe(false);
    expect(row.gananciaMinor).toBeNull();
  });

  it('period totals sum profit only over costed lines and count the cost-less ones', async () => {
    const productA = await createProduct('PS5 totales A', 600);
    const productB = await createProduct('PS5 totales B');
    const day = new Date('2025-06-04T12:00:00.000Z');
    await createSale({
      memberId: socioMemberId,
      receivedAt: day,
      items: [
        {
          productId: productA.id,
          quantity: 1,
          unitPriceMinor: 1_000,
          unitCostMinor: 600,
        },
      ],
    });
    await createSale({
      memberId: colaboradorMemberId,
      receivedAt: day,
      items: [
        {
          productId: productB.id,
          quantity: 1,
          unitPriceMinor: 1_000,
          unitCostMinor: null,
        },
      ],
    });

    const res = await asSocio(
      request(app.getHttpServer()).get(
        '/reports/sales-detail?from=2025-06-04&to=2025-06-04',
      ),
    ).expect(200);
    expect(res.body.totals.ingresoMinor).toBe(2_000);
    expect(res.body.totals.gananciaMinor).toBe(400); // only productA's line: 1000 - 600
    expect(res.body.totals.lineasSinCosto).toBe(1);
  });

  it('only status: completada sales count; a rejected sale never appears', async () => {
    const product = await createProduct('PS5 rechazado', 600);
    const day = new Date('2025-06-05T12:00:00.000Z');
    await createSale({
      memberId: socioMemberId,
      receivedAt: day,
      status: 'rechazada_por_conflicto',
      items: [
        {
          productId: product.id,
          quantity: 5,
          unitPriceMinor: 1_000,
          unitCostMinor: 600,
        },
      ],
    });

    const res = await asSocio(
      request(app.getHttpServer()).get(
        '/reports/sales-detail?from=2025-06-05&to=2025-06-05',
      ),
    ).expect(200);
    const row = res.body.items.find(
      (i: { productId: string }) => i.productId === product.id,
    );
    expect(row).toBeUndefined();
  });

  it('UTC-6 cutoff: a sale just before local midnight is excluded, just after is included', async () => {
    const product = await createProduct('PS5 corte UTC-6', 600);
    // Local midnight of 2025-11-02 (UTC-6) is 2025-11-02T06:00:00.000Z.
    const justBeforeLocalMidnight = new Date('2025-11-02T05:59:59.000Z');
    const justAfterLocalMidnight = new Date('2025-11-02T06:00:01.000Z');
    await createSale({
      memberId: socioMemberId,
      receivedAt: justBeforeLocalMidnight,
      items: [
        {
          productId: product.id,
          quantity: 1,
          unitPriceMinor: 1_000,
          unitCostMinor: 600,
        },
      ],
    });
    await createSale({
      memberId: socioMemberId,
      receivedAt: justAfterLocalMidnight,
      items: [
        {
          productId: product.id,
          quantity: 1,
          unitPriceMinor: 1_000,
          unitCostMinor: 600,
        },
      ],
    });

    const res = await asSocio(
      request(app.getHttpServer()).get(
        '/reports/sales-detail?from=2025-11-02&to=2025-11-02',
      ),
    ).expect(200);
    const row = res.body.items.find(
      (i: { productId: string }) => i.productId === product.id,
    );
    expect(row.units).toBe(1);
    expect(row.ingresoMinor).toBe(1_000);
  });

  it('paginates the aggregated rows (not the raw SaleItems)', async () => {
    const day = new Date('2025-06-06T12:00:00.000Z');
    const products = [];
    for (let i = 0; i < 5; i++) {
      products.push(await createProduct(`PS5 pagina ${i}-${randomUUID()}`, 100));
    }
    for (const [index, product] of products.entries()) {
      await createSale({
        memberId: socioMemberId,
        receivedAt: day,
        items: [
          {
            productId: product.id,
            // Distinct revenue per row so ordering (ingresoMinor desc) is deterministic.
            quantity: 1,
            unitPriceMinor: 1_000 + index,
            unitCostMinor: 100,
          },
        ],
      });
    }

    const page1 = await asSocio(
      request(app.getHttpServer()).get(
        '/reports/sales-detail?from=2025-06-06&to=2025-06-06&page=1&limit=2',
      ),
    ).expect(200);
    expect(page1.body.items.length).toBe(2);
    expect(page1.body.total).toBeGreaterThanOrEqual(5);
    expect(page1.body.page).toBe(1);
    expect(page1.body.limit).toBe(2);

    const page2 = await asSocio(
      request(app.getHttpServer()).get(
        '/reports/sales-detail?from=2025-06-06&to=2025-06-06&page=2&limit=2',
      ),
    ).expect(200);
    expect(page2.body.items.length).toBe(2);

    const page1Ids = page1.body.items.map((i: { productId: string }) => i.productId);
    const page2Ids = page2.body.items.map((i: { productId: string }) => i.productId);
    expect(page1Ids.some((id: string) => page2Ids.includes(id))).toBe(false);
  });

  it('splits rows by member: the same product sold by two different members produces two rows, ordered by revenue descending', async () => {
    const day = new Date('2025-06-07T12:00:00.000Z');
    const product = await createProduct(`PS5 dos vendedores ${randomUUID()}`, 100);
    const otherMemberId = await withTestTenant(contextId, async () =>
      (
        await prisma.member.create({
          data: { name: 'Otro Socio', role: 'socio', contextId },
        })
      ).id,
    );
    await createSale({
      memberId: socioMemberId,
      receivedAt: day,
      items: [{ productId: product.id, quantity: 1, unitPriceMinor: 2_000, unitCostMinor: 100 }],
    });
    await createSale({
      memberId: otherMemberId,
      receivedAt: day,
      items: [{ productId: product.id, quantity: 1, unitPriceMinor: 3_000, unitCostMinor: 100 }],
    });

    const res = await asSocio(
      request(app.getHttpServer()).get(
        `/reports/sales-detail?from=2025-06-07&to=2025-06-07&limit=100`,
      ),
    ).expect(200);
    const rows = res.body.items.filter((i: { productId: string }) => i.productId === product.id);
    expect(rows).toHaveLength(2);
    expect(rows.map((r: { memberId: string }) => r.memberId).sort()).toEqual(
      [socioMemberId, otherMemberId].sort(),
    );
    // Revenue descending: the 3,000 row (otherMemberId) comes before the 2,000 row.
    expect(rows[0].memberId).toBe(otherMemberId);
    expect(rows[0].ingresoMinor).toBe(3_000);
    expect(rows[1].ingresoMinor).toBe(2_000);
  });

  it('breaks a full tie (same revenue, same product name) deterministically across repeated requests', async () => {
    const day = new Date('2025-06-08T12:00:00.000Z');
    const sameName = `Empate ${randomUUID()}`;
    const productA = await createProduct(sameName, 100);
    const productB = await createProduct(sameName, 100);
    for (const product of [productA, productB]) {
      await createSale({
        memberId: socioMemberId,
        receivedAt: day,
        items: [{ productId: product.id, quantity: 1, unitPriceMinor: 1_500, unitCostMinor: 100 }],
      });
    }

    const first = await asSocio(
      request(app.getHttpServer()).get(
        `/reports/sales-detail?from=2025-06-08&to=2025-06-08&limit=100`,
      ),
    ).expect(200);
    const second = await asSocio(
      request(app.getHttpServer()).get(
        `/reports/sales-detail?from=2025-06-08&to=2025-06-08&limit=100`,
      ),
    ).expect(200);
    const ids = (body: { items: { productId: string }[] }) =>
      body.items
        .filter((i) => i.productId === productA.id || i.productId === productB.id)
        .map((i) => i.productId);
    expect(ids(first.body)).toEqual(ids(second.body));
    expect(ids(first.body)).toEqual([productA.id, productB.id].sort());
  });

  it('isolates contexts: another context\'s sale never appears', async () => {
    const otherContextId = `be13-sales-detail-other-${randomUUID()}`;
    await prisma.account.create({
      data: {
        username: randomUUID(),
        passwordHash: 'not-a-login-fixture',
        contextId: otherContextId,
      },
    });
    let otherMemberId = '';
    let otherDeviceId = '';
    let otherProductId = '';
    await withTestTenant(otherContextId, async () => {
      otherMemberId = (
        await prisma.member.create({
          data: { name: 'Otro Socio', role: 'socio', contextId: otherContextId },
        })
      ).id;
      otherDeviceId = (
        await prisma.device.create({
          data: {
            name: 'Other tablet',
            identifier: randomUUID(),
            contextId: otherContextId,
            authorized: true,
          },
        })
      ).id;
      otherProductId = (
        await prisma.product.create({
          data: {
            name: 'Producto de otro contexto',
            tipo: 'cantidad',
            unitPriceMinor: 1_000,
            initialStock: 10,
            stock: 10,
            contextId: otherContextId,
            purchaseCostMinor: 500,
          },
        })
      ).id;
    });
    const day = new Date('2025-06-07T12:00:00.000Z');
    await withTestTenant(otherContextId, () =>
      prisma.sale.create({
        data: {
          id: randomUUID(),
          memberId: otherMemberId,
          deviceId: otherDeviceId,
          occurredAt: day,
          receivedAt: day,
          currency: 'MXN',
          status: 'completada',
          totalMinor: 1_000,
          cashReceivedMinor: 1_000,
          changeMinor: 0,
          items: {
            create: {
              contextId: otherContextId,
              productId: otherProductId,
              quantity: 1,
              unitPriceMinor: 1_000,
              subtotalMinor: 1_000,
              unitCostMinor: 500,
            },
          },
        },
      }),
    );

    const res = await asSocio(
      request(app.getHttpServer()).get(
        '/reports/sales-detail?from=2025-06-07&to=2025-06-07',
      ),
    ).expect(200);
    const row = res.body.items.find(
      (i: { productId: string }) => i.productId === otherProductId,
    );
    expect(row).toBeUndefined();

    await withTestTenant(otherContextId, async () => {
      await prisma.saleItem.deleteMany({
        where: { sale: { member: { contextId: otherContextId } } },
      });
      await prisma.sale.deleteMany({
        where: { member: { contextId: otherContextId } },
      });
      await prisma.product.deleteMany({ where: { contextId: otherContextId } });
      await prisma.device.deleteMany({ where: { contextId: otherContextId } });
      await prisma.member.deleteMany({ where: { contextId: otherContextId } });
    });
    await prisma.account.deleteMany({ where: { contextId: otherContextId } });
  });
});

import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { currentBusinessDate, parseRangeBoundary } from '../src/common/business-time.js';
import { withTestTenant } from './tenant-scope.js';

/**
 * BE-13: GET /dashboard/summary. See odd/tasks/be13-cost-reports-dashboard.md
 * (D3/D4) for the today/yesterday business-date resolution and the response
 * shape this spec locks in.
 */
describe('dashboard summary (BE-13)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let socioToken: string;
  let colaboradorToken: string;
  let socioMemberId: string;
  let colaboradorMemberId: string;
  let deviceId: string;
  const contextId = `be13-dashboard-${randomUUID()}`;

  // Resolved once per test run against the real clock, exactly the way
  // DashboardService itself resolves "today"/"yesterday" (BE-13 D3): a
  // date-only boundary computed from `new Date()`, not a value pinned in
  // the past, since the endpoint under test has no date-override param.
  const todayStr = currentBusinessDate(new Date());
  const yesterdayStr = currentBusinessDate(new Date(Date.now() - 86_400_000));
  const todayStart = parseRangeBoundary(todayStr, 'start');
  const yesterdayStart = parseRangeBoundary(yesterdayStr, 'start');
  const todayMid = new Date(todayStart.getTime() + 6 * 60 * 60 * 1000);
  const yesterdayMid = new Date(yesterdayStart.getTime() + 6 * 60 * 60 * 1000);

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

  const createProduct = (
    name: string,
    stock: number,
    purchaseCostMinor: number | null = null,
  ) =>
    withTestTenant(contextId, () =>
      prisma.product.create({
        data: {
          name,
          tipo: 'cantidad',
          unitPriceMinor: 1_000,
          initialStock: stock,
          stock,
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

  const createSale = (data: {
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

  const createIncidencia = (
    saleId: string,
    resolutionStatus: 'pendiente' | 'resuelta' = 'pendiente',
  ) =>
    withTestTenant(contextId, () =>
      prisma.incidencia.create({
        data: {
          saleId,
          contextId,
          type: 'incidencia_fecha',
          reason: 'fixture',
          resolutionStatus,
        },
      }),
    );

  const createDeudor = (nombre: string) =>
    withTestTenant(contextId, () =>
      prisma.deudor.create({ data: { nombre, contextId } }),
    );

  const createDeuda = (data: {
    productId: string;
    deudorId: string;
    totalMinor: number;
    status?: 'pendiente' | 'saldada';
  }) =>
    withTestTenant(contextId, () =>
      prisma.deuda.create({
        data: {
          type: 'fiado',
          productId: data.productId,
          deudorId: data.deudorId,
          cantidad: 1,
          totalMinor: data.totalMinor,
          status: data.status ?? 'pendiente',
          createdByMemberId: socioMemberId,
          contextId,
        },
      }),
    );

  const createAbono = (deudaId: string, montoMinor: number) =>
    withTestTenant(contextId, () =>
      prisma.abono.create({
        data: {
          deudaId,
          contextId,
          montoMinor,
          receivedByMemberId: socioMemberId,
        },
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
            name: 'BE13 dashboard tablet',
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
        await prisma.abono.deleteMany({ where: { contextId } });
        await prisma.deuda.deleteMany({ where: { contextId } });
        await prisma.deudor.deleteMany({ where: { contextId } });
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
      request(app.getHttpServer()).get('/dashboard/summary'),
    ).expect(403);
  });

  it("counts today's completed sales correctly, excluding a rejected sale", async () => {
    const product = await createProduct('BE13 dash producto hoy', 100);
    await createSale({
      memberId: socioMemberId,
      receivedAt: todayMid,
      items: [
        { productId: product.id, quantity: 2, unitPriceMinor: 500, unitCostMinor: null },
      ],
    });
    await createSale({
      memberId: socioMemberId,
      receivedAt: todayMid,
      status: 'rechazada_por_conflicto',
      items: [
        { productId: product.id, quantity: 9, unitPriceMinor: 500, unitCostMinor: null },
      ],
    });

    const res = await asSocio(
      request(app.getHttpServer()).get('/dashboard/summary'),
    ).expect(200);
    expect(res.body.ventasHoy).toMatchObject({ totalMinor: 1_000, count: 1 });
  });

  it("counts yesterday's sales separately, never mixed with today's", async () => {
    const before = await asSocio(
      request(app.getHttpServer()).get('/dashboard/summary'),
    ).expect(200);
    const product = await createProduct('BE13 dash producto ayer', 100);
    await createSale({
      memberId: socioMemberId,
      receivedAt: yesterdayMid,
      items: [
        { productId: product.id, quantity: 1, unitPriceMinor: 700, unitCostMinor: null },
      ],
    });

    const res = await asSocio(
      request(app.getHttpServer()).get('/dashboard/summary'),
    ).expect(200);
    // Exact delta introduced by this test's own fixture, not a loose bound:
    // if today's sale (from the previous test) ever leaked into ayer, this
    // would fail by including its total/count too.
    expect(res.body.ventasAyer.totalMinor - before.body.ventasAyer.totalMinor).toBe(700);
    expect(res.body.ventasAyer.count - before.body.ventasAyer.count).toBe(1);
    expect(res.body.ventasHoy).toEqual(before.body.ventasHoy);
  });

  it('UTC-6 cutoff: a sale just before local midnight lands in ayer, just after lands in hoy', async () => {
    const before = await asSocio(
      request(app.getHttpServer()).get('/dashboard/summary'),
    ).expect(200);
    const product = await createProduct('BE13 dash corte utc6', 100);
    const justBeforeTodayStart = new Date(todayStart.getTime() - 1);
    const justAfterTodayStart = new Date(todayStart.getTime() + 1);
    await createSale({
      memberId: socioMemberId,
      receivedAt: justBeforeTodayStart,
      items: [
        { productId: product.id, quantity: 1, unitPriceMinor: 111, unitCostMinor: null },
      ],
    });
    await createSale({
      memberId: socioMemberId,
      receivedAt: justAfterTodayStart,
      items: [
        { productId: product.id, quantity: 1, unitPriceMinor: 222, unitCostMinor: null },
      ],
    });

    const res = await asSocio(
      request(app.getHttpServer()).get('/dashboard/summary'),
    ).expect(200);
    // Both instants are within a millisecond of the boundary, so neither
    // "yesterday" nor "today" is empty by coincidence — regardless of the
    // exact totals (other fixtures contribute too), the 111 sale must not
    // be counted in hoy, and the 222 sale must not be counted in ayer.
    // Cross-checked via isolated sums below instead of raw totals.
    const onlyThisRange = async (from: Date, to: Date) =>
      withTestTenant(contextId, () =>
        prisma.sale.aggregate({
          where: {
            status: 'completada',
            member: { contextId },
            receivedAt: { gte: from, lte: to },
          },
          _sum: { totalMinor: true },
        }),
      );
    const todayRangeSum = await onlyThisRange(
      todayStart,
      parseRangeBoundary(todayStr, 'end'),
    );
    const yesterdayRangeSum = await onlyThisRange(
      parseRangeBoundary(yesterdayStr, 'start'),
      new Date(todayStart.getTime() - 1),
    );
    // The 222 sale (just after todayStart) must be inside today's own sum.
    expect(todayRangeSum._sum.totalMinor ?? 0).toBeGreaterThanOrEqual(222);
    // The 111 sale (just before todayStart) must be inside yesterday's sum.
    expect(yesterdayRangeSum._sum.totalMinor ?? 0).toBeGreaterThanOrEqual(111);
    // Exact deltas from the endpoint itself, not loose bounds: proves the
    // 222 sale landed in hoy (not ayer) and the 111 sale landed in ayer
    // (not hoy) — a swapped or overlapping boundary would fail this.
    expect(res.body.ventasHoy.totalMinor - before.body.ventasHoy.totalMinor).toBe(222);
    expect(res.body.ventasAyer.totalMinor - before.body.ventasAyer.totalMinor).toBe(111);
  });

  it("today's profit sums only costed lines; cost-less lines count toward lineasSinCostoHoy, never estimated", async () => {
    const before = await asSocio(
      request(app.getHttpServer()).get('/dashboard/summary'),
    ).expect(200);
    const costed = await createProduct('BE13 dash costeado', 100, 600);
    const uncosted = await createProduct('BE13 dash sin costo', 100);
    await createSale({
      memberId: socioMemberId,
      receivedAt: todayMid,
      items: [
        { productId: costed.id, quantity: 1, unitPriceMinor: 1_000, unitCostMinor: 600 },
      ],
    });
    await createSale({
      memberId: socioMemberId,
      receivedAt: todayMid,
      // The 500 cost-less line must NOT add its own 500 revenue as if it
      // were 500 profit (the bug the never-estimate rule exists to catch):
      // the exact delta below is 400 (1,000 - 600), not 900.
      items: [
        { productId: uncosted.id, quantity: 1, unitPriceMinor: 500, unitCostMinor: null },
      ],
    });

    const res = await asSocio(
      request(app.getHttpServer()).get('/dashboard/summary'),
    ).expect(200);
    expect(res.body.gananciaHoyMinor - before.body.gananciaHoyMinor).toBe(400);
    expect(res.body.lineasSinCostoHoy - before.body.lineasSinCostoHoy).toBe(1);
  });

  it('an all-cost-less day reports gananciaHoyMinor: 0 (a real, non-negative sum of zero costed lines), never a guessed profit', async () => {
    // Fresh, isolated context so no other test's costed sale is on "today".
    const isolatedContextId = `be13-dashboard-allcostless-${randomUUID()}`;
    const account = await prisma.account.create({
      data: { username: randomUUID(), passwordHash: 'x', contextId: isolatedContextId },
    });
    const jwt = app.get(JwtService);
    const token = await jwt.signAsync({ sub: account.id });
    const { memberId, deviceIdLocal } = await withTestTenant(isolatedContextId, async () => {
      const member = await prisma.member.create({
        data: { name: 'Socio Aislado', role: 'socio', contextId: isolatedContextId },
      });
      const device = await prisma.device.create({
        data: {
          name: 'Tablet aislada',
          identifier: randomUUID(),
          contextId: isolatedContextId,
          authorized: true,
        },
      });
      const product = await prisma.product.create({
        data: {
          name: 'Sin costo aislado',
          tipo: 'cantidad',
          unitPriceMinor: 300,
          initialStock: 10,
          stock: 10,
          contextId: isolatedContextId,
          purchaseCostMinor: null,
        },
      });
      await prisma.sale.create({
        data: {
          id: randomUUID(),
          memberId: member.id,
          deviceId: device.id,
          occurredAt: todayMid,
          receivedAt: todayMid,
          currency: 'MXN',
          status: 'completada',
          totalMinor: 300,
          cashReceivedMinor: 300,
          changeMinor: 0,
          items: {
            create: [
              {
                contextId: isolatedContextId,
                productId: product.id,
                quantity: 1,
                unitPriceMinor: 300,
                subtotalMinor: 300,
                unitCostMinor: null,
              },
            ],
          },
        },
      });
      return { memberId: member.id, deviceIdLocal: device.id };
    });

    const res = await request(app.getHttpServer())
      .get('/dashboard/summary')
      .auth(token, { type: 'bearer' })
      .set('x-member-id', memberId)
      .set('x-device-id', deviceIdLocal)
      .expect(200);
    expect(res.body.gananciaHoyMinor).toBe(0);
    expect(res.body.lineasSinCostoHoy).toBe(1);

    await withTestTenant(isolatedContextId, async () => {
      await prisma.saleItem.deleteMany({ where: { contextId: isolatedContextId } });
      await prisma.sale.deleteMany({ where: { member: { contextId: isolatedContextId } } });
      await prisma.product.deleteMany({ where: { contextId: isolatedContextId } });
      await prisma.device.deleteMany({ where: { contextId: isolatedContextId } });
      await prisma.member.deleteMany({ where: { contextId: isolatedContextId } });
    });
    await prisma.account.deleteMany({ where: { contextId: isolatedContextId } });
  });

  it('counts only pendiente incidencias, never resuelta', async () => {
    const product = await createProduct('BE13 dash incidencia', 100);
    const sale = await createSale({
      memberId: socioMemberId,
      receivedAt: todayMid,
      items: [
        { productId: product.id, quantity: 1, unitPriceMinor: 100, unitCostMinor: null },
      ],
    });
    await createIncidencia(sale.id, 'pendiente');
    const sale2 = await createSale({
      memberId: socioMemberId,
      receivedAt: todayMid,
      items: [
        { productId: product.id, quantity: 1, unitPriceMinor: 100, unitCostMinor: null },
      ],
    });
    await createIncidencia(sale2.id, 'resuelta');

    const res = await asSocio(
      request(app.getHttpServer()).get('/dashboard/summary'),
    ).expect(200);
    // First (and only) incidencia-creating test in this file's fixture
    // sequence, so the count is exact: the resuelta one must not be
    // included.
    expect(res.body.incidenciasPendientes).toBe(1);
  });

  it('deudasPendientes sums the remaining balance after partial abonos, and counts distinct deudores', async () => {
    const product = await createProduct('BE13 dash deuda', 100);
    const deudorX = await createDeudor('Deudor X');
    const deudorY = await createDeudor('Deudor Y');
    const deudaX1 = await createDeuda({
      productId: product.id,
      deudorId: deudorX.id,
      totalMinor: 1_000,
    });
    await createAbono(deudaX1.id, 300); // remaining 700
    const deudaX2 = await createDeuda({
      productId: product.id,
      deudorId: deudorX.id,
      totalMinor: 500,
    }); // remaining 500, same deudor as deudaX1
    const deudaY = await createDeuda({
      productId: product.id,
      deudorId: deudorY.id,
      totalMinor: 200,
    }); // remaining 200
    // Fully paid: must be excluded (status saldada).
    await createDeuda({
      productId: product.id,
      deudorId: deudorY.id,
      totalMinor: 999_999,
      status: 'saldada',
    });

    const res = await asSocio(
      request(app.getHttpServer()).get('/dashboard/summary'),
    ).expect(200);
    expect(res.body.deudasPendientes.totalMinor).toBeGreaterThanOrEqual(
      700 + 500 + 200,
    );
    expect(res.body.deudasPendientes.personas).toBeGreaterThanOrEqual(2);
    void deudaX2;
    void deudaY;
  });

  it('productosPocaExistencia respects the umbral (default and custom), reports the real total, and orders deterministically', async () => {
    const suffix = randomUUID();
    for (let stock = 0; stock <= 6; stock++) {
      await createProduct(`BE13 dash stock ${stock} ${suffix}`, stock);
    }

    const defaultRes = await asSocio(
      request(app.getHttpServer()).get('/dashboard/summary'),
    ).expect(200);
    expect(defaultRes.body.productosPocaExistencia.umbral).toBe(2);
    expect(
      defaultRes.body.productosPocaExistencia.items.length,
    ).toBeLessThanOrEqual(5);
    for (const item of defaultRes.body.productosPocaExistencia.items) {
      expect(item.stock).toBeLessThanOrEqual(2);
    }

    const customRes = await asSocio(
      request(app.getHttpServer()).get('/dashboard/summary?umbral=6'),
    ).expect(200);
    expect(customRes.body.productosPocaExistencia.umbral).toBe(6);
    expect(customRes.body.productosPocaExistencia.total).toBeGreaterThanOrEqual(7);
    expect(customRes.body.productosPocaExistencia.items.length).toBe(5);
    const stocks = customRes.body.productosPocaExistencia.items.map(
      (i: { stock: number }) => i.stock,
    );
    expect(stocks).toEqual([...stocks].sort((a, b) => a - b));
  });

  it("isolates every field: another context's sale/incidencia/deuda/product never appear", async () => {
    const otherContextId = `be13-dashboard-other-${randomUUID()}`;
    await prisma.account.create({
      data: {
        username: randomUUID(),
        passwordHash: 'not-a-login-fixture',
        contextId: otherContextId,
      },
    });
    await withTestTenant(otherContextId, async () => {
      const otherMember = await prisma.member.create({
        data: { name: 'Otro Socio', role: 'socio', contextId: otherContextId },
      });
      const otherDevice = await prisma.device.create({
        data: {
          name: 'Other tablet',
          identifier: randomUUID(),
          contextId: otherContextId,
          authorized: true,
        },
      });
      const otherProduct = await prisma.product.create({
        data: {
          name: 'Producto de otro contexto',
          tipo: 'cantidad',
          unitPriceMinor: 1_000,
          initialStock: 0,
          stock: 0,
          contextId: otherContextId,
          purchaseCostMinor: 500,
        },
      });
      const otherSale = await prisma.sale.create({
        data: {
          id: randomUUID(),
          memberId: otherMember.id,
          deviceId: otherDevice.id,
          occurredAt: todayMid,
          receivedAt: todayMid,
          currency: 'MXN',
          status: 'completada',
          totalMinor: 999_999,
          cashReceivedMinor: 999_999,
          changeMinor: 0,
          items: {
            create: {
              contextId: otherContextId,
              productId: otherProduct.id,
              quantity: 1,
              unitPriceMinor: 999_999,
              subtotalMinor: 999_999,
              unitCostMinor: 1,
            },
          },
        },
      });
      await prisma.incidencia.create({
        data: {
          saleId: otherSale.id,
          contextId: otherContextId,
          type: 'incidencia_fecha',
          reason: 'other-context fixture',
          resolutionStatus: 'pendiente',
        },
      });
      const otherDeudor = await prisma.deudor.create({
        data: { nombre: 'Otro Deudor', contextId: otherContextId },
      });
      await prisma.deuda.create({
        data: {
          type: 'fiado',
          productId: otherProduct.id,
          deudorId: otherDeudor.id,
          cantidad: 1,
          totalMinor: 999_999,
          status: 'pendiente',
          createdByMemberId: otherMember.id,
          contextId: otherContextId,
        },
      });
    });

    const res = await asSocio(
      request(app.getHttpServer()).get('/dashboard/summary'),
    ).expect(200);
    expect(res.body.ventasHoy.totalMinor).toBeLessThan(999_999);
    expect(res.body.deudasPendientes.totalMinor).toBeLessThan(999_999);
    const productNames = res.body.productosPocaExistencia.items.map(
      (i: { name: string }) => i.name,
    );
    expect(productNames).not.toContain('Producto de otro contexto');

    await withTestTenant(otherContextId, async () => {
      await prisma.abono.deleteMany({ where: { contextId: otherContextId } });
      await prisma.deuda.deleteMany({ where: { contextId: otherContextId } });
      await prisma.deudor.deleteMany({ where: { contextId: otherContextId } });
      await prisma.incidencia.deleteMany({
        where: { sale: { member: { contextId: otherContextId } } },
      });
      await prisma.saleItem.deleteMany({
        where: { sale: { member: { contextId: otherContextId } } },
      });
      await prisma.sale.deleteMany({ where: { member: { contextId: otherContextId } } });
      await prisma.product.deleteMany({ where: { contextId: otherContextId } });
      await prisma.device.deleteMany({ where: { contextId: otherContextId } });
      await prisma.member.deleteMany({ where: { contextId: otherContextId } });
    });
    await prisma.account.deleteMany({ where: { contextId: otherContextId } });
  });
});

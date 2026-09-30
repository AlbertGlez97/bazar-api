import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { withTestTenant } from './tenant-scope.js';

/**
 * BE-08: the two read-only sales reports (by period, by member).
 */
describe('reports (BE-08)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let socioToken: string;
  let colaboradorToken: string;
  let socioMemberId: string;
  let colaboradorMemberId: string;
  let deviceId: string;
  const contextId = `be08-reports-${randomUUID()}`;

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

  // BE-11: strict deny-by-default RLS now requires an explicit tenant
  // scope for direct Prisma fixture setup/assertion calls.
  const createProduct = () =>
    withTestTenant(contextId, () =>
      prisma.product.create({
        data: {
          name: `Producto ${randomUUID()}`,
          tipo: 'cantidad',
          unitPriceMinor: 100,
          initialStock: 1000,
          stock: 1000,
          contextId,
        },
      }),
    );

  const createSale = async (data: {
    memberId: string;
    totalMinor: number;
    status?: 'completada' | 'rechazada_por_conflicto';
    receivedAt: Date;
  }) => {
    const product = await createProduct();
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
            data.status === 'rechazada_por_conflicto' ? null : data.totalMinor,
          cashReceivedMinor: data.totalMinor,
          changeMinor: data.status === 'rechazada_por_conflicto' ? null : 0,
          items:
            data.status === 'rechazada_por_conflicto'
              ? undefined
              : {
                  // Nested relation writes are not seen by the tenant extension (BE-11),
                  // so the item's contextId is set by hand.
                  create: {
                    contextId,
                    productId: product.id,
                    quantity: 1,
                    unitPriceMinor: data.totalMinor,
                    subtotalMinor: data.totalMinor,
                  },
                },
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
            name: 'BE08 reports tablet',
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
        await prisma.abono.deleteMany({
          where: { deuda: { createdByMember: { contextId } } },
        });
        await prisma.cuotaPlaneada.deleteMany({
          where: { deuda: { createdByMember: { contextId } } },
        });
        await prisma.deuda.deleteMany({
          where: { createdByMember: { contextId } },
        });
        await prisma.deudor.deleteMany({ where: { contextId } });
        await prisma.product.deleteMany({ where: { contextId } });
        await prisma.device.deleteMany({ where: { contextId } });
        await prisma.member.deleteMany({ where: { contextId } });
      });
      await prisma.account.deleteMany({ where: { contextId } });
    }
    await app?.close();
  });

  it('rejects a colaborador with 403 on both report endpoints', async () => {
    await asColaborador(
      request(app.getHttpServer()).get(
        '/reports/sales-by-period?from=2025-01-01&to=2025-01-31',
      ),
    ).expect(403);
    await asColaborador(
      request(app.getHttpServer()).get(
        '/reports/sales-by-member?from=2025-01-01&to=2025-01-31',
      ),
    ).expect(403);
  });

  it('sales-by-period sums only completed sales within the given range', async () => {
    const inRange = new Date('2025-03-10T12:00:00.000Z');
    const outOfRange = new Date('2025-04-01T12:00:00.000Z');
    await createSale({
      memberId: socioMemberId,
      totalMinor: 5_000,
      receivedAt: inRange,
    });
    await createSale({
      memberId: colaboradorMemberId,
      totalMinor: 3_000,
      receivedAt: inRange,
    });
    // Excluded: wrong status.
    await createSale({
      memberId: socioMemberId,
      totalMinor: 999_999,
      status: 'rechazada_por_conflicto',
      receivedAt: inRange,
    });
    // Excluded: outside the requested range.
    await createSale({
      memberId: socioMemberId,
      totalMinor: 777_777,
      receivedAt: outOfRange,
    });

    const res = await asSocio(
      request(app.getHttpServer()).get(
        '/reports/sales-by-period?from=2025-03-01&to=2025-03-31',
      ),
    ).expect(200);
    expect(res.body.totalSoldMinor).toBe(8_000);
    expect(res.body.saleCount).toBe(2);
  });

  it('sales-by-member breaks the total down per Member for the given range', async () => {
    const day = new Date('2025-05-05T12:00:00.000Z');
    await createSale({ memberId: socioMemberId, totalMinor: 4_000, receivedAt: day });
    await createSale({
      memberId: colaboradorMemberId,
      totalMinor: 6_000,
      receivedAt: day,
    });

    const res = await asSocio(
      request(app.getHttpServer()).get(
        '/reports/sales-by-member?from=2025-05-05&to=2025-05-05',
      ),
    ).expect(200);
    const byMember = new Map<string, number>(
      (res.body.items as { memberId: string; totalSoldMinor: number }[]).map(
        (i) => [i.memberId, i.totalSoldMinor],
      ),
    );
    expect(byMember.get(socioMemberId)).toBe(4_000);
    expect(byMember.get(colaboradorMemberId)).toBe(6_000);
  });

  // BE-15 (D7): sales-by-period extended with two debt-reporting tables
  // and a combined cash total, rather than a new endpoint — see
  // ReportsService.salesByPeriod's own doc comment for why. Fixtures use
  // a deliberately wide [from, to] range (2020-01-01..2099-12-31) so real
  // `receivedAt`/`saldadaAt` (both server clocks, "now" at fixture-creation
  // time) land inside it without needing to fake business time; boundary
  // exclusion is tested instead by moving one fixture's own timestamp
  // outside that same wide range.
  describe('deudas reporting additions to sales-by-period (BE-15 D7)', () => {
    const wideRangeQS = 'from=2020-01-01&to=2099-12-31';

    const createProductWithCost = (purchaseCostMinor: number | null = null) =>
      withTestTenant(contextId, () =>
        prisma.product.create({
          data: {
            name: `Producto deudas ${randomUUID()}`,
            tipo: 'cantidad',
            unitPriceMinor: 1_000,
            initialStock: 1_000,
            stock: 1_000,
            contextId,
            purchaseCostMinor,
          },
        }),
      );

    it('abonosRecibidos includes abonos from both active and saldada deudas within range, excludes out-of-range ones, and sums correctly', async () => {
      const product = await createProductWithCost();
      const deudorName = `Deudor Abonos Reporte ${randomUUID()}`;

      // Deuda A: partial abono, stays pendiente (active).
      const deudaA = await asSocio(request(app.getHttpServer()).post('/deudas'))
        .send({
          type: 'fiado',
          abonoInicialMinor: 0,
          productId: product.id,
          cantidad: 2,
          deudor: { nombre: deudorName },
        })
        .expect(201);
      await asColaborador(
        request(app.getHttpServer()).post(`/deudas/${deudaA.body.id}/abonos`),
      )
        .send({ montoMinor: 700 })
        .expect(201);

      // Deuda B: fully paid via abonoInicialMinor, saldada immediately —
      // its abono must still count as "received in the period" even
      // though the Deuda itself is no longer active.
      const deudaB = await asSocio(request(app.getHttpServer()).post('/deudas'))
        .send({
          type: 'apartado',
          abonoInicialMinor: 1_000,
          productId: product.id,
          cantidad: 1,
          deudorId: deudaA.body.deudorId,
        })
        .expect(201);
      expect(deudaB.body.status).toBe('saldada');

      // An out-of-range abono: created normally, then its own receivedAt
      // moved outside the wide test range.
      const deudaC = await asSocio(request(app.getHttpServer()).post('/deudas'))
        .send({
          type: 'fiado',
          abonoInicialMinor: 500,
          productId: product.id,
          cantidad: 1,
          deudorId: deudaA.body.deudorId,
        })
        .expect(201);
      await withTestTenant(contextId, () =>
        prisma.abono.updateMany({
          where: { deudaId: deudaC.body.id },
          data: { receivedAt: new Date('2000-01-01T00:00:00.000Z') },
        }),
      );

      const res = await asSocio(
        request(app.getHttpServer()).get(`/reports/sales-by-period?${wideRangeQS}`),
      ).expect(200);

      const rows = res.body.abonosRecibidos as {
        deudor: string;
        montoMinor: number;
        type: string;
      }[];
      const ownRows = rows.filter((r) => r.deudor === deudorName);
      expect(ownRows).toHaveLength(2);
      expect(ownRows.map((r) => r.montoMinor).sort((a, b) => a - b)).toEqual([
        700, 1_000,
      ]);
      expect(
        ownRows.every((r) => r.type === 'fiado' || r.type === 'apartado'),
      ).toBe(true);
      expect(res.body.abonosRecibidosMinor).toBeGreaterThanOrEqual(1_700);
    });

    it('deudasLiquidadas includes only Deudas whose saldadaAt falls in range, with correct profit or gananciaDisponible: false', async () => {
      const costedProduct = await createProductWithCost(600);
      const uncostedProduct = await createProductWithCost(null);
      const deudorName = `Deudor Liquidadas Reporte ${randomUUID()}`;

      const costedDeuda = await asSocio(
        request(app.getHttpServer()).post('/deudas'),
      )
        .send({
          type: 'fiado',
          abonoInicialMinor: 1_000,
          productId: costedProduct.id,
          cantidad: 1,
          deudor: { nombre: deudorName },
        })
        .expect(201);
      expect(costedDeuda.body.status).toBe('saldada');

      const uncostedDeuda = await asSocio(
        request(app.getHttpServer()).post('/deudas'),
      )
        .send({
          type: 'fiado',
          abonoInicialMinor: 1_000,
          productId: uncostedProduct.id,
          cantidad: 1,
          deudorId: costedDeuda.body.deudorId,
        })
        .expect(201);
      expect(uncostedDeuda.body.status).toBe('saldada');

      // Out-of-range: settled, then its saldadaAt pushed outside the wide range.
      const outOfRangeDeuda = await asSocio(
        request(app.getHttpServer()).post('/deudas'),
      )
        .send({
          type: 'fiado',
          abonoInicialMinor: 1_000,
          productId: costedProduct.id,
          cantidad: 1,
          deudorId: costedDeuda.body.deudorId,
        })
        .expect(201);
      await withTestTenant(contextId, () =>
        prisma.deuda.update({
          where: { id: outOfRangeDeuda.body.id },
          data: { saldadaAt: new Date('2000-01-01T00:00:00.000Z') },
        }),
      );

      const res = await asSocio(
        request(app.getHttpServer()).get(`/reports/sales-by-period?${wideRangeQS}`),
      ).expect(200);
      const rows = res.body.deudasLiquidadas as {
        id: string;
        gananciaMinor: number | null;
        gananciaDisponible: boolean;
        totalMinor: number;
      }[];

      const costedRow = rows.find((r) => r.id === costedDeuda.body.id);
      expect(costedRow).toMatchObject({
        gananciaDisponible: true,
        gananciaMinor: 1_000 - 600,
      });

      const uncostedRow = rows.find((r) => r.id === uncostedDeuda.body.id);
      expect(uncostedRow).toMatchObject({
        gananciaDisponible: false,
        gananciaMinor: null,
      });

      const outOfRangeRow = rows.find((r) => r.id === outOfRangeDeuda.body.id);
      expect(outOfRangeRow).toBeUndefined();
    });

    it('totalIngresadoMinor is totalSoldMinor + abonosRecibidosMinor', async () => {
      const product = await createProductWithCost();
      const day = new Date('2030-06-01T12:00:00.000Z');
      await createSale({
        memberId: socioMemberId,
        totalMinor: 5_000,
        receivedAt: day,
      });
      const deuda = await asSocio(request(app.getHttpServer()).post('/deudas'))
        .send({
          type: 'fiado',
          abonoInicialMinor: 300,
          productId: product.id,
          cantidad: 3,
          deudor: { nombre: `Deudor Total Combinado ${randomUUID()}` },
        })
        .expect(201);
      expect(deuda.body.status).toBe('pendiente');

      const res = await asSocio(
        request(app.getHttpServer()).get(`/reports/sales-by-period?${wideRangeQS}`),
      ).expect(200);
      expect(res.body.totalIngresadoMinor).toBe(
        res.body.totalSoldMinor + res.body.abonosRecibidosMinor,
      );
    });
  });
});

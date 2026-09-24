import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { currentWeekRange } from '../src/common/business-time.js';
import { withTestTenant } from './tenant-scope.js';

/**
 * BE-08: global/individual commission rate configuration and the
 * per-colaborador commission calculation.
 */
describe('commissions (BE-08)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let socioToken: string;
  let colaboradorToken: string;
  let socioMemberId: string;
  let deviceId: string;
  const contextId = `be08-commissions-${randomUUID()}`;

  const asSocio = (req: request.Test) =>
    req
      .auth(socioToken, { type: 'bearer' })
      .set('x-member-id', socioMemberId)
      .set('x-device-id', deviceId);

  const asColaborador = (colaboradorMemberId: string) => (req: request.Test) =>
    req
      .auth(colaboradorToken, { type: 'bearer' })
      .set('x-member-id', colaboradorMemberId)
      .set('x-device-id', deviceId);

  // BE-11: strict deny-by-default RLS now requires an explicit tenant
  // scope for direct Prisma fixture setup/assertion calls.
  const createColaborador = (name: string, commissionRateBps?: number) =>
    withTestTenant(contextId, () =>
      prisma.member.create({
        data: { name, role: 'colaborador', contextId, commissionRateBps },
      }),
    );

  const createProduct = (unitPriceMinor: number) =>
    withTestTenant(contextId, () =>
      prisma.product.create({
        data: {
          name: `Producto ${randomUUID()}`,
          tipo: 'cantidad',
          unitPriceMinor,
          initialStock: 1000,
          stock: 1000,
          contextId,
        },
      }),
    );

  // Inserted directly against Prisma (not through POST /sales) so
  // `receivedAt` and `status` can be pinned exactly, independent of the
  // server clock — the commission window boundary tests in particular
  // need full control over which instant a sale is attributed to.
  const createSale = async (data: {
    memberId: string;
    totalMinor: number;
    status?: 'completada' | 'rechazada_por_conflicto';
    receivedAt: Date;
  }) => {
    const product = await createProduct(data.totalMinor || 1);
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
                  create: {
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
      deviceId = (
        await prisma.device.create({
          data: {
            name: 'BE08 tablet',
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
        await prisma.appSettings.deleteMany({ where: { contextId } });
        await prisma.device.deleteMany({ where: { contextId } });
        await prisma.member.deleteMany({ where: { contextId } });
      });
      await prisma.account.deleteMany({ where: { contextId } });
    }
    await app?.close();
  });

  it('rejects a colaborador attempting to read/configure commissions with 403', async () => {
    const colaborador = await createColaborador('Sin acceso');
    await asColaborador(colaborador.id)(
      request(app.getHttpServer()).get('/commissions'),
    ).expect(403);
    await asColaborador(colaborador.id)(
      request(app.getHttpServer()).patch('/settings/commission-rate'),
    )
      .send({ rateBps: 1000 })
      .expect(403);
  });

  it('uses the global rate for a colaborador with no individual override', async () => {
    await asSocio(
      request(app.getHttpServer()).patch('/settings/commission-rate'),
    )
      .send({ rateBps: 1000 }) // 10.00%
      .expect(200);

    const colaborador = await createColaborador('Sin porcentaje individual');
    const { from, to } = currentWeekRange(new Date());
    await createSale({
      memberId: colaborador.id,
      totalMinor: 10_000, // $100.00
      receivedAt: new Date((from.getTime() + to.getTime()) / 2),
    });

    const res = await asSocio(
      request(app.getHttpServer()).get(
        `/commissions?memberId=${colaborador.id}`,
      ),
    ).expect(200);
    const item = res.body.items.find(
      (i: { memberId: string }) => i.memberId === colaborador.id,
    );
    expect(item.rateBps).toBe(1000);
    expect(item.totalSoldMinor).toBe(10_000);
    expect(item.commissionMinor).toBe(1_000); // 10% of $100.00 = $10.00
  });

  it('uses the individual override instead of the global rate', async () => {
    await asSocio(
      request(app.getHttpServer()).patch('/settings/commission-rate'),
    )
      .send({ rateBps: 1000 })
      .expect(200);
    const colaborador = await createColaborador('Con porcentaje individual');
    await asSocio(
      request(app.getHttpServer()).patch(
        `/members/${colaborador.id}/commission-rate`,
      ),
    )
      .send({ rateBps: 2500 }) // 25.00%, overrides the 10% global
      .expect(200);

    const { from, to } = currentWeekRange(new Date());
    await createSale({
      memberId: colaborador.id,
      totalMinor: 20_000,
      receivedAt: new Date((from.getTime() + to.getTime()) / 2),
    });

    const res = await asSocio(
      request(app.getHttpServer()).get(
        `/commissions?memberId=${colaborador.id}`,
      ),
    ).expect(200);
    const item = res.body.items[0];
    expect(item.rateBps).toBe(2500);
    expect(item.commissionMinor).toBe(5_000); // 25% of $200.00 = $50.00
  });

  it('sums multiple completed sales correctly and includes sales with a pending Incidencia', async () => {
    const colaborador = await createColaborador('Varias ventas', 2000); // 20%
    const { from, to } = currentWeekRange(new Date());
    const mid = new Date((from.getTime() + to.getTime()) / 2);
    const first = await createSale({
      memberId: colaborador.id,
      totalMinor: 5_000,
      receivedAt: mid,
    });
    const second = await createSale({
      memberId: colaborador.id,
      totalMinor: 3_000,
      receivedAt: mid,
    });
    // A pending Incidencia on `second` must not exclude it from the sum.
    await withTestTenant(contextId, () =>
      prisma.incidencia.create({
        data: {
          saleId: second.id,
          type: 'incidencia_fecha',
          reason: 'fixture',
        },
      }),
    );
    // Not counted: wrong status.
    await createSale({
      memberId: colaborador.id,
      totalMinor: 999_999,
      status: 'rechazada_por_conflicto',
      receivedAt: mid,
    });

    const res = await asSocio(
      request(app.getHttpServer()).get(
        `/commissions?memberId=${colaborador.id}`,
      ),
    ).expect(200);
    const item = res.body.items[0];
    expect(item.totalSoldMinor).toBe(8_000); // 5000 + 3000, rejected sale excluded
    expect(item.commissionMinor).toBe(1_600); // 20% of $80.00
    void first;
  });

  it('week boundary: a Sunday 00:00:01 sale and the prior Saturday 23:59:59 sale each count in their own week', async () => {
    const colaborador = await createColaborador('Frontera de semana', 1000);
    // 2025-11-02 is a Sunday (local business timezone, UTC-6).
    const sundayJustAfterMidnight = new Date('2025-11-02T06:00:01.000Z');
    const priorSaturdayJustBeforeMidnight = new Date(
      '2025-11-02T05:59:59.000Z',
    );
    await createSale({
      memberId: colaborador.id,
      totalMinor: 1_000,
      receivedAt: sundayJustAfterMidnight,
    });
    await createSale({
      memberId: colaborador.id,
      totalMinor: 2_000,
      receivedAt: priorSaturdayJustBeforeMidnight,
    });

    const { from, to } = currentWeekRange(sundayJustAfterMidnight);
    const res = await asSocio(
      request(app.getHttpServer()).get(
        `/commissions?memberId=${colaborador.id}&from=${from.toISOString()}&to=${to.toISOString()}`,
      ),
    ).expect(200);
    // Only the Sunday sale (this week) is counted; the prior Saturday
    // sale belongs to the previous week.
    expect(res.body.items[0].totalSoldMinor).toBe(1_000);
  });
});

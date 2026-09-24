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
});

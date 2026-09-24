import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { withTestTenant } from './tenant-scope.js';

/**
 * BE-07 Part 2: the Incidencia entity's own endpoints (list/detail/resolve),
 * restricted to socios.
 */
describe('incidencias (BE-07 part 2)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let socioToken: string;
  let colaboradorToken: string;
  let socioMemberId: string;
  let colaboradorMemberId: string;
  let deviceId: string;
  const contextId = `be07-part2-${randomUUID()}`;

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
  const createProduct = (data: {
    name: string;
    tipo: 'unica' | 'cantidad';
    unitPriceMinor: number;
    stock: number;
  }) =>
    withTestTenant(contextId, () =>
      prisma.product.create({
        data: {
          name: data.name,
          tipo: data.tipo,
          unitPriceMinor: data.unitPriceMinor,
          initialStock: data.stock,
          stock: data.stock,
          contextId,
        },
      }),
    );

  // Fixture Incidencia rows are created directly against Prisma (not by
  // driving SalesService through a real stock race), since this suite is
  // exercising the Incidencia endpoints themselves, not how an Incidencia
  // gets created in the first place (covered in sales-be07-part1.e2e-spec).
  const createIncidencia = async (
    type: 'conflicto_stock' | 'incidencia_fecha',
    sellingMemberId: string,
  ) => {
    const product = await createProduct({
      name: `Incidencia fixture ${randomUUID()}`,
      tipo: 'cantidad',
      unitPriceMinor: 100,
      stock: 5,
    });
    return withTestTenant(contextId, async () => {
      const sale = await prisma.sale.create({
        data: {
          id: randomUUID(),
          memberId: sellingMemberId,
          deviceId,
          occurredAt: new Date(),
          currency: 'MXN',
          status: 'completada',
          totalMinor: 100,
          cashReceivedMinor: 100,
          changeMinor: 0,
          items: {
            // Nested relation writes are not seen by the tenant extension (BE-11),
            // so the item's contextId is set by hand.
            create: {
              contextId,
              productId: product.id,
              quantity: 1,
              unitPriceMinor: 100,
              subtotalMinor: 100,
            },
          },
        },
      });
      return prisma.incidencia.create({
        data: { saleId: sale.id, type, reason: 'fixture reason' },
      });
    });
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
            name: 'BE07 part2 tablet',
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

  it('rejects a colaborador attempting to resolve an incidencia with 403', async () => {
    const incidencia = await createIncidencia('conflicto_stock', socioMemberId);
    await asColaborador(
      request(app.getHttpServer()).patch(`/incidencias/${incidencia.id}/resolver`),
    )
      .send({ resolutionNotes: 'no debería poder' })
      .expect(403);
  });

  it('lets a socio resolve a pending incidencia, then rejects a second resolve with 409', async () => {
    const incidencia = await createIncidencia('incidencia_fecha', socioMemberId);
    const res = await asSocio(
      request(app.getHttpServer()).patch(`/incidencias/${incidencia.id}/resolver`),
    )
      .send({ resolutionNotes: 'Se acordó reembolso parcial con el cliente' })
      .expect(200);
    expect(res.body.resolutionStatus).toBe('resuelta');
    expect(res.body.resolvedByMemberId).toBe(socioMemberId);
    expect(res.body.resolvedAt).toBeTruthy();

    await asSocio(
      request(app.getHttpServer()).patch(`/incidencias/${incidencia.id}/resolver`),
    )
      .send({ resolutionNotes: 'segundo intento' })
      .expect(409);
  });

  it('lists incidencias with pagination, search by selling member name, and date ordering', async () => {
    const searchableMember = (
      await withTestTenant(contextId, () =>
        prisma.member.create({
          data: {
            name: 'Buscable Vendedor Unico',
            role: 'colaborador',
            contextId,
          },
        }),
      )
    ).id;
    const first = await createIncidencia('conflicto_stock', searchableMember);
    await new Promise((r) => setTimeout(r, 5));
    const second = await createIncidencia('conflicto_stock', searchableMember);

    const res = await asSocio(
      request(app.getHttpServer()).get(
        '/incidencias?search=Buscable%20Vendedor&sort=desc&page=1&limit=10',
      ),
    ).expect(200);
    expect(res.body.page).toBe(1);
    expect(res.body.limit).toBe(10);
    const ids = (res.body.items as { id: string }[]).map((i) => i.id);
    expect(ids).toContain(first.id);
    expect(ids).toContain(second.id);
    // desc order: the most recently detected incidencia comes first.
    expect(ids.indexOf(second.id)).toBeLessThan(ids.indexOf(first.id));
  });

  it('returns full detail with the related sale via GET /incidencias/:id', async () => {
    const incidencia = await createIncidencia('conflicto_stock', socioMemberId);
    const res = await asSocio(
      request(app.getHttpServer()).get(`/incidencias/${incidencia.id}`),
    ).expect(200);
    expect(res.body.id).toBe(incidencia.id);
    expect(res.body.sale).toBeTruthy();
    expect(res.body.sale.id).toBe(incidencia.saleId);
    expect(res.body.sale.items).toBeInstanceOf(Array);
  });
});

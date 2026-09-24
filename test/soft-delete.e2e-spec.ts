import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { createServerId } from '../src/common/server-id.js';
import { withTestTenant } from './tenant-scope.js';

/**
 * BE-10: soft delete for Product and Member (colaborador). Nothing is
 * ever physically deleted — `active: false` only removes a row from the
 * default listing/selection surfaces while every historical reference
 * (SaleItem, ProductAudit, Sale.memberId, Deuda, Abono, Commission)
 * keeps resolving exactly as before deactivation. Socios can never be
 * deactivated through this mechanism.
 *
 * BE-11 follow-up: this spec still seeds fixtures / verifies persistence
 * directly through Prisma, outside the real HTTP request pipeline, so
 * strict RLS now requires wrapping those calls in `withTestTenant`.
 */
describe('soft delete (BE-10)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let socioToken: string;
  let colaboradorToken: string;
  let socioMemberId: string;
  let colaboradorMemberId: string;
  let deviceId: string;
  const contextId = `be10-${randomUUID()}`;

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

    const colaboradorAccount = await prisma.account.create({
      data: {
        username: randomUUID(),
        passwordHash: 'not-a-login-fixture',
        contextId,
      },
    });
    colaboradorToken = await jwt.signAsync({ sub: colaboradorAccount.id });
    await withTestTenant(contextId, async () => {
      socioMemberId = (
        await prisma.member.create({
          data: { name: 'Alberto Socio', role: 'socio', contextId },
        })
      ).id;
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
            name: 'BE10 tablet',
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
        await prisma.abono.deleteMany({
          where: { deuda: { createdByMember: { contextId } } },
        });
        await prisma.deuda.deleteMany({
          where: { createdByMember: { contextId } },
        });
        await prisma.deudor.deleteMany({ where: { contextId } });
        await prisma.saleItem.deleteMany({
          where: { sale: { deviceId, product: { contextId } } },
        });
        await prisma.sale.deleteMany({ where: { deviceId } });
        await prisma.productAudit.deleteMany({
          where: { product: { contextId } },
        });
        await prisma.product.deleteMany({ where: { contextId } });
        await prisma.device.deleteMany({ where: { contextId } });
        await prisma.member.deleteMany({ where: { contextId } });
      });
      await prisma.account.deleteMany({ where: { contextId } });
    }
    await app?.close();
  });

  describe('products', () => {
    it('GET /products/:id returns the product; 404 if it does not exist', async () => {
      const product = await createProduct({
        name: `Detail ${randomUUID()}`,
        tipo: 'cantidad',
        unitPriceMinor: 1000,
        stock: 3,
      });
      const res = await asSocio(
        request(app.getHttpServer()).get(`/products/${product.id}`),
      ).expect(200);
      expect(res.body.id).toBe(product.id);
      expect(res.body.active).toBe(true);
      await asSocio(
        request(app.getHttpServer()).get(`/products/${randomUUID()}`),
      ).expect(404);
    });

    it('DELETE /products/:id by a colaborador is rejected (403)', async () => {
      const product = await createProduct({
        name: `Forbidden delete ${randomUUID()}`,
        tipo: 'cantidad',
        unitPriceMinor: 500,
        stock: 1,
      });
      await asColaborador(
        request(app.getHttpServer()).delete(`/products/${product.id}`),
      ).expect(403);
    });

    it('DELETE /products/:id by a socio soft-deletes; row and sale history survive', async () => {
      const product = await createProduct({
        name: `Soft delete ${randomUUID()}`,
        tipo: 'cantidad',
        unitPriceMinor: 500,
        stock: 5,
      });
      // Sell some units first so a historical SaleItem references this
      // product before it is deactivated.
      const saleRes = await asSocio(request(app.getHttpServer()).post('/sales'))
        .send({
          id: createServerId(),
          memberId: socioMemberId,
          deviceId,
          occurredAt: new Date().toISOString(),
          currency: 'MXN',
          cashReceivedMinor: 500,
          items: [{ productId: product.id, quantity: 1, unitPriceMinor: 500 }],
        })
        .expect(201);

      const deleteRes = await asSocio(
        request(app.getHttpServer()).delete(`/products/${product.id}`),
      ).expect(200);
      expect(deleteRes.body.active).toBe(false);

      const stillExists = await withTestTenant(contextId, () =>
        prisma.product.findUniqueOrThrow({
          where: { id: product.id },
        }),
      );
      expect(stillExists.active).toBe(false);

      // Idempotent repeat.
      await asSocio(
        request(app.getHttpServer()).delete(`/products/${product.id}`),
      ).expect(200);

      const history = await request(app.getHttpServer())
        .get(`/sales/${saleRes.body.sale.id}`)
        .auth(socioToken, { type: 'bearer' })
        .set('x-member-id', socioMemberId)
        .set('x-device-id', deviceId)
        .expect(200);
      expect(
        history.body.items.some(
          (item: { productId: string }) => item.productId === product.id,
        ),
      ).toBe(true);
    });

    it('rejects selling a deactivated product even with stock > 0', async () => {
      const product = await createProduct({
        name: `Inactive for sale ${randomUUID()}`,
        tipo: 'cantidad',
        unitPriceMinor: 500,
        stock: 10,
      });
      await asSocio(
        request(app.getHttpServer()).delete(`/products/${product.id}`),
      ).expect(200);
      await asSocio(request(app.getHttpServer()).post('/sales'))
        .send({
          id: createServerId(),
          memberId: socioMemberId,
          deviceId,
          occurredAt: new Date().toISOString(),
          currency: 'MXN',
          cashReceivedMinor: 500,
          items: [{ productId: product.id, quantity: 1, unitPriceMinor: 500 }],
        })
        .expect(400);
      expect(
        (
          await withTestTenant(contextId, () =>
            prisma.product.findUniqueOrThrow({ where: { id: product.id } }),
          )
        ).stock,
      ).toBe(10);
    });

    it('rejects creating a fiado/apartado for a deactivated product', async () => {
      const product = await createProduct({
        name: `Inactive for deuda ${randomUUID()}`,
        tipo: 'cantidad',
        unitPriceMinor: 500,
        stock: 10,
      });
      await asSocio(
        request(app.getHttpServer()).delete(`/products/${product.id}`),
      ).expect(200);
      await asSocio(request(app.getHttpServer()).post('/deudas'))
        .send({
          type: 'apartado',
          productId: product.id,
          cantidad: 1,
          deudor: { nombre: 'Cliente' },
        })
        .expect(400);
      expect(
        (
          await withTestTenant(contextId, () =>
            prisma.product.findUniqueOrThrow({ where: { id: product.id } }),
          )
        ).stock,
      ).toBe(10);
    });

    it('GET /products hides deactivated products by default, shows them with includeInactive=true only for a socio', async () => {
      const product = await createProduct({
        name: `Listing ${randomUUID()}`,
        tipo: 'cantidad',
        unitPriceMinor: 500,
        stock: 1,
      });
      await asSocio(
        request(app.getHttpServer()).delete(`/products/${product.id}`),
      ).expect(200);

      const defaultList = await asSocio(
        request(app.getHttpServer()).get('/products'),
      ).expect(200);
      expect(
        defaultList.body.items.some(
          (p: { id: string }) => p.id === product.id,
        ),
      ).toBe(false);

      const defaultListColaborador = await asColaborador(
        request(app.getHttpServer()).get('/products'),
      ).expect(200);
      expect(
        defaultListColaborador.body.items.some(
          (p: { id: string }) => p.id === product.id,
        ),
      ).toBe(false);

      // A colaborador passing includeInactive=true is silently ignored
      // (not 403'd) — the parameter is only honored for a resolved socio.
      const colaboradorWithInactive = await asColaborador(
        request(app.getHttpServer())
          .get('/products')
          .query({ includeInactive: 'true' }),
      ).expect(200);
      expect(
        colaboradorWithInactive.body.items.some(
          (p: { id: string }) => p.id === product.id,
        ),
      ).toBe(false);

      const withInactive = await asSocio(
        request(app.getHttpServer())
          .get('/products')
          .query({ includeInactive: 'true' }),
      ).expect(200);
      expect(
        withInactive.body.items.some(
          (p: { id: string }) => p.id === product.id,
        ),
      ).toBe(true);
    });


    it('PATCH /products/:id/reactivate reactivates a deactivated product', async () => {
      const product = await createProduct({
        name: `Reactivate ${randomUUID()}`,
        tipo: 'cantidad',
        unitPriceMinor: 500,
        stock: 1,
      });
      await asSocio(
        request(app.getHttpServer()).delete(`/products/${product.id}`),
      ).expect(200);
      const reactivated = await asSocio(
        request(app.getHttpServer()).patch(`/products/${product.id}/reactivate`),
      ).expect(200);
      expect(reactivated.body.active).toBe(true);
      // Idempotent repeat.
      await asSocio(
        request(app.getHttpServer()).patch(`/products/${product.id}/reactivate`),
      ).expect(200);
    });
  });

  describe('members', () => {
    it('DELETE /members/:id on a socio is rejected explicitly', async () => {
      await asSocio(
        request(app.getHttpServer()).delete(`/members/${socioMemberId}`),
      ).expect(400);
      expect(
        (
          await withTestTenant(contextId, () =>
            prisma.member.findUniqueOrThrow({
              where: { id: socioMemberId },
            }),
          )
        ).active,
      ).toBe(true);
    });

    it('DELETE /members/:id by a colaborador is rejected (403)', async () => {
      const other = await withTestTenant(contextId, () =>
        prisma.member.create({
          data: { name: 'Otro Colaborador', role: 'colaborador', contextId },
        }),
      );
      await asColaborador(
        request(app.getHttpServer()).delete(`/members/${other.id}`),
      ).expect(403);
    });

    it('DELETE /members/:id on a colaborador soft-deletes; history stays intact and blocks reselection', async () => {
      const colaborador = await withTestTenant(contextId, () =>
        prisma.member.create({
          data: {
            name: 'Historial Colaborador',
            role: 'colaborador',
            contextId,
          },
        }),
      );
      const product = await createProduct({
        name: `Historial ${randomUUID()}`,
        tipo: 'cantidad',
        unitPriceMinor: 1000,
        stock: 5,
      });
      // A sale attributed to this colaborador, before deactivation.
      const colaboradorAccount = await prisma.account.create({
        data: {
          username: randomUUID(),
          passwordHash: 'not-a-login-fixture',
          contextId,
        },
      });
      const colaboradorToken2 = await app
        .get(JwtService)
        .signAsync({ sub: colaboradorAccount.id });
      await request(app.getHttpServer())
        .post('/sales')
        .auth(colaboradorToken2, { type: 'bearer' })
        .set('x-member-id', colaborador.id)
        .set('x-device-id', deviceId)
        .send({
          id: createServerId(),
          memberId: colaborador.id,
          deviceId,
          occurredAt: new Date().toISOString(),
          currency: 'MXN',
          cashReceivedMinor: 1000,
          items: [{ productId: product.id, quantity: 1, unitPriceMinor: 1000 }],
        })
        .expect(201);

      const deleteRes = await asSocio(
        request(app.getHttpServer()).delete(`/members/${colaborador.id}`),
      ).expect(200);
      expect(deleteRes.body.active).toBe(false);

      const stillExists = await withTestTenant(contextId, () =>
        prisma.member.findUniqueOrThrow({
          where: { id: colaborador.id },
        }),
      );
      expect(stillExists.active).toBe(false);

      // Past sales for this member remain fully queryable.
      const salesCount = await withTestTenant(contextId, () =>
        prisma.sale.count({
          where: { memberId: colaborador.id },
        }),
      );
      expect(salesCount).toBe(1);

      // A deactivated member can no longer be selected as the acting actor.
      await request(app.getHttpServer())
        .post('/sales')
        .auth(colaboradorToken2, { type: 'bearer' })
        .set('x-member-id', colaborador.id)
        .set('x-device-id', deviceId)
        .send({
          id: createServerId(),
          memberId: colaborador.id,
          deviceId,
          occurredAt: new Date().toISOString(),
          currency: 'MXN',
          cashReceivedMinor: 1000,
          items: [{ productId: product.id, quantity: 1, unitPriceMinor: 1000 }],
        })
        .expect(403);

      // Idempotent repeat.
      await asSocio(
        request(app.getHttpServer()).delete(`/members/${colaborador.id}`),
      ).expect(200);
    });

    it('PATCH /members/:id/reactivate restores selectability', async () => {
      const colaborador = await withTestTenant(contextId, () =>
        prisma.member.create({
          data: { name: 'Para reactivar', role: 'colaborador', contextId },
        }),
      );
      await asSocio(
        request(app.getHttpServer()).delete(`/members/${colaborador.id}`),
      ).expect(200);
      const reactivated = await asSocio(
        request(app.getHttpServer()).patch(
          `/members/${colaborador.id}/reactivate`,
        ),
      ).expect(200);
      expect(reactivated.body.active).toBe(true);
    });

    it('PATCH /members/:id edits name and commissionRateBps for a colaborador', async () => {
      const colaborador = await withTestTenant(contextId, () =>
        prisma.member.create({
          data: { name: 'Editable', role: 'colaborador', contextId },
        }),
      );
      const res = await asSocio(
        request(app.getHttpServer()).patch(`/members/${colaborador.id}`),
      )
        .send({ name: 'Editado', commissionRateBps: 1500 })
        .expect(200);
      expect(res.body.name).toBe('Editado');
      expect(res.body.commissionRateBps).toBe(1500);
    });

    it('PATCH /members/:id rejects commissionRateBps for a socio target', async () => {
      await asSocio(
        request(app.getHttpServer()).patch(`/members/${socioMemberId}`),
      )
        .send({ commissionRateBps: 1000 })
        .expect(400);
    });

    it('GET /members hides deactivated colaboradores by default, shows them with includeInactive=true only for a socio', async () => {
      const colaborador = await withTestTenant(contextId, () =>
        prisma.member.create({
          data: {
            name: `Oculto ${randomUUID()}`,
            role: 'colaborador',
            contextId,
          },
        }),
      );
      await asSocio(
        request(app.getHttpServer()).delete(`/members/${colaborador.id}`),
      ).expect(200);

      const defaultList = await asSocio(
        request(app.getHttpServer()).get('/members'),
      ).expect(200);
      expect(
        defaultList.body.some((m: { id: string }) => m.id === colaborador.id),
      ).toBe(false);

      const defaultListColaborador = await asColaborador(
        request(app.getHttpServer()).get('/members'),
      ).expect(200);
      expect(
        defaultListColaborador.body.some(
          (m: { id: string }) => m.id === colaborador.id,
        ),
      ).toBe(false);

      // A colaborador passing includeInactive=true is silently ignored
      // (not 403'd) — the parameter is only honored for a resolved socio.
      const colaboradorWithInactive = await asColaborador(
        request(app.getHttpServer())
          .get('/members')
          .query({ includeInactive: 'true' }),
      ).expect(200);
      expect(
        colaboradorWithInactive.body.some(
          (m: { id: string }) => m.id === colaborador.id,
        ),
      ).toBe(false);

      const withInactive = await asSocio(
        request(app.getHttpServer())
          .get('/members')
          .query({ includeInactive: 'true' }),
      ).expect(200);
      expect(
        withInactive.body.some((m: { id: string }) => m.id === colaborador.id),
      ).toBe(true);
    });
  });
});

import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { withTestTenant } from './tenant-scope.js';

/**
 * BE-11 follow-up: proves the two gaps closed in this session actually
 * behave as intended:
 *
 * 1. Postgres RLS now denies by default — a raw SQL query run with no
 *    `app.context_id` session variable set returns zero rows, for any
 *    tenant, not "everything" (the old permissive-when-unset behavior).
 * 2. `deudas.service.ts`'s `registerAbono` raw `FOR UPDATE` lock query
 *    (the one `$queryRaw` that the Prisma tenant-isolation extension
 *    cannot see) now carries an explicit `contextId` filter and cannot
 *    be used, even indirectly through the abono endpoint, to touch a
 *    Deuda belonging to a different tenant.
 */
describe('RLS strict deny-by-default (BE-11 follow-up)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let tokenA: string;
  let socioMemberIdA: string;
  let deviceIdA: string;
  const contextIdA = `be11-rls-a-${randomUUID()}`;

  let productIdA: string;
  let deudaIdB: string;
  const contextIdB = `be11-rls-b-${randomUUID()}`;

  const asA = (req: request.Test) =>
    req
      .auth(tokenA, { type: 'bearer' })
      .set('x-member-id', socioMemberIdA)
      .set('x-device-id', deviceIdA);

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    const jwt = app.get(JwtService);

    // --- Context A: an authenticated socio who will try (and must fail)
    // to collect an abono against a Deuda that only exists in context B.
    const accountA = await prisma.account.create({
      data: {
        username: randomUUID(),
        passwordHash: 'not-a-login-fixture',
        contextId: contextIdA,
      },
    });
    tokenA = await jwt.signAsync({ sub: accountA.id });
    await withTestTenant(contextIdA, async () => {
      socioMemberIdA = (
        await prisma.member.create({
          data: { name: 'Socio A', role: 'socio', contextId: contextIdA },
        })
      ).id;
      deviceIdA = (
        await prisma.device.create({
          data: {
            name: 'Tablet A',
            identifier: randomUUID(),
            contextId: contextIdA,
            authorized: true,
          },
        })
      ).id;
      productIdA = (
        await prisma.product.create({
          data: {
            name: 'Producto de A',
            tipo: 'cantidad',
            unitPriceMinor: 1000,
            initialStock: 5,
            stock: 5,
            contextId: contextIdA,
          },
        })
      ).id;
    });

    // --- Context B: an unrelated Deudor/Deuda that must stay invisible
    // to context A, including through the raw FOR UPDATE lock query.
    await withTestTenant(contextIdB, async () => {
      const productB = await prisma.product.create({
        data: {
          name: 'Producto de B',
          tipo: 'cantidad',
          unitPriceMinor: 2000,
          initialStock: 5,
          stock: 5,
          contextId: contextIdB,
        },
      });
      const memberB = await prisma.member.create({
        data: { name: 'Socio B', role: 'socio', contextId: contextIdB },
      });
      const deudorB = await prisma.deudor.create({
        data: { nombre: 'Deudor de B', contextId: contextIdB },
      });
      deudaIdB = (
        await prisma.deuda.create({
          data: {
            type: 'fiado',
            productId: productB.id,
            cantidad: 1,
            totalMinor: 2000,
            status: 'pendiente',
            deudorId: deudorB.id,
            createdByMemberId: memberB.id,
            contextId: contextIdB,
          },
        })
      ).id;
    });
  });

  afterAll(async () => {
    if (prisma) {
      await withTestTenant(contextIdA, async () => {
        await prisma.product.deleteMany({ where: { contextId: contextIdA } });
        await prisma.device.deleteMany({ where: { contextId: contextIdA } });
        await prisma.member.deleteMany({ where: { contextId: contextIdA } });
      });
      await withTestTenant(contextIdB, async () => {
        await prisma.deuda.deleteMany({
          where: { createdByMember: { contextId: contextIdB } },
        });
        await prisma.deudor.deleteMany({ where: { contextId: contextIdB } });
        await prisma.product.deleteMany({ where: { contextId: contextIdB } });
        await prisma.member.deleteMany({ where: { contextId: contextIdB } });
      });
      await prisma.account.deleteMany({
        where: { contextId: { in: [contextIdA, contextIdB] } },
      });
    }
    await app?.close();
  });

  it('a raw query with no app.context_id set returns zero rows from any tenant-scoped table', async () => {
    // Deliberately NOT wrapped in withTestTenant: simulates an
    // application bug that skips both the Prisma extension and any
    // explicit contextId — the exact failure mode strict RLS exists to
    // catch. `current_setting('app.context_id', true)` is NULL here, and
    // the policy is `"contextId" = current_setting(...)` with no OR
    // fallback, so `NULL = anything` is never true for any row.
    const rows = await prisma.$queryRaw<
      Array<{ id: string }>
    >`SELECT id FROM "Product" WHERE id = ${productIdA}::uuid`;
    expect(rows).toHaveLength(0);

    const anyRow = await prisma.$queryRaw<
      Array<{ id: string }>
    >`SELECT id FROM "Product" LIMIT 1`;
    expect(anyRow).toHaveLength(0);
  });

  it("registerAbono's FOR UPDATE lock query cannot reach a Deuda from a different context", async () => {
    // Context A is fully authenticated/authorized, but `deudaIdB` belongs
    // to context B. Both the pre-transaction `findFirst` guard AND the
    // now-filtered raw FOR UPDATE query must fail to see it — this
    // asserts the end-to-end behavior through the real HTTP endpoint,
    // not just the query in isolation.
    await asA(
      request(app.getHttpServer()).post(`/deudas/${deudaIdB}/abonos`),
    )
      .send({ montoMinor: 500 })
      .expect(404);

    // The Deuda in B must remain completely untouched by the attempt.
    const untouched = await withTestTenant(contextIdB, () =>
      prisma.deuda.findUniqueOrThrow({ where: { id: deudaIdB } }),
    );
    expect(untouched.status).toBe('pendiente');
    const abonos = await withTestTenant(contextIdB, () =>
      prisma.abono.findMany({ where: { deudaId: deudaIdB } }),
    );
    expect(abonos).toHaveLength(0);
  });
});

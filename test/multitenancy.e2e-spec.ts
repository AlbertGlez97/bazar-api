import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/database/prisma.service.js';

/**
 * BE-11: two independent businesses (contextId A and B) must never see
 * each other's data, over the real HTTP surface (as opposed to the
 * Prisma-level tests, which would only prove the extension itself
 * works, not that every layer above it — controllers, guards — actually
 * uses it correctly end to end).
 *
 * Fixtures are still created via `prisma.model.create(...)` directly
 * (matching every other e2e spec's established pattern, e.g.
 * soft-delete.e2e-spec.ts), which runs with no AsyncLocalStorage scope
 * open at all and is therefore treated as trusted/administrative
 * passthrough by `resolveTenantAccess` (see
 * src/database/tenant-context.ts) — contextId must be passed explicitly
 * on every fixture `create`, exactly as before this entrega.
 */
describe('multi-tenancy isolation (BE-11)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let tokenA: string;
  let memberIdA: string;
  let deviceIdA: string;
  const contextIdA = `be11-a-${randomUUID()}`;

  let tokenB: string;
  let memberIdB: string;
  let deviceIdB: string;
  const contextIdB = `be11-b-${randomUUID()}`;

  const asA = (req: request.Test) =>
    req
      .auth(tokenA, { type: 'bearer' })
      .set('x-member-id', memberIdA)
      .set('x-device-id', deviceIdA);

  const asB = (req: request.Test) =>
    req
      .auth(tokenB, { type: 'bearer' })
      .set('x-member-id', memberIdB)
      .set('x-device-id', deviceIdB);

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    const jwt = app.get(JwtService);

    const accountA = await prisma.account.create({
      data: {
        username: randomUUID(),
        passwordHash: 'not-a-login-fixture',
        contextId: contextIdA,
      },
    });
    tokenA = await jwt.signAsync({ sub: accountA.id });
    memberIdA = (
      await prisma.member.create({
        data: { name: 'Socio A', role: 'socio', contextId: contextIdA },
      })
    ).id;
    deviceIdA = (
      await prisma.device.create({
        data: { name: 'Tablet A', contextId: contextIdA, authorized: true },
      })
    ).id;

    const accountB = await prisma.account.create({
      data: {
        username: randomUUID(),
        passwordHash: 'not-a-login-fixture',
        contextId: contextIdB,
      },
    });
    tokenB = await jwt.signAsync({ sub: accountB.id });
    memberIdB = (
      await prisma.member.create({
        data: { name: 'Socio B', role: 'socio', contextId: contextIdB },
      })
    ).id;
    deviceIdB = (
      await prisma.device.create({
        data: { name: 'Tablet B', contextId: contextIdB, authorized: true },
      })
    ).id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('does not leak a Product created in context A into context B listings or lookups', async () => {
    const created = await asA(request(app.getHttpServer()).post('/products'))
      .send({
        name: 'Bonsái exclusivo de A',
        tipo: 'unica',
        unitPriceMinor: 50000,
      })
      .expect(201);
    const productId = created.body.id as string;

    // Context B's listing must never include A's product.
    const listB = await asB(request(app.getHttpServer()).get('/products'))
      .expect(200);
    expect(
      listB.body.items.some((p: { id: string }) => p.id === productId),
    ).toBe(false);

    // Context B's direct lookup by id must behave as if it does not
    // exist at all (404), not leak a 200 with A's data.
    await asB(request(app.getHttpServer()).get(`/products/${productId}`)).expect(
      404,
    );

    // Context A can still see its own product, proving the isolation is
    // not simply "nobody can see anything".
    await asA(request(app.getHttpServer()).get(`/products/${productId}`)).expect(
      200,
    );
  });

  it('does not leak a Member created in context A into context B listings', async () => {
    const listB = await asB(request(app.getHttpServer()).get('/members'))
      .expect(200);
    expect(
      (listB.body as Array<{ id: string }>).some((m) => m.id === memberIdA),
    ).toBe(false);
  });

  it('does not let context B register a sale against a product that only exists in context A', async () => {
    const created = await asA(request(app.getHttpServer()).post('/products'))
      .send({
        name: 'Producto solo de A para venta',
        tipo: 'cantidad',
        unitPriceMinor: 1000,
        initialStock: 10,
      })
      .expect(201);
    const productId = created.body.id as string;

    await asB(request(app.getHttpServer()).post('/sales'))
      .send({
        id: randomUUID(),
        memberId: memberIdB,
        deviceId: deviceIdB,
        occurredAt: new Date().toISOString(),
        currency: 'MXN',
        cashReceivedMinor: 1000,
        items: [{ productId, quantity: 1, unitPriceMinor: 1000 }],
      })
      .expect(400);
  });
});

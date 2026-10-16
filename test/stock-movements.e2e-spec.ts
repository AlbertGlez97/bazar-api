import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { withTestTenant } from './tenant-scope.js';

/**
 * StockMovement data layer: multi-tenant isolation (Prisma extension + strict
 * RLS), the table's own constraints, and the append-only grant of the runtime
 * role. The HTTP behavior of restocking lives in products-restock.e2e-spec.ts.
 */
describe('StockMovement table', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const contextA = `sm-a-${randomUUID()}`;
  const contextB = `sm-b-${randomUUID()}`;
  let productA: string;
  let memberA: string;
  let productB: string;
  let memberB: string;
  let movementA: string;

  const fixtures = (contextId: string, name: string) =>
    withTestTenant(contextId, async () => {
      const member = await prisma.member.create({
        data: { name: `Socio ${name}`, role: 'socio', contextId },
      });
      const product = await prisma.product.create({
        data: {
          name: `Producto ${name}`,
          tipo: 'cantidad',
          unitPriceMinor: 1000,
          initialStock: 5,
          stock: 5,
          contextId,
        },
      });
      return { memberId: member.id, productId: product.id };
    });

  const movement = (
    contextId: string,
    productId: string,
    memberId: string,
    overrides: Record<string, unknown> = {},
  ) => ({
    id: randomUUID(),
    contextId,
    productId,
    memberId,
    type: 'REPOSICION' as const,
    quantity: 3,
    stockBefore: 5,
    stockAfter: 8,
    ...overrides,
  });

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    const a = await fixtures(contextA, 'A');
    productA = a.productId;
    memberA = a.memberId;
    const b = await fixtures(contextB, 'B');
    productB = b.productId;
    memberB = b.memberId;
    movementA = (
      await withTestTenant(contextA, () =>
        prisma.stockMovement.create({
          data: movement(contextA, productA, memberA, {
            unitCostMinor: 1200,
            note: 'Compra del sábado',
          }),
        }),
      )
    ).id;
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('multi-tenant isolation', () => {
    it('is a tenant-scoped model: the owner context reads its own movement', async () => {
      const own = await withTestTenant(contextA, () =>
        prisma.stockMovement.findMany({ where: { productId: productA } }),
      );

      expect(own.map((row) => row.id)).toEqual([movementA]);
      expect(own[0]).toMatchObject({
        contextId: contextA,
        type: 'REPOSICION',
        quantity: 3,
        stockBefore: 5,
        stockAfter: 8,
        unitCostMinor: 1200,
        note: 'Compra del sábado',
      });
    });

    it('another context sees none of it (findMany, count, findUnique)', async () => {
      const [rows, total, byId] = await withTestTenant(contextB, () =>
        Promise.all([
          prisma.stockMovement.findMany({}),
          prisma.stockMovement.count({ where: { productId: productA } }),
          prisma.stockMovement.findUnique({ where: { id: movementA } }),
        ]),
      );

      expect(rows.map((row) => row.id)).not.toContain(movementA);
      expect(total).toBe(0);
      expect(byId).toBeNull();
    });

    it('the application filter wins over a contextId passed by hand', async () => {
      const rows = await withTestTenant(contextB, () =>
        prisma.stockMovement.findMany({ where: { contextId: contextA } }),
      );

      expect(rows).toEqual([]);
    });

    it('RLS denies by default: a query with no tenant set sees nothing', async () => {
      // Deliberately outside withTestTenant: simulates an application bug that
      // skips the Prisma extension. The row exists, but the policy hides it.
      const rows = await prisma.$queryRaw<
        Array<{ id: string }>
      >`SELECT id FROM "StockMovement" WHERE id = ${movementA}::uuid`;

      expect(rows).toHaveLength(0);
    });

    it('RLS (WITH CHECK) rejects writing a row for another context', async () => {
      // Raw insert inside A's scope but naming B's context: the extension
      // cannot see raw SQL, so only the Postgres policy stands in the way.
      const attempt = withTestTenant(contextA, () =>
        prisma.$transaction((tx) =>
          tx.$executeRaw`INSERT INTO "StockMovement" ("id", "contextId", "productId", "memberId", "type", "quantity", "stockBefore", "stockAfter")
            VALUES (${randomUUID()}::uuid, ${contextB}, ${productB}::uuid, ${memberB}::uuid, 'REPOSICION', 1, 5, 6)`,
        ),
      );

      await expect(attempt).rejects.toThrow(/row-level security|violates/i);
    });
  });

  describe('constraints', () => {
    const insert = (overrides: Record<string, unknown>) =>
      withTestTenant(contextA, () =>
        prisma.stockMovement.create({
          data: movement(contextA, productA, memberA, overrides),
        }),
      );

    it.each([
      ['a quantity of 0', { quantity: 0, stockAfter: 5 }],
      ['a negative quantity', { quantity: -1, stockAfter: 4 }],
      ['stockAfter that is not stockBefore + quantity', { stockAfter: 9 }],
      ['a negative stockBefore', { stockBefore: -1, stockAfter: 2 }],
      ['a negative unit cost', { unitCostMinor: -1 }],
      ['a note over 1000 characters', { note: 'x'.repeat(1001) }],
    ])('rejects %s', async (_label, overrides) => {
      await expect(insert(overrides)).rejects.toThrow();
    });

    it('accepts an empty unit cost, an empty note and a unit cost of 0', async () => {
      await expect(insert({})).resolves.toMatchObject({ unitCostMinor: null, note: null });
      await expect(insert({ unitCostMinor: 0 })).resolves.toMatchObject({ unitCostMinor: 0 });
    });

    it('does not let the product be deleted while it has movements', async () => {
      await expect(
        withTestTenant(contextA, () => prisma.product.delete({ where: { id: productA } })),
      ).rejects.toThrow();
    });
  });

  describe('append-only: the runtime role cannot rewrite history', () => {
    const run = (statement: 'UPDATE' | 'DELETE') =>
      withTestTenant(contextA, () =>
        prisma.$transaction((tx) =>
          statement === 'UPDATE'
            ? tx.$executeRaw`UPDATE "StockMovement" SET "quantity" = 99, "stockAfter" = "stockBefore" + 99 WHERE id = ${movementA}::uuid`
            : tx.$executeRaw`DELETE FROM "StockMovement" WHERE id = ${movementA}::uuid`,
        ),
      );

    it.each(['UPDATE', 'DELETE'] as const)('%s is denied', async (statement) => {
      await expect(run(statement)).rejects.toThrow(/permission denied/i);
    });

    it('the movement is unchanged afterwards', async () => {
      const row = await withTestTenant(contextA, () =>
        prisma.stockMovement.findUniqueOrThrow({ where: { id: movementA } }),
      );

      expect(row.quantity).toBe(3);
    });
  });
});

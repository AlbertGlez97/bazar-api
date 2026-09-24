import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/database/prisma.service.js';
import { tenantIsolationExtension } from '../src/database/tenant.extension.js';
import { withTestTenant } from './tenant-scope.js';

/**
 * Runs against the real test database: proves the tenant-isolation
 * extension's `$transaction` override does not recurse, sets
 * `app.context_id` inside the transaction, and that the transaction client
 * (and standalone calls promoted into their own transaction) still goes
 * through the app-layer tenant filter. Uses app-layer filtering only, so it
 * holds even on a BYPASSRLS connection role.
 */
describe('tenant isolation extension ($transaction)', () => {
  const base = new PrismaService();
  const prisma = tenantIsolationExtension(base) as unknown as PrismaService;
  const a = `tx-ext-a-${randomUUID()}`;
  const b = `tx-ext-b-${randomUUID()}`;
  beforeAll(async () => {
    await base.$connect();
    // Strict RLS applies to the runtime role: fixtures need a tenant scope.
    for (const c of [a, b])
      await withTestTenant(c, () =>
        prisma.member.create({ data: { name: `m-${c}`, role: 'socio', contextId: c } }),
      );
  });
  afterAll(async () => {
    for (const c of [a, b])
      await withTestTenant(c, () => prisma.member.deleteMany({ where: { contextId: c } }));
    await base.$disconnect();
  });
  it('scopes a standalone call to the active context', async () => {
    const rows = await withTestTenant(a, () => prisma.member.findMany({ where: { contextId: { in: [a, b] } } }));
    expect(rows.map((r) => r.contextId)).toEqual([a]);
  });
  it('sets app.context_id and scopes the tx client inside an interactive $transaction', async () => {
    const out = await withTestTenant(a, () =>
      prisma.$transaction(async (tx) => {
        const g = await tx.$queryRaw<{ v: string }[]>`SELECT current_setting('app.context_id', true) AS v`;
        const rows = await tx.member.findMany({ where: { contextId: { in: [a, b] } } });
        return { g: g[0].v, ctx: rows.map((r) => r.contextId) };
      }),
    );
    expect(out).toEqual({ g: a, ctx: [a] });
  });
  it('does not leak app.context_id to the pool after a standalone call', async () => {
    await withTestTenant(a, () => prisma.member.findMany({ where: { contextId: a } }));
    const g = await prisma.$queryRaw<{ v: string | null }[]>`SELECT current_setting('app.context_id', true) AS v`;
    expect(g[0].v ?? '').toBe('');
  });
  it('injects contextId into a standalone create', async () => {
    const m = await withTestTenant(b, () => prisma.member.create({ data: { name: 'x', role: 'socio' } as never }));
    expect(m.contextId).toBe(b);
    await withTestTenant(b, () => prisma.member.delete({ where: { id: m.id } }));
  });
});

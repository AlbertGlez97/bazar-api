import {
  runInFreshTenantScope,
  setActiveContextId,
} from '../src/database/tenant-context.js';

/**
 * BE-11: runs `fn` as if it were a real authenticated request scoped to
 * `contextId` — opens a fresh AsyncLocalStorage tenant scope (the same
 * one `TenantContextMiddleware` opens for every HTTP request) and
 * immediately populates it (the same call `AuthGuard` makes after
 * resolving an Account).
 *
 * Every e2e spec creates its fixtures by calling `prisma.model.create(...)`
 * directly on the injected `PrismaService`, completely outside any HTTP
 * request — with strict, deny-by-default Postgres RLS (no more
 * "permissive when `app.context_id` is unset" escape hatch), those calls
 * would otherwise be rejected by the database itself, exactly as they
 * would be for a real request that skipped authentication. Wrapping
 * fixture setup in `withTestTenant` makes the Prisma tenant-isolation
 * extension treat it exactly like a real request: it injects `contextId`
 * into `where`/`data` and transparently sets the `app.context_id`
 * session variable (via its standalone-call-to-transaction promotion) for
 * every call made inside `fn`, so no test needs to write raw
 * `set_config(...)` SQL by hand.
 *
 * Not a substitute for the real HTTP surface: routes are still only ever
 * called via `supertest`/`request(app.getHttpServer())`, which populate
 * their own tenant scope through the real guard chain. This helper exists
 * solely for the *fixture setup* half of each spec (and any assertion
 * that reads/writes a tenant-scoped model directly instead of through an
 * endpoint).
 */
export function withTestTenant<T>(
  contextId: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  return runInFreshTenantScope(async () => {
    setActiveContextId(contextId);
    return fn();
  });
}

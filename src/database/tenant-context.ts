import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * BE-11: per-request tenant identity, propagated implicitly through
 * `await`/promise chains via Node's `AsyncLocalStorage` rather than being
 * threaded as an explicit parameter through every guard/controller/
 * service/Prisma call. This is the same mechanism the mature
 * `nestjs-cls` package builds on; a hand-rolled version was chosen over
 * adding that dependency because the actual need here is narrow (one
 * mutable field, plus one internal flag to avoid double-wrapping
 * transactions — see {@link tenant.extension.ts}), and a small,
 * fully-owned implementation is easier to reason about/audit without
 * being able to run anything this session than an unfamiliar library's
 * exact CLS-in-guards interaction, which is the one subtle part of this
 * feature (see {@link TenantContextMiddleware}).
 *
 * A store instance exists for the whole lifetime of one HTTP request
 * (established by {@link TenantContextMiddleware}, which runs before any
 * guard) — `contextId` starts unset and is filled in once a guard
 * resolves the authenticated Account (see AuthGuard). Code that runs
 * *outside* any HTTP request at all (the standalone seed script, or
 * direct `prisma.model.create(...)` calls made straight from test setup
 * against the Nest-provided PrismaService instance, bypassing the app's
 * routing entirely) never has a store to begin with — see
 * {@link resolveTenantAccess} for why that case is deliberately treated
 * as unrestricted/administrative access rather than a missing-context
 * error.
 */
interface TenantStore {
  contextId?: string;
  // True only for the duration of a $transaction callback body opened by
  // PrismaService's tenant-aware $transaction override (or the
  // extension's own single-operation wrapper for a standalone call) —
  // lets the extension tell "already inside a transaction that already
  // set the RLS session variable" apart from "top-level call that still
  // needs one opened for it", without inspecting Prisma's internal
  // client/transaction objects at all.
  insideManagedTransaction: boolean;
}

const als = new AsyncLocalStorage<TenantStore>();

/** Establishes a fresh, empty per-request store; see {@link TenantContextMiddleware}. */
export function runInFreshTenantScope<T>(fn: () => T): T {
  return als.run({ contextId: undefined, insideManagedTransaction: false }, fn);
}

/**
 * Records the authenticated request's tenant. Called once, by AuthGuard,
 * right after it resolves an active Account — deliberately in AuthGuard
 * rather than the more narrowly-scoped ContextGuard, because several
 * endpoints that only require AuthGuard (`GET /products`, `GET /members`,
 * `POST /devices/identify`) still read/write tenant-scoped models and
 * would otherwise never have a contextId established for them.
 *
 * @throws Error if called outside a request that went through
 * {@link TenantContextMiddleware} (a programming error, not a request-time
 * condition — every route in this app is covered by that middleware).
 */
export function setActiveContextId(contextId: string): void {
  const store = als.getStore();
  if (!store)
    throw new Error(
      'setActiveContextId called without an active tenant request scope',
    );
  store.contextId = contextId;
}

/** `undefined` when no HTTP request is in flight, or none has set a tenant yet. */
export function getActiveContextIdOrUndefined(): string | undefined {
  return als.getStore()?.contextId;
}

/** Whether *any* request scope currently exists (see {@link resolveTenantAccess}). */
export function hasRequestScope(): boolean {
  return als.getStore() !== undefined;
}

export function isInsideManagedTransaction(): boolean {
  return als.getStore()?.insideManagedTransaction ?? false;
}

/**
 * Flags the current async chain as "already inside a managed
 * transaction" for the duration of `fn`, so nested tenant-scoped Prisma
 * calls made from within it are not each wrapped in their own extra
 * transaction. Restores the previous value afterwards (rather than
 * unconditionally clearing it) so this composes correctly if a managed
 * transaction is ever opened from inside another one.
 *
 * Falls back to just running `fn` unmodified when there is no request
 * scope at all (e.g. the seed script, or a test calling `$transaction`
 * directly on the injected client outside any HTTP request) — there is
 * nothing to flag, and nothing downstream depends on the flag in that
 * case either, since {@link resolveTenantAccess} already treats a missing
 * store as unrestricted access.
 */
export function withManagedTransactionFlag<T>(fn: () => T): T {
  const store = als.getStore();
  if (!store) return fn();
  const previous = store.insideManagedTransaction;
  store.insideManagedTransaction = true;
  try {
    return fn();
  } finally {
    store.insideManagedTransaction = previous;
  }
}

/**
 * The single authorization decision the tenant-isolation Prisma extension
 * makes for every operation on a tenant-scoped model, given whatever
 * explicit `contextId` (if any) the calling code already put in `where`/
 * `data`:
 *
 * - No request scope at all (`hasRequestScope()` false): this call did
 *   not come from serving an HTTP request — it is the seed script, or
 *   test/fixture code calling the injected PrismaService directly. Trust
 *   it completely, exactly like every model behaved before BE-11: return
 *   the explicit value if one was given (so a genuinely tenant-scoped
 *   `create` still gets a plausible value if a default is needed) or
 *   `undefined` for "do not touch this call's args at all".
 * - Inside a request whose contextId is already resolved (a guard ran):
 *   that value always wins, even over an explicit one some call site
 *   might additionally pass — an authenticated request must never be able
 *   to attribute/read data under a *different* tenant than the one it
 *   authenticated into, so nothing about how a service happens to call
 *   Prisma can override it.
 * - Inside a request with no contextId resolved yet, but the call
 *   supplied one explicitly: this is the business-registration approval
 *   bootstrap (a public endpoint, so no guard ever runs) creating the
 *   very first Member/AppSettings/etc. row of a brand-new tenant — there
 *   is nothing yet for a guard to have resolved, so the explicit value is
 *   the only legitimate source and is honored.
 * - Inside a request with neither: a genuine bug (a tenant-scoped model
 *   touched from a code path that skipped authentication) — fails
 *   closed, matching this feature's core requirement.
 */
export function resolveTenantAccess(
  model: string,
  operation: string,
  explicitContextId: string | undefined,
): { mode: 'passthrough' } | { mode: 'enforce'; contextId: string } {
  if (!hasRequestScope()) return { mode: 'passthrough' };
  const active = getActiveContextIdOrUndefined();
  if (active) return { mode: 'enforce', contextId: active };
  if (explicitContextId) return { mode: 'enforce', contextId: explicitContextId };
  throw new Error(
    `No tenant context established for ${model}.${operation}; refusing to run without one`,
  );
}

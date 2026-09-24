import { Prisma } from '../generated/prisma/client.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import {
  getActiveContextIdOrUndefined,
  isInsideManagedTransaction,
  resolveTenantAccess,
  withManagedTransactionFlag,
} from './tenant-context.js';

/**
 * Every model that belongs to a specific business/tenant. `Account` and
 * `BusinessRegistrationRequest` are deliberately excluded — see their own
 * doc comments (auth.guard.ts and schema.prisma respectively) for why
 * each one specifically cannot be scoped this way.
 */
const TENANT_SCOPED_MODELS = new Set([
  'Product',
  'ProductAudit',
  'Sale',
  'SaleItem',
  'Incidencia',
  'Deudor',
  'Deuda',
  'Abono',
  'AppSettings',
  'Member',
  'Device',
]);

const modelPropertyName = (model: string) =>
  model.charAt(0).toLowerCase() + model.slice(1);

// Operations whose `where` is where a scoped filter belongs. findUnique/
// findUniqueOrThrow are included deliberately: Prisma's generated
// `WhereUniqueInput` accepts additional non-unique scalar fields
// alongside the unique one, so `{ where: { id, contextId } }` is valid
// and still resolves by primary key, just with an extra guard condition —
// a well documented pattern for exactly this kind of tenant scoping.
const WHERE_OPERATIONS = new Set([
  'findMany',
  'findFirst',
  'findFirstOrThrow',
  'findUnique',
  'findUniqueOrThrow',
  'count',
  'aggregate',
  'groupBy',
  'update',
  'updateMany',
  'delete',
  'deleteMany',
  'upsert',
]);

function explicitContextId(operation: string, args: unknown): string | undefined {
  const a = (args ?? {}) as Record<string, unknown>;
  if (operation === 'create') return (a.data as Record<string, unknown> | undefined)?.contextId as string | undefined;
  if (operation === 'createMany') {
    const data = a.data;
    const first = Array.isArray(data) ? data[0] : data;
    return (first as Record<string, unknown> | undefined)?.contextId as string | undefined;
  }
  const where = a.where as Record<string, unknown> | undefined;
  return where?.contextId as string | undefined;
}

function injectArgs(operation: string, args: unknown, contextId: string): unknown {
  const a = (args ?? {}) as Record<string, unknown>;
  if (operation === 'create')
    return { ...a, data: { contextId, ...(a.data as object) } };
  if (operation === 'createMany') {
    const data = a.data;
    const rows = Array.isArray(data) ? data : [data];
    return {
      ...a,
      data: rows.map((row) => ({ contextId, ...(row as object) })),
    };
  }
  if (WHERE_OPERATIONS.has(operation)) {
    const where = { ...((a.where as object) ?? {}), contextId };
    const patched: Record<string, unknown> = { ...a, where };
    if (operation === 'upsert')
      patched.create = { contextId, ...((a.create as object) ?? {}) };
    return patched;
  }
  return a;
}

/**
 * Wraps a Prisma client with automatic tenant scoping for every operation
 * on {@link TENANT_SCOPED_MODELS}, so individual services do not need to
 * remember to pass `where: { contextId }`/`data: { contextId }` by hand
 * (existing services that still do are harmless — see
 * {@link injectArgs}, which simply overwrites/fills that field with the
 * same authoritative value).
 *
 * Two request shapes are handled differently:
 * - Called from inside a managed transaction (see
 *   `withManagedTransactionFlag`, set by {@link PrismaService}'s
 *   `$transaction` override): the RLS session variable for this
 *   connection was already set at the top of that transaction, so this
 *   just injects the app-layer filter and runs the query.
 * - Called standalone (a plain top-level `prisma.model.findMany(...)`
 *   outside any explicit `$transaction`): Postgres only reliably scopes
 *   `set_config(..., true)` (the `SET LOCAL`-equivalent, auto-reset)
 *   *within* a transaction — a bare autocommit statement has no
 *   transaction boundary to reset it at, and this app's connections are
 *   pooled, so leaving it set on a plain `SET` would leak the tenant into
 *   whatever the next pooled query happens to be. So a standalone call
 *   is transparently promoted into its own single-operation transaction
 *   (extra round trip, but correctness over a maybe-cached row here
 *   matters far more than one saved round trip for a shared-tablet POS
 *   at bazar scale) — see the doc comment on `PrismaService.$transaction`
 *   for the write-path half of this same mechanism.
 *
 * Nested relation writes (e.g. `Sale.create({ data: { items: { create:
 * [...] } } })`, which persists `SaleItem` rows) are NOT covered here:
 * Prisma Client Extensions only see the top-level model operation being
 * called, not payloads nested inside it for a *different* model — those
 * call sites set `contextId` by hand instead (see SalesService.create's
 * `items`/`incidencias` nested payloads).
 */
export function tenantIsolationExtension(baseClient: PrismaClient) {
  let self: unknown;
  const extended = baseClient.$extends({
    name: 'tenant-isolation',
    client: {
      // Overrides the callback form of $transaction used everywhere in
      // this codebase (`prisma.$transaction(async (tx) => {...})`).
      // The array form (`$transaction([...])`) has no current caller in
      // this codebase and is intentionally left unmodified/passed
      // through — it never opens an interactive transaction callback, so
      // there is no single point within it to run `set_config` first.
      $transaction(...args: unknown[]) {
        const ctx = Prisma.getExtensionContext(this) as unknown as PrismaClient;
        if (typeof args[0] !== 'function') return (ctx.$transaction as (...a: unknown[]) => unknown)(...args);
        const fn = args[0] as (tx: unknown) => unknown;
        const options = args[1];
        return ctx.$transaction(async (tx) => {
          const contextId = getActiveContextIdOrUndefined();
          if (contextId) {
            await tx.$executeRaw`SELECT set_config('app.context_id', ${contextId}, true)`;
          }
          return withManagedTransactionFlag(() => fn(tx));
        }, options as Prisma.TransactionOptions<unknown>);
      },
    },
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!model || !TENANT_SCOPED_MODELS.has(model)) return query(args);
          const access = resolveTenantAccess(
            model,
            operation,
            explicitContextId(operation, args),
          );
          if (access.mode === 'passthrough') return query(args);
          const patched = injectArgs(operation, args, access.contextId);
          if (isInsideManagedTransaction()) return query(patched);
          // Standalone call: promote to a single-operation managed
          // transaction (see doc comment above) and re-run the ORIGINAL
          // args — the recursive $allOperations invocation this triggers
          // will see `insideManagedTransaction === true` and inject
          // exactly once.
          return (self as PrismaClient).$transaction(async (tx) => {
            const delegate = (tx as unknown as Record<string, Record<string, (a: unknown) => unknown>>)[
              modelPropertyName(model)
            ];
            return delegate[operation](args);
          });
        },
      },
    },
  });
  self = extended;
  return extended;
}

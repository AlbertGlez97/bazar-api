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

// Prisma 7 no longer exports a named `TransactionOptions` type; this is the
// shape of the second `$transaction` parameter in the generated client.
interface TransactionOptions {
  maxWait?: number;
  timeout?: number;
  isolationLevel?: Prisma.TransactionIsolationLevel;
}

const modelPropertyName =(model: string) =>
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

// Generic so the patched args keep the exact type of the operation's own
// args (the extension's `query()` only accepts that type); the additions
// are structurally valid for every tenant-scoped model, which is not
// something the compiler can prove across the whole model/operation union.
function injectArgs<T>(operation: string, args: T, contextId: string): T {
  const a = (args ?? {}) as Record<string, unknown>;
  if (operation === 'create')
    return { ...a, data: { contextId, ...(a.data as object) } } as T;
  if (operation === 'createMany') {
    const data = a.data;
    const rows = Array.isArray(data) ? data : [data];
    return {
      ...a,
      data: rows.map((row) => ({ contextId, ...(row as object) })),
    } as T;
  }
  if (WHERE_OPERATIONS.has(operation)) {
    const where = { ...(a.where as object), contextId };
    const patched: Record<string, unknown> = { ...a, where };
    if (operation === 'upsert')
      patched.create = { contextId, ...(a.create as object) };
    return patched as T;
  }
  return a as T;
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
  // The real, un-overridden `$transaction` (see the override below).
  const rawTransaction = Reflect.get(baseClient, '$transaction') as (
    this: unknown,
    ...args: unknown[]
  ) => unknown;
  // Opens a real interactive transaction on `receiver` (the extended
  // client, so `tx` keeps the tenant query extension), sets the RLS
  // session variable as its first statement when a tenant is active, and
  // flags the callback's async chain as managed. Shared by the public
  // `$transaction` override and the standalone-call promotion below; the
  // latter deliberately does NOT go back through the public
  // `$transaction` property, so it stays an internal detail (and cannot
  // be intercepted by anything wrapping that public method).
  const runManagedTransaction = (
    receiver: unknown,
    fn: (tx: Prisma.TransactionClient) => Promise<unknown>,
    options?: TransactionOptions,
  ) =>
    rawTransaction.call(
      receiver,
      async (tx: Prisma.TransactionClient) => {
        const contextId = getActiveContextIdOrUndefined();
        if (contextId) {
          await tx.$executeRaw`SELECT set_config('app.context_id', ${contextId}, true)`;
        }
        return withManagedTransactionFlag(() => fn(tx));
      },
      options,
    );
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
      //
      // Root cause of the infinite recursion this used to have: the
      // override called `Prisma.getExtensionContext(this).$transaction`,
      // but the extension context IS the extended client, so that call
      // resolved to this very override again. The original
      // (un-overridden) implementation is therefore taken from the
      // unextended `baseClient`, and invoked with the extended client as
      // `this`: Prisma builds the interactive transaction client from the
      // receiver's extensions, so `tx` keeps going through the tenant
      // query extension below (calling it as `baseClient.$transaction(...)`
      // would yield a `tx` with no extension at all, i.e. no app-layer
      // filter on any nested call).
      $transaction(...args: unknown[]) {
        const receiver = Prisma.getExtensionContext(this);
        if (typeof args[0] !== 'function')
          return rawTransaction.apply(receiver, args);
        const fn = args[0] as (tx: Prisma.TransactionClient) => Promise<unknown>;
        return runManagedTransaction(
          receiver,
          fn,
          args[1] as TransactionOptions | undefined,
        );
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
          return runManagedTransaction(self, async (tx) => {
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

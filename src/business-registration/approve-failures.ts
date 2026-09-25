/**
 * Predicates for the two Prisma failures of the approve transaction that are
 * safe to turn into the HTML "retry" page: both leave everything rolled back
 * and the request `pendiente`, so opening the same link again really works.
 * They are deliberately narrow: any other error (including a unique
 * violation on some other constraint, or a transaction that could not even
 * start) must keep propagating untouched.
 *
 * Shapes observed against Postgres + Prisma 7.10 + `@prisma/adapter-pg`:
 * - a racing Account insert: `PrismaClientKnownRequestError` P2002 with
 *   `meta.modelName = 'Account'` and
 *   `meta.driverAdapterError.cause = { originalCode: '23505', constraint:
 *   { index: 'Account_username_key' }, table: 'Account' }`;
 * - a transaction that outlived its timeout: P2028 with
 *   `meta = { operation: 'commit' | 'query', timeout, timeTaken }` and a
 *   message about an "expired transaction" (the "could not start in time"
 *   P2028 carries `meta.maxWait` instead and is not matched).
 */

/** Postgres name of the unique index behind `Account.username`. */
export const ACCOUNT_USERNAME_CONSTRAINT = 'Account_username_key';

interface PrismaLikeError extends Error {
  code?: unknown;
  meta?: {
    modelName?: unknown;
    target?: unknown;
    timeout?: unknown;
    driverAdapterError?: { cause?: { constraint?: { index?: unknown } } };
  };
}

function prismaCode(error: unknown, code: string): error is PrismaLikeError {
  return error instanceof Error && (error as PrismaLikeError).code === code;
}

/** A unique violation on `Account.username` (and only on it). */
export function isAccountUsernameConflict(error: unknown): boolean {
  if (!prismaCode(error, 'P2002')) return false;
  const meta = error.meta;
  if (
    meta?.driverAdapterError?.cause?.constraint?.index ===
    ACCOUNT_USERNAME_CONSTRAINT
  )
    return true;
  // Engine-style shape: the violated fields, scoped to the Account model.
  if (
    meta?.modelName === 'Account' &&
    Array.isArray(meta.target) &&
    meta.target.includes('username')
  )
    return true;
  return error.message.includes(`\`${ACCOUNT_USERNAME_CONSTRAINT}\``);
}

/** The interactive transaction outlived its timeout (a query or the commit). */
export function isTransactionExpired(error: unknown): boolean {
  if (!prismaCode(error, 'P2028')) return false;
  return (
    typeof error.meta?.timeout === 'number' ||
    /expired transaction/i.test(error.message)
  );
}

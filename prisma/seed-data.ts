import { argon2id, hash } from 'argon2';
import type { PrismaClient } from '../src/generated/prisma/client.js';

interface DriverAdapterCause {
  originalCode?: unknown;
  code?: unknown;
  constraint?: { index?: unknown };
}

/** The Postgres driver's own error, as Prisma 7 + adapter-pg nests it under `meta`. */
function driverAdapterCause(error: unknown): DriverAdapterCause | undefined {
  const meta = (error as { meta?: unknown } | null | undefined)?.meta as
    | { driverAdapterError?: { cause?: DriverAdapterCause } }
    | undefined;
  return meta?.driverAdapterError?.cause;
}

/**
 * Detects a Postgres Row Level Security policy violation (SQLSTATE
 * `42501`, message containing "row-level security policy") surfaced
 * through Prisma, regardless of exactly how deep it is nested in the
 * thrown error's `cause`/`meta` (this varies by Prisma version and
 * whether the failing statement went through the query engine or a raw
 * query).
 *
 * Observed against real Postgres 16 + Prisma 7.10 + `@prisma/adapter-pg`
 * with a non-superuser role: a real violation is a
 * `PrismaClientKnownRequestError` with code `P2039` (not `42501`), whose
 * `message` ends with "Database error. Code: `42501`. Message: `new row
 * violates row-level security policy for table \"Member\"`", with the
 * SQLSTATE also under `meta.driverAdapterError.cause` and no `.cause`.
 */
export function isRowLevelSecurityViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let i = 0; i < 5 && current; i++) {
    if (current instanceof Error) {
      if (/row-level security policy/i.test(current.message)) return true;
      const code = (current as { code?: unknown }).code;
      if (code === '42501') return true;
      const adapterCause = driverAdapterCause(current);
      if (adapterCause?.originalCode === '42501' || adapterCause?.code === '42501')
        return true;
      current = (current as { cause?: unknown }).cause;
      continue;
    }
    break;
  }
  return false;
}

/**
 * Detects a Prisma unique-constraint violation (`P2002`, Postgres
 * `23505`) on one specific constraint/index, by the name Postgres
 * reports (`meta.driverAdapterError.cause.constraint.index` with
 * `@prisma/adapter-pg`, or the "on the constraint: `name`" tail of the
 * message as a fallback).
 */
export function isUniqueViolationOnConstraint(
  error: unknown,
  constraint: string,
): boolean {
  if (!(error instanceof Error)) return false;
  if ((error as { code?: unknown }).code !== 'P2002') return false;
  if (driverAdapterCause(error)?.constraint?.index === constraint) return true;
  return error.message.includes(`\`${constraint}\``);
}

/**
 * Whether an upsert failure inside a context-scoped seed transaction
 * means "this row already belongs to another context": either Postgres
 * refused it through RLS, or — the case actually observed for these
 * fixed-id/identifier upserts — RLS hid the other context's row from the
 * scoped session, so the upsert fell through to an INSERT that then hit
 * the row's unique constraint (`constraint`). Inside the scoped
 * transaction a unique violation on that constraint can only mean the
 * row exists but is invisible, i.e. it is owned by a different context.
 */
export function isSeedContextConflict(
  error: unknown,
  constraint: string,
): boolean {
  return (
    isRowLevelSecurityViolation(error) ||
    isUniqueViolationOnConstraint(error, constraint)
  );
}

/**
 * Seeds one context's founding accounts/members/devices, upserting so it
 * is safe to run repeatedly against the same database (local dev,
 * fixture setup for e2e specs that need a fully-seeded context, etc.).
 *
 * BE-11: Postgres RLS now denies access to every tenant-scoped table by
 * default (no permissive fallback) unless the current session has set
 * `app.context_id` to match. This function is called directly against a
 * raw/injected Prisma client (bypassing the Nest app, so nothing sets
 * that variable on its behalf), so its own transaction sets it itself —
 * via `set_config(..., true)` (`is_local`, i.e. `SET LOCAL` semantics,
 * matching exactly how `PrismaService`'s `$transaction` override does it
 * for real requests — see src/database/tenant.extension.ts) as the very
 * first statement, before any Member/Device row is touched.
 *
 * One consequence of that: once the session is scoped to
 * `options.contextId`, a Member/Device `id`/`identifier` that already
 * exists under a *different* context is no longer visible to this
 * session at all (RLS hides it), so the mismatch check on the upsert
 * result below can no longer see it either. What Postgres does then, as
 * observed against real Postgres 16 + Prisma 7.10 + adapter-pg with a
 * non-superuser role: the upsert finds nothing, tries to INSERT, and the
 * database raises a UNIQUE violation (`P2002`, `Member_pkey` /
 * `Device_identifier_key`) — it does NOT reach the UPDATE policy, so no
 * `42501` is raised for this case. A genuine RLS violation (`P2039` /
 * `42501`) is still possible for other write shapes. Either way the
 * write is refused, so the safety property holds, and
 * {@link isSeedContextConflict} normalizes both rejections into the same
 * descriptive error this function threw for that situation before
 * BE-11. With a superuser/BYPASSRLS connection nothing is hidden, the
 * upsert returns the other context's row, and the `contextId` check on
 * the result raises the same error.
 */
export async function seedContext(
  prisma: PrismaClient,
  options: {
    contextId: string;
    username: string;
    password: string;
  },
) {
  if (
    !options.contextId ||
    options.contextId === 'legacy-unassigned' ||
    !options.username ||
    options.password.length < 12
  ) {
    throw new Error(
      'Seed requires context, username and a password of at least 12 characters',
    );
  }
  const existing = await prisma.account.findUnique({
    where: { username: options.username },
  });
  if (existing && existing.contextId !== options.contextId) {
    throw new Error('Seed username already belongs to another context');
  }
  const passwordHash =
    existing?.passwordHash ??
    (await hash(options.password, { type: argon2id }));
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.context_id', ${options.contextId}, true)`;
    const account = await tx.account.upsert({
      where: { username: options.username },
      update: {},
      create: {
        username: options.username,
        passwordHash,
        contextId: options.contextId,
      },
    });
    if (account.contextId !== options.contextId)
      throw new Error('Seed account context mismatch');
    for (const [id, name] of [
      ['bf030001-0000-4000-8000-000000000001', 'Alberto'],
      ['bf030001-0000-4000-8000-000000000002', 'Adid'],
    ]) {
      try {
        const result = await tx.member.upsert({
          where: { id },
          update: {},
          create: { id, name, role: 'socio', contextId: options.contextId },
        });
        if (result.contextId !== options.contextId)
          throw new Error('Seed member context mismatch');
      } catch (err) {
        if (isSeedContextConflict(err, 'Member_pkey'))
          throw new Error('Seed member context mismatch');
        throw err;
      }
    }
    for (const [identifier, name] of [
      ['shared-tablet', 'Shared tablet'],
      ['alberto-backup-phone', 'Alberto backup phone'],
      ['adid-backup-phone', 'Adid backup phone'],
    ]) {
      try {
        const result = await tx.device.upsert({
          where: { identifier },
          update: {},
          create: {
            identifier,
            name,
            contextId: options.contextId,
            authorized: true,
          },
        });
        if (result.contextId !== options.contextId)
          throw new Error('Seed device context mismatch');
      } catch (err) {
        if (isSeedContextConflict(err, 'Device_identifier_key'))
          throw new Error('Seed device context mismatch');
        throw err;
      }
    }
  });
}


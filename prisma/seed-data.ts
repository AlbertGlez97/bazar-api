import { argon2id, hash } from 'argon2';
import type { PrismaClient } from '../src/generated/prisma/client.js';

/**
 * Detects a Postgres Row Level Security policy violation (SQLSTATE
 * `42501`, message containing "row-level security policy") surfaced
 * through Prisma, regardless of exactly how deep it is nested in the
 * thrown error's `cause`/`meta` (this varies by Prisma version and
 * whether the failing statement went through the query engine or a raw
 * query) — used below to turn "Postgres itself refused this write
 * because the existing row belongs to a different tenant" into the same
 * clear, existing "context mismatch" error this function already threw
 * for that case before BE-11 made RLS strict.
 */
function isRowLevelSecurityViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let i = 0; i < 5 && current; i++) {
    if (current instanceof Error) {
      if (/row-level security policy/i.test(current.message)) return true;
      const code = (current as { code?: unknown }).code;
      if (code === '42501') return true;
      current = (current as { cause?: unknown }).cause;
      continue;
    }
    break;
  }
  return false;
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
 * session at all (RLS hides it), so the pre-upsert `findUnique` mismatch
 * check below can no longer see it either. Postgres itself still refuses
 * the write (`INSERT ... ON CONFLICT DO UPDATE` fails its UPDATE policy's
 * check against a row it cannot see), so the safety property is
 * preserved — {@link isRowLevelSecurityViolation} just normalizes that
 * database-level rejection into the same descriptive error this
 * function already threw for the same situation before BE-11.
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
        if (isRowLevelSecurityViolation(err))
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
        if (isRowLevelSecurityViolation(err))
          throw new Error('Seed device context mismatch');
        throw err;
      }
    }
  });
}


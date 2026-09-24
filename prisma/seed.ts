import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { seedContext } from './seed-data.js';

const { DATABASE_URL, SEED_CONTEXT_ID, SEED_USERNAME, SEED_PASSWORD } =
  process.env;
if (!DATABASE_URL || !SEED_CONTEXT_ID || !SEED_USERNAME || !SEED_PASSWORD) {
  throw new Error(
    'DATABASE_URL, SEED_CONTEXT_ID, SEED_USERNAME and SEED_PASSWORD are required',
  );
}
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: DATABASE_URL }),
});
try {
  // BE-11: RLS policies now FORCE row-level security on every
  // tenant-scoped table, so this raw, unextended PrismaClient (it does
  // not go through Nest DI or the tenant-isolation extension — see
  // src/database/tenant.extension.ts) must set the same
  // `app.context_id` session variable the app's own connections set, or
  // every insert below would be silently rejected by Postgres. The whole
  // seed runs inside a single transaction so it stays pinned to one
  // pooled connection — `set_config(..., true)` ("is_local") only lasts
  // for the current transaction, and a plain (non-transactional) call
  // could have its effect discarded if a later query in this script
  // happened to land on a different connection from the pool.
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.context_id', ${SEED_CONTEXT_ID}, true)`;
    await seedContext(tx as unknown as PrismaClient, {
      contextId: SEED_CONTEXT_ID,
      username: SEED_USERNAME,
      password: SEED_PASSWORD,
    });
  });
} finally {
  await prisma.$disconnect();
}

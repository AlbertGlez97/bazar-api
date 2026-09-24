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
  // BE-11: seedContext (prisma/seed-data.ts) already opens its own
  // transaction and sets the `app.context_id` session variable itself
  // before touching any tenant-scoped table (Postgres RLS now denies
  // access by default without it) — nothing extra is needed here. Do
  // NOT wrap this call in an additional `prisma.$transaction(...)`: the
  // interactive-transaction client (`tx`) Prisma hands the callback does
  // not itself expose a `$transaction` method, so passing it into
  // `seedContext` (which calls `prisma.$transaction(...)` internally)
  // would fail at runtime.
  await seedContext(prisma, {
    contextId: SEED_CONTEXT_ID,
    username: SEED_USERNAME,
    password: SEED_PASSWORD,
  });
} finally {
  await prisma.$disconnect();
}

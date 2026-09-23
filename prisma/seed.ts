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
  await seedContext(prisma, {
    contextId: SEED_CONTEXT_ID,
    username: SEED_USERNAME,
    password: SEED_PASSWORD,
  });
} finally {
  await prisma.$disconnect();
}

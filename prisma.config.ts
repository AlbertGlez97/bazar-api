import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'node --import tsx prisma/seed.ts',
  },
  // The CLI (migrate, db pull...) connects as the owner/migrator role. The app
  // and `prisma db seed` read DATABASE_URL directly and connect as the
  // least-privileged runtime role. See doc/runtime-database-role.md.
  datasource: {
    url: process.env.DATABASE_URL_MIGRATE || env('DATABASE_URL'),
  },
});

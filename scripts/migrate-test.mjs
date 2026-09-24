import { spawnSync } from 'node:child_process';
import { configureTestMigration } from './test-environment.ts';

// Migrations run as the owner (DATABASE_URL_TEST_MIGRATE, falling back to
// DATABASE_URL_TEST); the tests themselves connect as the runtime role. Run
// `npm run db:provision:test` afterwards (db:migrate:test chains it).
configureTestMigration();
const result = spawnSync(
  process.execPath,
  ['node_modules/prisma/build/index.js', 'migrate', 'deploy'],
  {
    stdio: 'inherit',
    env: process.env,
  },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;

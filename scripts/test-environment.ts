import 'dotenv/config';

function validateTestUrl(name: string, value: string): URL {
  const test = new URL(value);
  if (
    !['postgres:', 'postgresql:'].includes(test.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(test.hostname) ||
    decodeURIComponent(test.pathname) !== '/bazar_test' ||
    test.search ||
    test.hash
  ) {
    throw new Error(
      `Tests require a local PostgreSQL bazar_test database (${name})`,
    );
  }
  return test;
}

export function selectTestDatabase(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const value = env.DATABASE_URL_TEST;
  if (!value)
    throw new Error('DATABASE_URL_TEST is required; no development fallback');
  const test = validateTestUrl('DATABASE_URL_TEST', value);
  if (
    env.DATABASE_URL &&
    new URL(env.DATABASE_URL).pathname === test.pathname
  ) {
    throw new Error('Development and test database names must differ');
  }
  return value;
}

/**
 * Owner/migrator URL of the test database (DATABASE_URL_TEST_MIGRATE, falling
 * back to DATABASE_URL_TEST). It gets the same isolation checks as the runtime
 * URL and must point at the same server and database, so a migration or a
 * provisioning run can never reach anything but the isolated test database.
 */
export function selectTestMigrationDatabase(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const runtime = env.DATABASE_URL_TEST;
  if (!runtime)
    throw new Error('DATABASE_URL_TEST is required; no development fallback');
  const value = env.DATABASE_URL_TEST_MIGRATE || runtime;
  const migrate = validateTestUrl('DATABASE_URL_TEST_MIGRATE', value);
  const runtimeUrl = validateTestUrl('DATABASE_URL_TEST', runtime);
  if (
    migrate.host !== runtimeUrl.host ||
    migrate.pathname !== runtimeUrl.pathname
  ) {
    throw new Error(
      'DATABASE_URL_TEST_MIGRATE must target the same host, port and database as DATABASE_URL_TEST',
    );
  }
  return value;
}

/** Runtime connection: the app and the tests use the least-privileged role. */
export function configureTestDatabase() {
  const url = selectTestDatabase();
  process.env.DATABASE_URL = url;
  process.env.NODE_ENV = 'test';
}

/**
 * Owner connection for `prisma migrate` on the test database. prisma.config.ts
 * reads DATABASE_URL_MIGRATE first, so it is pointed at the test owner URL.
 */
export function configureTestMigration() {
  configureTestDatabase();
  process.env.DATABASE_URL_MIGRATE = selectTestMigrationDatabase();
}

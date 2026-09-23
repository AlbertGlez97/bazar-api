import 'dotenv/config';

export function selectTestDatabase(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const value = env.DATABASE_URL_TEST;
  if (!value)
    throw new Error('DATABASE_URL_TEST is required; no development fallback');
  const test = new URL(value);
  if (
    !['postgres:', 'postgresql:'].includes(test.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(test.hostname) ||
    decodeURIComponent(test.pathname) !== '/bazar_test' ||
    test.search ||
    test.hash
  ) {
    throw new Error('Tests require a local PostgreSQL bazar_test database');
  }
  if (
    env.DATABASE_URL &&
    new URL(env.DATABASE_URL).pathname === test.pathname
  ) {
    throw new Error('Development and test database names must differ');
  }
  return value;
}

export function configureTestDatabase() {
  const url = selectTestDatabase();
  process.env.DATABASE_URL = url;
  process.env.NODE_ENV = 'test';
}

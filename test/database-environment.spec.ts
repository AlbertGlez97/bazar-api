import {
  selectTestDatabase,
  selectTestMigrationDatabase,
} from '../scripts/test-environment.js';

const testUrl = 'postgresql://test:example@127.0.0.1:5433/bazar_test';
describe('test database guard', () => {
  it('selects only the explicit isolated database', () => {
    expect(
      selectTestDatabase({
        DATABASE_URL_TEST: testUrl,
        DATABASE_URL: 'postgresql://dev:example@127.0.0.1:5432/bazar_dev',
      }),
    ).toBe(testUrl);
  });
  it.each([
    {},
    { DATABASE_URL: testUrl },
    { DATABASE_URL_TEST: testUrl, DATABASE_URL: testUrl },
    { DATABASE_URL_TEST: testUrl.replace('bazar_test', 'bazar_dev') },
    { DATABASE_URL_TEST: testUrl.replace('127.0.0.1', 'example.com') },
    { DATABASE_URL_TEST: `${testUrl}?database=bazar_dev` },
  ])('rejects unsafe configuration %o', (env) => {
    expect(() => selectTestDatabase(env)).toThrow();
  });
});

describe('test migration database guard', () => {
  const runtime = 'postgresql://app:example@127.0.0.1:5433/bazar_test';
  const owner = 'postgresql://owner:example@127.0.0.1:5433/bazar_test';
  it('uses the owner URL when provided', () => {
    expect(
      selectTestMigrationDatabase({
        DATABASE_URL_TEST: runtime,
        DATABASE_URL_TEST_MIGRATE: owner,
      }),
    ).toBe(owner);
  });
  it('falls back to the runtime test URL', () => {
    expect(selectTestMigrationDatabase({ DATABASE_URL_TEST: runtime })).toBe(
      runtime,
    );
  });
  it.each([
    {},
    { DATABASE_URL_TEST_MIGRATE: owner },
    {
      DATABASE_URL_TEST: runtime,
      DATABASE_URL_TEST_MIGRATE: owner.replace('bazar_test', 'bazar_dev'),
    },
    {
      DATABASE_URL_TEST: runtime,
      DATABASE_URL_TEST_MIGRATE: owner.replace('127.0.0.1', 'example.com'),
    },
    {
      DATABASE_URL_TEST: runtime,
      DATABASE_URL_TEST_MIGRATE: owner.replace(':5433', ':5432'),
    },
  ])('rejects unsafe configuration %o', (env) => {
    expect(() => selectTestMigrationDatabase(env)).toThrow();
  });
});

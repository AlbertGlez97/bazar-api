import { selectTestDatabase } from '../scripts/test-environment.js';

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

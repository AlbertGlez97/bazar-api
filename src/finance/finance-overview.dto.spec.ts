import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { FinanceOverviewDto } from './finance-overview.dto.js';

describe('FinanceOverviewDto', () => {
  it.each([
    {},
    { from: '2026-10-01' },
    { from: '2026-02-30', to: '2026-03-01' },
    { from: '2026-10-01T00:00:00Z', to: '2026-10-02' },
    { from: '0000-01-01', to: '2026-10-02' },
    { from: ['2026-10-01'], to: '2026-10-02' },
  ])('rejects invalid or missing boundaries %j', async (input) => {
    expect(
      await validate(plainToInstance(FinanceOverviewDto, input)),
    ).not.toHaveLength(0);
  });
  it('accepts a leap day and required date-only boundaries', async () => {
    expect(
      await validate(
        plainToInstance(FinanceOverviewDto, {
          from: '2024-02-29',
          to: '2024-03-01',
        }),
      ),
    ).toHaveLength(0);
  });
});

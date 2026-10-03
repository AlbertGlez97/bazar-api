import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { v7 } from 'uuid';
import { CreateContributionDto } from './contribution.dto.js';
const dto = (overrides: Record<string, unknown> = {}) =>
  plainToInstance(CreateContributionDto, {
    id: v7(),
    memberId: v7(),
    createdByMemberId: v7(),
    deviceId: v7(),
    amountMinor: 100,
    occurredAt: '2026-10-03T00:00:00.000Z',
    ...overrides,
  });
describe('contribution financial boundary', () => {
  it('accepts positive integer MXN cents and explicit timezone', async () =>
    expect(await validate(dto())).toEqual([]));
  it.each([0, -1, 1.5, 2147483648, '100'])(
    'rejects invalid amount %s',
    async (amountMinor) =>
      expect(
        (await validate(dto({ amountMinor }))).some(
          (e) => e.property === 'amountMinor',
        ),
      ).toBe(true),
  );
  it('rejects sub-millisecond instants that PostgreSQL would silently round', async () =>
    expect(
      (await validate(dto({ occurredAt: '2026-10-03T00:00:00.1234Z' }))).some(
        (e) => e.property === 'occurredAt',
      ),
    ).toBe(true));
});

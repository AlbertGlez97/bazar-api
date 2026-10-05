import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { randomUUID } from 'node:crypto';
import { v7 } from 'uuid';
import {
  CreateExpenseDto,
  ExpenseListDto,
  isValidNatureCategoryPair,
  ReverseExpenseDto,
} from './expense.dto.js';

const body = (overrides: Record<string, unknown> = {}) => ({
  id: v7(),
  amountMinor: 12500,
  occurredAt: '2026-10-05T10:00:00-06:00',
  nature: 'OPERATING_EXPENSE',
  category: 'transport',
  description: 'Taxi to the bazaar',
  paidByMemberId: v7(),
  fundsSource: 'BUSINESS',
  createdByMemberId: v7(),
  deviceId: v7(),
  ...overrides,
});
const dto = (overrides: Record<string, unknown> = {}) =>
  plainToInstance(CreateExpenseDto, body(overrides));
const rejects = async (overrides: Record<string, unknown>, property: string) =>
  expect(
    (await validate(dto(overrides))).some((e) => e.property === property),
  ).toBe(true);

describe('expense financial boundary', () => {
  it('accepts a valid operating expense and an inventory purchase', async () => {
    expect(await validate(dto())).toEqual([]);
    expect(
      await validate(
        dto({ nature: 'INVENTORY_PURCHASE', category: 'inventory' }),
      ),
    ).toEqual([]);
  });

  it.each([0, -1, 1.5, 2147483648, '100', null])(
    'rejects invalid amount %s',
    (amountMinor) => rejects({ amountMinor }, 'amountMinor'),
  );

  it.each(['gifts', 'Transport', '', 7])('rejects category %s', (category) =>
    rejects({ category }, 'category'),
  );

  it.each(['SALE', 'operating_expense', ''])('rejects nature %s', (nature) =>
    rejects({ nature }, 'nature'),
  );

  it.each(['BANK', 'business', ''])('rejects fundsSource %s', (fundsSource) =>
    rejects({ fundsSource }, 'fundsSource'),
  );

  it('rejects ids that are not UUID v7 and instants without a timezone', async () => {
    await rejects({ id: randomUUID() }, 'id');
    await rejects({ occurredAt: '2026-10-05' }, 'occurredAt');
    await rejects({ occurredAt: '2026-10-05T10:00:00' }, 'occurredAt');
  });

  it('trims descriptions and rejects blank or oversized ones', async () => {
    expect(dto({ description: '  Taxi  ' }).description).toBe('Taxi');
    await rejects({ description: '   ' }, 'description');
    await rejects({ description: 'x'.repeat(281) }, 'description');
    expect(await validate(dto({ description: 'x'.repeat(280) }))).toEqual([]);
  });

  it('validates a nested replacement', async () => {
    const reversal = plainToInstance(ReverseExpenseDto, {
      id: v7(),
      createdByMemberId: v7(),
      deviceId: v7(),
      occurredAt: '2026-10-05T12:00:00Z',
      reason: 'Wrong amount',
      replacement: body({ amountMinor: 0 }),
    });
    expect((await validate(reversal)).length).toBeGreaterThan(0);
  });

  it('validates list filters', async () => {
    const list = (q: Record<string, unknown>) =>
      validate(plainToInstance(ExpenseListDto, q));
    expect(
      await list({ nature: 'INVENTORY_PURCHASE', category: 'fuel' }),
    ).toEqual([]);
    expect((await list({ nature: 'nope' })).length).toBeGreaterThan(0);
    expect((await list({ category: 'nope' })).length).toBeGreaterThan(0);
  });

  it('pairs INVENTORY_PURCHASE exclusively with the inventory category', () => {
    expect(isValidNatureCategoryPair('INVENTORY_PURCHASE', 'inventory')).toBe(
      true,
    );
    expect(isValidNatureCategoryPair('OPERATING_EXPENSE', 'fuel')).toBe(true);
    expect(isValidNatureCategoryPair('INVENTORY_PURCHASE', 'fuel')).toBe(false);
    expect(isValidNatureCategoryPair('OPERATING_EXPENSE', 'inventory')).toBe(
      false,
    );
  });
});

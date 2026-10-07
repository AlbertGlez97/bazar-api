import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { v7 } from 'uuid';
import { randomUUID } from 'node:crypto';
import {
  CreateFinanceReserveDto,
  FinanceReserveListDto,
} from './finance-reserve.dto.js';
const valid = () => ({
  id: v7(),
  name: 'Rent buffer',
  amountMinor: 5000,
  periodFrom: '2026-10-01',
  periodTo: '2026-11-01',
  occurredAt: '2026-10-07T12:00:00Z',
  createdByMemberId: randomUUID(),
  deviceId: randomUUID(),
});
describe('reserve input contract', () => {
  it('accepts positive MXN planning with normalized name and optional note', async () => {
    const dto = plainToInstance(CreateFinanceReserveDto, {
      ...valid(),
      name: '  Rent buffer  ',
      note: '  Pending quote  ',
    });
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.name).toBe('Rent buffer');
    expect(dto.note).toBe('Pending quote');
  });
  it.each([
    { amountMinor: 0 },
    { amountMinor: -1 },
    { amountMinor: '5000' },
    { amountMinor: true },
    { amountMinor: 2147483648 },
    { name: '   ' },
    { name: 5 },
    { currency: 'USD' },
    { periodFrom: '2026-02-30' },
    { periodTo: '2026-10-01' },
    { periodTo: '2026-09-01' },
    { id: randomUUID() },
    { occurredAt: '2026-10-07' },
  ])('rejects invalid creation %j', async (overrides) => {
    expect(
      await validate(
        plainToInstance(CreateFinanceReserveDto, { ...valid(), ...overrides }),
      ),
    ).not.toHaveLength(0);
  });
  it.each([
    { from: '2026-10-01' },
    { to: '2026-10-02' },
    { from: '2026-10-02', to: '2026-10-01' },
    { from: '2026-02-30', to: '2026-03-01' },
    { limit: '1e2' },
    { limit: '0x10' },
    { limit: true },
    { limit: '' },
    { limit: ['20'] },
    { status: 'all' },
  ])('rejects malformed list filters %j', async (query) => {
    expect(
      await validate(plainToInstance(FinanceReserveListDto, query)),
    ).not.toHaveLength(0);
  });
  it('accepts paired exact dates and a strict decimal pagination limit', async () => {
    const dto = plainToInstance(FinanceReserveListDto, {
      from: '2024-02-29',
      to: '2024-03-01',
      limit: '10',
      status: 'active',
    });
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.limit).toBe(10);
  });
});

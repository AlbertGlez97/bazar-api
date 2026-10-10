import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ValidationPipe } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { v7 } from 'uuid';
import {
  CreateDistributionPaymentDto,
  ReverseDistributionPaymentDto,
} from './finance-payments.dto.js';

const create = (): Record<string, unknown> => ({
  id: v7(),
  participantMemberId: randomUUID(),
  amountMinor: 1000,
  occurredAt: '2026-10-09T12:00:00-06:00',
  createdByMemberId: randomUUID(),
  deviceId: randomUUID(),
});
const reverse = (): Record<string, unknown> => ({
  id: v7(),
  reason: 'Wrong amount typed',
  occurredAt: '2026-10-09T12:00:00.123Z',
  createdByMemberId: randomUUID(),
  deviceId: randomUUID(),
});
const props = async (cls: new () => object, plain: object) =>
  (await validate(plainToInstance(cls, plain))).map((e) => e.property).sort();
const pipe = (expectedType: new () => object) =>
  new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    expectedType,
  });

describe('distribution payment create contract', () => {
  it('accepts a valid body, with the note optional', async () => {
    expect(await props(CreateDistributionPaymentDto, create())).toEqual([]);
    expect(
      await props(CreateDistributionPaymentDto, { ...create(), note: 'cash' }),
    ).toEqual([]);
  });

  it('trims the note and turns a blank note into null', async () => {
    const trimmed = plainToInstance(CreateDistributionPaymentDto, {
      ...create(),
      note: '  paid in person  ',
    });
    expect(trimmed.note).toBe('paid in person');
    const blank = plainToInstance(CreateDistributionPaymentDto, {
      ...create(),
      note: '   ',
    });
    expect(blank.note).toBeNull();
    expect(await validate(blank)).toHaveLength(0);
  });

  it('rejects amounts that are zero, negative, fractional, text or too large', async () => {
    for (const amountMinor of [0, -1, 1.5, '10', null, 2_147_483_648])
      expect(
        await props(CreateDistributionPaymentDto, { ...create(), amountMinor }),
      ).toContain('amountMinor');
    expect(
      await props(CreateDistributionPaymentDto, {
        ...create(),
        amountMinor: 2_147_483_647,
      }),
    ).toEqual([]);
  });

  it('requires a UUIDv7 id and UUID references', async () => {
    for (const field of [
      'id',
      'participantMemberId',
      'createdByMemberId',
      'deviceId',
    ])
      expect(
        await props(CreateDistributionPaymentDto, {
          ...create(),
          [field]: 'x',
        }),
      ).toContain(field);
    expect(
      await props(CreateDistributionPaymentDto, {
        ...create(),
        id: randomUUID(),
      }),
    ).toContain('id');
  });

  it('requires a zoned instant with at most 3 fractional digits', async () => {
    for (const occurredAt of [
      '2026-10-09',
      '2026-10-09T12:00:00',
      '2026-10-09T12:00:00.1234Z',
      'garbage',
      undefined,
    ])
      expect(
        await props(CreateDistributionPaymentDto, { ...create(), occurredAt }),
      ).toContain('occurredAt');
  });

  it('rejects a note longer than 1000 characters', async () => {
    expect(
      await props(CreateDistributionPaymentDto, {
        ...create(),
        note: 'x'.repeat(1001),
      }),
    ).toContain('note');
  });

  it('rejects unknown and server-owned fields through the strict pipe', async () => {
    for (const extra of [
      'agreedMinor',
      'pendingMinor',
      'contextId',
      'accountId',
      'participantName',
      'currency',
      'status',
    ])
      await expect(
        pipe(CreateDistributionPaymentDto).transform(
          { ...create(), [extra]: 'x' },
          { type: 'body', metatype: CreateDistributionPaymentDto },
        ),
      ).rejects.toThrow();
  });
});

describe('distribution payment reversal contract', () => {
  it('accepts a valid body and trims the reason', async () => {
    const dto = plainToInstance(ReverseDistributionPaymentDto, {
      ...reverse(),
      reason: '  Wrong amount  ',
    });
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.reason).toBe('Wrong amount');
  });

  it('requires a non-blank reason of at most 1000 characters', async () => {
    for (const reason of ['', '   ', undefined, 'x'.repeat(1001)])
      expect(
        await props(ReverseDistributionPaymentDto, { ...reverse(), reason }),
      ).toContain('reason');
  });

  it('requires a UUIDv7 id, a zoned instant and origin ids', async () => {
    expect(
      await props(ReverseDistributionPaymentDto, {
        ...reverse(),
        id: randomUUID(),
      }),
    ).toContain('id');
    expect(
      await props(ReverseDistributionPaymentDto, {
        ...reverse(),
        occurredAt: '2026-10-09T12:00:00',
      }),
    ).toContain('occurredAt');
    expect(
      await props(ReverseDistributionPaymentDto, {
        ...reverse(),
        deviceId: undefined,
      }),
    ).toContain('deviceId');
  });

  it('rejects unknown fields', async () => {
    await expect(
      pipe(ReverseDistributionPaymentDto).transform(
        { ...reverse(), paymentId: randomUUID() },
        { type: 'body', metatype: ReverseDistributionPaymentDto },
      ),
    ).rejects.toThrow();
  });
});

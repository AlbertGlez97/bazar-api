import { describe, expect, it, vi } from 'vitest';
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { CREDENTIALS_EMAIL_TIMEOUT_MS } from '../email/email.service.js';
import {
  MEMBER_CREATE_TRANSACTION_OPTIONS,
  MembersService,
} from './members.service.js';
import type { CreateMemberDto } from './dto/member.dto.js';

// The Resend calls run inside the create transaction and have no abort signal
// in the installed SDK, so EmailService bounds them with its own timer (the
// TOTAL deadline of the direct send plus the approver fallback). It must fire
// first, in a controlled way (rollback and 502), instead of the transaction
// expiring under a pending call. The margin covers the queries and the Argon2
// hash that run before the email is sent. Same rule as the business approval.
describe('member creation transaction', () => {
  it('keeps the credentials email total deadline below the transaction timeout, with a 5 s margin', () => {
    expect(CREDENTIALS_EMAIL_TIMEOUT_MS).toBeLessThan(
      MEMBER_CREATE_TRANSACTION_OPTIONS.timeout,
    );
    expect(
      MEMBER_CREATE_TRANSACTION_OPTIONS.timeout - CREDENTIALS_EMAIL_TIMEOUT_MS,
    ).toBeGreaterThanOrEqual(5_000);
  });
});

/** The Prisma failure of a racing `Account.username` insert (see approve-failures.ts). */
const usernameRace = () =>
  Object.assign(new Error('Unique constraint failed on Account_username_key'), {
    code: 'P2002',
    meta: {
      modelName: 'Account',
      driverAdapterError: {
        cause: { constraint: { index: 'Account_username_key' } },
      },
    },
  });

/** The Prisma failure of a transaction that outlived its timeout. */
const expiredTransaction = () =>
  Object.assign(new Error('Transaction API error: expired transaction'), {
    code: 'P2028',
    meta: { operation: 'commit', timeout: 15_000, timeTaken: 15_100 },
  });

const actor = {
  account: { id: 'account-id', contextId: 'ctx', memberId: null },
  selection: { memberId: 'socio-id', deviceId: 'device-id' },
} as unknown as Parameters<MembersService['create']>[0];

const dto = (overrides: Partial<CreateMemberDto> = {}): CreateMemberDto =>
  ({
    nombre: 'Ana',
    apellidos: 'Nueva',
    correo: 'ana@example.test',
    role: 'colaborador',
    ...overrides,
  }) as CreateMemberDto;

const created = {
  id: 'member-id',
  name: 'Ana Nueva',
  role: 'colaborador' as const,
  active: true,
  commissionRateBps: null,
  createdByMemberId: 'socio-id',
  username: 'ana@example.test',
  credentialsEmail: 'member' as const,
};

describe('MembersService.create failure handling', () => {
  const service = (transaction: ReturnType<typeof vi.fn>) =>
    new MembersService({ $transaction: transaction } as never, {} as never);

  it('rejects a commission rate for a socio before opening any transaction', async () => {
    const transaction = vi.fn();

    await expect(
      service(transaction).create(actor, dto({ role: 'socio', commissionRateBps: 0 })),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service(transaction).create(actor, dto({ role: 'socio', commissionRateBps: null })),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('rejects a correo the credentials email could not go to before opening any transaction', async () => {
    const transaction = vi.fn();

    await expect(
      service(transaction).create(actor, dto({ correo: "o'brien@example.test" })),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('retries a lost username race with a fresh transaction and succeeds', async () => {
    const transaction = vi
      .fn()
      .mockRejectedValueOnce(usernameRace())
      .mockRejectedValueOnce(usernameRace())
      .mockResolvedValueOnce(created);

    await expect(service(transaction).create(actor, dto())).resolves.toEqual(created);
    expect(transaction).toHaveBeenCalledTimes(3);
  });

  it('answers 409 when the username race is lost on every attempt', async () => {
    const transaction = vi.fn().mockRejectedValue(usernameRace());

    await expect(service(transaction).create(actor, dto())).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(transaction).toHaveBeenCalledTimes(3);
  });

  it('answers 502 when the transaction expires, and does not retry', async () => {
    const transaction = vi.fn().mockRejectedValue(expiredTransaction());

    await expect(service(transaction).create(actor, dto())).rejects.toBeInstanceOf(
      BadGatewayException,
    );
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it('lets any other failure through untouched, without retrying', async () => {
    const boom = new Error('database is down');
    const transaction = vi.fn().mockRejectedValue(boom);

    await expect(service(transaction).create(actor, dto())).rejects.toBe(boom);
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it('runs the transaction with the documented options', async () => {
    const transaction = vi.fn().mockResolvedValue(created);

    await service(transaction).create(actor, dto());

    expect(transaction.mock.calls[0][1]).toEqual(MEMBER_CREATE_TRANSACTION_OPTIONS);
  });
});

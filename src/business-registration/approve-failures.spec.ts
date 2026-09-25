import { describe, expect, it } from 'vitest';
import { Prisma } from '../generated/prisma/client.js';
import {
  isAccountUsernameConflict,
  isTransactionExpired,
} from './approve-failures.js';

// Error shapes below were captured from a real Postgres + Prisma 7.10 +
// @prisma/adapter-pg session (an Account insert racing on `username`, and an
// interactive transaction whose timeout elapsed before its commit).
const clientVersion = '7.10.0';

const uniqueViolation = (constraint: string, table: string) =>
  new Prisma.PrismaClientKnownRequestError(
    `Invalid \`tx.${table.toLowerCase()}.create()\` invocation\nUnique constraint failed on the constraint: \`${constraint}\``,
    {
      code: 'P2002',
      clientVersion,
      meta: {
        modelName: table,
        driverAdapterError: {
          name: 'DriverAdapterError',
          cause: {
            originalCode: '23505',
            originalMessage: `duplicate key value violates unique constraint "${constraint}"`,
            kind: 'UniqueConstraintViolation',
            constraint: { index: constraint },
            table,
          },
        },
      },
    },
  );

const expiredTransaction = (operation: 'commit' | 'query') =>
  new Prisma.PrismaClientKnownRequestError(
    `Transaction API error: A ${operation} cannot be executed on an expired transaction. The timeout for this transaction was 200 ms, however 615 ms passed since the start of the transaction. Consider increasing the interactive transaction timeout or doing less work in the transaction.`,
    {
      code: 'P2028',
      clientVersion,
      meta: { operation, timeout: 200, timeTaken: 615 },
    },
  );

describe('isAccountUsernameConflict', () => {
  it('recognizes the real P2002 on Account.username (adapter-pg shape)', () => {
    expect(
      isAccountUsernameConflict(
        uniqueViolation('Account_username_key', 'Account'),
      ),
    ).toBe(true);
  });

  it('recognizes the legacy engine shape (meta.target lists the field)', () => {
    const error = new Prisma.PrismaClientKnownRequestError('Unique constraint', {
      code: 'P2002',
      clientVersion,
      meta: { modelName: 'Account', target: ['username'] },
    });
    expect(isAccountUsernameConflict(error)).toBe(true);
  });

  it('falls back to the constraint name in the message', () => {
    const error = new Prisma.PrismaClientKnownRequestError(
      'Unique constraint failed on the constraint: `Account_username_key`',
      { code: 'P2002', clientVersion },
    );
    expect(isAccountUsernameConflict(error)).toBe(true);
  });

  it.each([
    ['another Account constraint', uniqueViolation('Account_pkey', 'Account')],
    [
      'a unique violation on another table',
      uniqueViolation('Device_identifier_key', 'Device'),
    ],
    [
      'a username target on another model',
      new Prisma.PrismaClientKnownRequestError('Unique constraint', {
        code: 'P2002',
        clientVersion,
        meta: { modelName: 'Member', target: ['username'] },
      }),
    ],
    [
      'a different Prisma code that mentions the constraint',
      new Prisma.PrismaClientKnownRequestError(
        'Foreign key constraint failed on the field: `Account_username_key`',
        { code: 'P2003', clientVersion },
      ),
    ],
    ['an expired transaction', expiredTransaction('commit')],
    ['a plain Error', new Error('Account_username_key')],
    ['a non-error value', 'P2002'],
    ['undefined', undefined],
  ])('does not classify %s', (_label, error) => {
    expect(isAccountUsernameConflict(error)).toBe(false);
  });
});

describe('isTransactionExpired', () => {
  it.each([['commit' as const], ['query' as const]])(
    'recognizes the real P2028 raised by a %s on an expired transaction',
    (operation) => {
      expect(isTransactionExpired(expiredTransaction(operation))).toBe(true);
    },
  );

  it.each([
    [
      'the P2028 for a transaction that could not start in time',
      new Prisma.PrismaClientKnownRequestError(
        'Transaction API error: Unable to start a transaction in the given time.',
        { code: 'P2028', clientVersion, meta: { maxWait: 5000 } },
      ),
    ],
    [
      'a unique violation',
      uniqueViolation('Account_username_key', 'Account'),
    ],
    [
      'another Prisma code',
      new Prisma.PrismaClientKnownRequestError('Timed out fetching', {
        code: 'P2024',
        clientVersion,
      }),
    ],
    ['a plain Error that mentions the timeout', new Error('expired transaction')],
    ['a non-error value', 'P2028'],
    ['undefined', undefined],
  ])('does not classify %s', (_label, error) => {
    expect(isTransactionExpired(error)).toBe(false);
  });
});

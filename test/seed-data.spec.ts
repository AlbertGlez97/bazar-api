import { Prisma } from '../src/generated/prisma/client.js';
import {
  isRowLevelSecurityViolation,
  isSeedContextConflict,
  isUniqueViolationOnConstraint,
} from '../prisma/seed-data.js';

// Error shapes below were captured from a real Postgres 16 + Prisma 7.10 +
// @prisma/adapter-pg session running as a NON-superuser role (superusers
// bypass RLS, so they never produce the first shape).
const clientVersion = '7.10.0';

const rlsViolation = () =>
  new Prisma.PrismaClientKnownRequestError(
    'Invalid `prisma.member.upsert()` invocation:\n\nDatabase error. Code: `42501`. Message: `new row violates row-level security policy for table "Member"`',
    {
      code: 'P2039',
      clientVersion,
      meta: {
        driverAdapterError: {
          name: 'DriverAdapterError',
          cause: {
            originalCode: '42501',
            originalMessage:
              'new row violates row-level security policy for table "Member"',
            kind: 'postgres',
            code: '42501',
            severity: 'ERROR',
            message:
              'new row violates row-level security policy for table "Member"',
          },
        },
      },
    },
  );

const uniqueViolation = (constraint: string, table: string) =>
  new Prisma.PrismaClientKnownRequestError(
    `Invalid \`prisma.${table.toLowerCase()}.upsert()\` invocation:\n\nUnique constraint failed on the constraint: \`${constraint}\``,
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

describe('isRowLevelSecurityViolation', () => {
  it('recognizes the real Prisma 7 + adapter-pg RLS error (P2039 / 42501)', () => {
    expect(isRowLevelSecurityViolation(rlsViolation())).toBe(true);
  });

  it('recognizes it from the driver adapter cause alone, without relying on the message', () => {
    const error = new Prisma.PrismaClientKnownRequestError('opaque', {
      code: 'P2039',
      clientVersion,
      meta: {
        driverAdapterError: {
          cause: { originalCode: '42501', code: '42501', kind: 'postgres' },
        },
      },
    });
    expect(isRowLevelSecurityViolation(error)).toBe(true);
  });

  it('recognizes a plain Error whose message names the policy', () => {
    expect(
      isRowLevelSecurityViolation(
        new Error('new row violates row-level security policy for table "Device"'),
      ),
    ).toBe(true);
  });

  it.each([
    ['a unique violation', uniqueViolation('Member_pkey', 'Member')],
    ['a plain Error', new Error('boom')],
    ['a non-error value', 'nope'],
    ['undefined', undefined],
  ])('does not classify %s', (_label, error) => {
    expect(isRowLevelSecurityViolation(error)).toBe(false);
  });
});

describe('isUniqueViolationOnConstraint', () => {
  it('recognizes the real P2002 on the Member primary key', () => {
    expect(
      isUniqueViolationOnConstraint(
        uniqueViolation('Member_pkey', 'Member'),
        'Member_pkey',
      ),
    ).toBe(true);
  });

  it('recognizes the real P2002 on the Device identifier index', () => {
    expect(
      isUniqueViolationOnConstraint(
        uniqueViolation('Device_identifier_key', 'Device'),
        'Device_identifier_key',
      ),
    ).toBe(true);
  });

  it('falls back to the message when the adapter cause is missing', () => {
    const error = new Prisma.PrismaClientKnownRequestError(
      'Unique constraint failed on the constraint: `Member_pkey`',
      { code: 'P2002', clientVersion },
    );
    expect(isUniqueViolationOnConstraint(error, 'Member_pkey')).toBe(true);
  });

  it('does not classify a P2002 on a different constraint', () => {
    expect(
      isUniqueViolationOnConstraint(
        uniqueViolation('Device_identifier_key', 'Device'),
        'Member_pkey',
      ),
    ).toBe(false);
  });

  it('does not classify a different Prisma error code that mentions the constraint', () => {
    const error = new Prisma.PrismaClientKnownRequestError(
      'Foreign key constraint failed on the field: `Member_pkey`',
      { code: 'P2003', clientVersion },
    );
    expect(isUniqueViolationOnConstraint(error, 'Member_pkey')).toBe(false);
  });

  it.each([
    ['a plain Error', new Error('duplicate key value violates Member_pkey')],
    ['an RLS violation', rlsViolation()],
    ['undefined', undefined],
  ])('does not classify %s', (_label, error) => {
    expect(isUniqueViolationOnConstraint(error, 'Member_pkey')).toBe(false);
  });
});

describe('isSeedContextConflict', () => {
  it('accepts an RLS violation and a unique violation on the expected constraint', () => {
    expect(isSeedContextConflict(rlsViolation(), 'Member_pkey')).toBe(true);
    expect(
      isSeedContextConflict(uniqueViolation('Member_pkey', 'Member'), 'Member_pkey'),
    ).toBe(true);
  });

  it('rejects a unique violation on another constraint and unrelated errors', () => {
    expect(
      isSeedContextConflict(
        uniqueViolation('Device_identifier_key', 'Device'),
        'Member_pkey',
      ),
    ).toBe(false);
    expect(isSeedContextConflict(new Error('boom'), 'Member_pkey')).toBe(false);
  });
});

import {
  ConflictException,
  ForbiddenException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import type { JwtService } from '@nestjs/jwt';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../database/prisma.service.js';
import { hashPassword, verifyPassword } from '../common/password.js';
import { AuthService } from './auth.service.js';

// Stubbed Prisma and JWT: this pins the login outcome for stored hashes,
// without a database. The signed token is a fixed string.
function build(account: Record<string, unknown> | null) {
  const findUnique = vi.fn().mockResolvedValue(account);
  const signAsync = vi.fn().mockResolvedValue('signed.jwt');
  const service = new AuthService(
    { account: { findUnique } } as unknown as PrismaService,
    { signAsync } as unknown as JwtService,
  );
  return { service, signAsync };
}

describe('AuthService.login', () => {
  it('issues a token for the right password', async () => {
    const passwordHash = await hashPassword('right-pass');
    const { service, signAsync } = build({ id: 'acc-1', active: true, passwordHash });

    await expect(service.login('user', 'right-pass')).resolves.toMatchObject({
      accessToken: 'signed.jwt',
      tokenType: 'Bearer',
    });
    expect(signAsync).toHaveBeenCalledWith({ sub: 'acc-1' });
  });

  // A corrupt stored hash must fail closed as the same 401 as a wrong
  // password, never as a 500, and never issue a token.
  it.each(['garbage', '', '$argon2id$v=19$m=1$x'])(
    'answers 401 Invalid credentials for an account whose stored hash is malformed (%j)',
    async (passwordHash) => {
      const { service, signAsync } = build({ id: 'acc-1', active: true, passwordHash });

      const failure = service.login('user', 'anything');

      await expect(failure).rejects.toBeInstanceOf(UnauthorizedException);
      await expect(failure).rejects.toMatchObject({ message: 'Invalid credentials' });
      expect(signAsync).not.toHaveBeenCalled();
    },
  );

  it('answers the same 401 for an unknown user', async () => {
    const { service } = build(null);

    await expect(service.login('nobody', 'x')).rejects.toMatchObject({
      message: 'Invalid credentials',
    });
  });
});

// Stubbed Prisma: pins the change-password outcomes without a database. The
// account is read with `findFirst({ id, active: true })` and written with a
// conditional `updateMany` keyed on the previous hash.
function buildChange(
  account: Record<string, unknown> | null,
  updated = { count: 1 },
) {
  const findFirst = vi.fn().mockResolvedValue(account);
  const updateMany = vi.fn().mockResolvedValue(updated);
  const service = new AuthService(
    { account: { findFirst, updateMany } } as unknown as PrismaService,
    { signAsync: vi.fn() } as unknown as JwtService,
  );
  return { service, findFirst, updateMany };
}

describe('AuthService.changePassword', () => {
  it('stores an argon2id hash of the new password, keyed on the previous hash', async () => {
    const passwordHash = await hashPassword('current-secret-1');
    const { service, findFirst, updateMany } = buildChange({
      id: 'acc-1',
      active: true,
      passwordHash,
    });

    await expect(
      service.changePassword('acc-1', 'current-secret-1', 'brand-new-secret-2'),
    ).resolves.toBeUndefined();

    expect(findFirst).toHaveBeenCalledWith({
      where: { id: 'acc-1', active: true },
    });
    expect(updateMany).toHaveBeenCalledTimes(1);
    const [{ where, data }] = updateMany.mock.calls[0] as [
      { where: Record<string, unknown>; data: { passwordHash: string } },
    ];
    expect(where).toEqual({ id: 'acc-1', passwordHash });
    expect(data.passwordHash).toMatch(/^\$argon2id\$/);
    expect(data.passwordHash).not.toBe(passwordHash);
    await expect(
      verifyPassword(data.passwordHash, 'brand-new-secret-2'),
    ).resolves.toBe(true);
    // Only the hash is written: no password in the payload.
    expect(JSON.stringify(data)).not.toContain('brand-new-secret-2');
  });

  it('answers 403 (not 401) for a wrong current password and writes nothing', async () => {
    const passwordHash = await hashPassword('current-secret-1');
    const { service, updateMany } = buildChange({
      id: 'acc-1',
      active: true,
      passwordHash,
    });

    const failure = service.changePassword('acc-1', 'wrong', 'brand-new-secret-2');

    await expect(failure).rejects.toBeInstanceOf(ForbiddenException);
    await expect(failure).rejects.toMatchObject({
      message: 'Current password is incorrect',
    });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it.each(['garbage', '', '$argon2id$v=19$m=1$x'])(
    'treats a malformed stored hash (%j) as a wrong current password, not a 500',
    async (passwordHash) => {
      const { service, updateMany } = buildChange({
        id: 'acc-1',
        active: true,
        passwordHash,
      });

      await expect(
        service.changePassword('acc-1', 'anything', 'brand-new-secret-2'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(updateMany).not.toHaveBeenCalled();
    },
  );

  it('answers 401 when the account is not found or inactive', async () => {
    const { service, updateMany } = buildChange(null);

    await expect(
      service.changePassword('acc-1', 'x', 'brand-new-secret-2'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('answers 409 when another change won the race (no row matched the previous hash)', async () => {
    const passwordHash = await hashPassword('current-secret-1');
    const { service } = buildChange(
      { id: 'acc-1', active: true, passwordHash },
      { count: 0 },
    );

    const failure = service.changePassword(
      'acc-1',
      'current-secret-1',
      'brand-new-secret-2',
    );

    await expect(failure).rejects.toBeInstanceOf(ConflictException);
    await expect(failure).rejects.toMatchObject({
      message: expect.stringMatching(/changed by another request/i),
    });
  });

  it('never logs a password or a hash', async () => {
    const passwordHash = await hashPassword('current-secret-1');
    const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map(
      (level) => vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
    );
    const { service } = buildChange({ id: 'acc-1', active: true, passwordHash });

    await service.changePassword(
      'acc-1',
      'current-secret-1',
      'brand-new-secret-2',
    );
    await service
      .changePassword('acc-1', 'wrong-secret-3', 'brand-new-secret-2')
      .catch(() => undefined);

    const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
    for (const secret of [
      'current-secret-1',
      'brand-new-secret-2',
      'wrong-secret-3',
      passwordHash,
    ])
      expect(logged).not.toContain(secret);
    spies.forEach((spy) => spy.mockRestore());
  });
});

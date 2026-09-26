import { UnauthorizedException } from '@nestjs/common';
import type { JwtService } from '@nestjs/jwt';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../database/prisma.service.js';
import { hashPassword } from '../common/password.js';
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

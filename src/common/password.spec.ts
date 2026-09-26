import { Logger } from '@nestjs/common';
import * as argon2 from 'argon2';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hashPassword, verifyPassword } from './password.js';

// Wraps the real `verify` so a single test can make the library fail with an
// error that is not a malformed-hash TypeError.
vi.mock('argon2', async (importOriginal) => {
  const actual = await importOriginal<typeof import('argon2')>();
  return { ...actual, verify: vi.fn(actual.verify) };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('hashPassword / verifyPassword', () => {
  it('hashes with Argon2id in PHC string format', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash).toMatch(/^\$argon2id\$v=19\$/);
  });

  it('verifies the right password', async () => {
    const hash = await hashPassword('s3cret-pass');
    await expect(verifyPassword(hash, 's3cret-pass')).resolves.toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('s3cret-pass');
    await expect(verifyPassword(hash, 's3cret-pass ')).resolves.toBe(false);
    await expect(verifyPassword(hash, '')).resolves.toBe(false);
  });

  it('salts: two hashes of the same password differ and both verify', async () => {
    const [a, b] = await Promise.all([
      hashPassword('same-password'),
      hashPassword('same-password'),
    ]);
    expect(a).not.toBe(b);
    await expect(verifyPassword(a, 'same-password')).resolves.toBe(true);
    await expect(verifyPassword(b, 'same-password')).resolves.toBe(true);
  });

  // argon2.verify itself throws a TypeError on a malformed hash. A corrupt
  // stored hash must fail closed (no match), never surface as a 500.
  it.each(['garbage', '', '$argon2id$v=19$m=1$x'])(
    'returns false instead of throwing for the malformed hash %j',
    async (malformed) => {
      await expect(verifyPassword(malformed, 'anything')).resolves.toBe(false);
    },
  );

  it('returns false for a missing hash (e.g. a null column)', async () => {
    await expect(verifyPassword(null, 'anything')).resolves.toBe(false);
    await expect(verifyPassword(undefined, 'anything')).resolves.toBe(false);
  });

  it('does not log a malformed hash: that is expected input, not a fault', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await expect(verifyPassword('garbage', 'anything')).resolves.toBe(false);
    expect(error).not.toHaveBeenCalled();
  });

  it('fails closed AND logs an unexpected library failure, without leaking the hash or the password', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const stored = await hashPassword('s3cret-pass');
    vi.mocked(argon2.verify).mockRejectedValueOnce(new Error('memory allocation failed'));

    await expect(verifyPassword(stored, 'typed-password')).resolves.toBe(false);

    expect(error).toHaveBeenCalledTimes(1);
    const logged = String(error.mock.calls[0][0]);
    expect(logged).toContain('Error');
    expect(logged).toContain('memory allocation failed');
    expect(logged).not.toContain(stored);
    expect(logged).not.toContain('typed-password');
  });
});

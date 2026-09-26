import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './password.js';

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

  it('returns false for a non-string hash (e.g. a null column)', async () => {
    await expect(
      verifyPassword(null as unknown as string, 'anything'),
    ).resolves.toBe(false);
    await expect(
      verifyPassword(undefined as unknown as string, 'anything'),
    ).resolves.toBe(false);
  });
});

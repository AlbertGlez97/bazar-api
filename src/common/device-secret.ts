import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Length of a sha256 digest in lowercase hex. */
const HASH_HEX_LENGTH = 64;
const HASH_HEX_RE = /^[0-9a-f]{64}$/;

/**
 * A new device secret: 32 random bytes in base64url (43 characters). It is
 * shown to the device once and only its hash is stored. sha256 is enough
 * here (unlike a password) because the secret is high-entropy random, not a
 * human-chosen value, so there is nothing to brute force.
 */
export function generateDeviceToken(): string {
  return randomBytes(32).toString('base64url');
}

/** sha256 hex digest of a device token, the form kept in the database. */
export function hashDeviceToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Constant-time check of a presented token against the stored hash.
 *
 * Never throws: a non-string or empty token, or a stored hash that is
 * missing or not a 64-char lowercase hex digest, is simply "no match". The
 * digests are compared as equal-length buffers with `timingSafeEqual`, so the
 * comparison time does not reveal how much of the hash matched.
 */
export function verifyDeviceToken(
  token: unknown,
  storedHash: string | null | undefined,
): boolean {
  if (typeof token !== 'string' || token === '') return false;
  if (
    typeof storedHash !== 'string' ||
    storedHash.length !== HASH_HEX_LENGTH ||
    !HASH_HEX_RE.test(storedHash)
  ) {
    return false;
  }
  const presented = Buffer.from(hashDeviceToken(token), 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  return timingSafeEqual(presented, stored);
}

import { Logger } from '@nestjs/common';
import { argon2id, hash, verify } from 'argon2';

const logger = new Logger('Password');

/**
 * Hashes a password with Argon2id using the library defaults (the `argon2`
 * version pinned in package.json).
 * This is the only place that chooses the algorithm and its parameters, so
 * login, the seed, business approval and every later credential flow stay
 * in step. The result is a self-describing PHC string that carries its own
 * salt and parameters.
 */
export function hashPassword(plain: string): Promise<string> {
  return hash(plain, { type: argon2id });
}

/**
 * Checks a password against a stored Argon2 hash.
 *
 * `argon2.verify` throws a TypeError when the stored value is not a valid
 * hash (empty, truncated, not a PHC string). A corrupt or missing hash (a
 * null/undefined column included) must fail closed as "no match" instead of
 * surfacing as a server error, so it returns `false`.
 *
 * Any OTHER error from the library (a native binding or memory failure) also
 * fails closed, but it is logged once, so a systemic fault does not look like
 * users mistyping their passwords. Only the error class and message are
 * logged, never the stored hash or the password.
 *
 * Known limit: EVERY `TypeError` is classified as "malformed stored hash" and
 * stays silent, because the library reports that case as a bare TypeError with
 * no distinguishing code. A different TypeError from the library (for example
 * an argument-shape failure) is therefore not logged either.
 */
export async function verifyPassword(
  storedHash: string | null | undefined,
  plain: string,
): Promise<boolean> {
  if (typeof storedHash !== 'string') return false;
  try {
    return await verify(storedHash, plain);
  } catch (error) {
    if (!(error instanceof TypeError)) {
      const name = error instanceof Error ? error.name : typeof error;
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Unexpected password verification failure: ${name}: ${message}`);
    }
    return false;
  }
}

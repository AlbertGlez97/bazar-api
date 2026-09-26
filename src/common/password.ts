import { argon2id, hash, verify } from 'argon2';

/**
 * Hashes a password with Argon2id using the library defaults (argon2 0.45.1).
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
 * hash (empty, truncated, not a PHC string). A corrupt or missing hash must
 * fail closed as "no match" instead of surfacing as a server error, so
 * malformed input returns `false`.
 */
export async function verifyPassword(
  storedHash: string,
  plain: string,
): Promise<boolean> {
  if (typeof storedHash !== 'string') return false;
  try {
    return await verify(storedHash, plain);
  } catch {
    return false;
  }
}

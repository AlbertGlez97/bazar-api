import { randomBytes } from 'node:crypto';

/** Name of the authorized Device created together with a new business. */
export const INITIAL_DEVICE_NAME = 'Dispositivo principal';

// Conservative on purpose: a plain `local@domain.tld` with no whitespace,
// commas, angle brackets or quotes, so a free-text contact such as
// "a@b.com, c@d.com" or "Name <a@b.com>" is never used as a recipient (no
// header/multi-recipient tricks) and phone numbers never match.
const EMAIL_PATTERN = /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
const MAX_EMAIL_LENGTH = 254;
// `LoginDto.username` accepts at most 100 characters.
const MAX_USERNAME_LENGTH = 100;
const MAX_SLUG_LENGTH = 30;
const USERNAME_ATTEMPTS = 5;

/**
 * The socio's stored `correo`, normalized as a recipient. Returns the
 * trimmed, lower-cased address when it looks like a single plain email,
 * otherwise `undefined` (the credentials then go to the approver, see
 * {@link EmailService}). Requests created through the API always carry a real
 * email; the `undefined` outcome covers legacy rows (empty `correo`, created
 * before the correo/telefono split) and the rare address the API accepts but
 * this conservative pattern does not (e.g. an apostrophe in the local part).
 */
export function normalizeSocioEmail(correo: string): string | undefined {
  const value = correo.trim().toLowerCase();
  if (value.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(value))
    return undefined;
  return value;
}

/**
 * Temporary first-login password: 18 random bytes (144 bits) as base64url
 * (24 url-safe characters), derived from nothing the requester supplied.
 */
export function generateTemporaryPassword(): string {
  return randomBytes(18).toString('base64url');
}

/** Lower-case ASCII slug of a business name, at most 30 characters. */
export function slugifyBusinessName(nombreNegocio: string): string {
  const slug = nombreNegocio
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/^-+|-+$/g, '');
  return slug || 'negocio';
}

/**
 * Picks the username of the founding socio's Account, which is globally
 * unique (`Account.username` is `@unique`, and login resolves the account
 * by it before any tenant is known):
 *
 * 1. the normalized `correo` when it is usable (short enough for the login
 *    limit) and not taken yet — the most memorable choice;
 * 2. otherwise `<business-slug>-<6 random hex>`, retried with a fresh
 *    suffix while taken. Never derived from the socio's name alone.
 *
 * `isTaken` is checked here for a friendly fallback; the unique constraint
 * still has the last word if two approvals ever race for the same value.
 */
export async function deriveUniqueUsername(
  input: { correo: string; nombreNegocio: string },
  isTaken: (username: string) => Promise<boolean>,
): Promise<string> {
  const email = normalizeSocioEmail(input.correo);
  if (
    email &&
    email.length <= MAX_USERNAME_LENGTH &&
    !(await isTaken(email))
  )
    return email;

  const slug = slugifyBusinessName(input.nombreNegocio);
  for (let attempt = 0; attempt < USERNAME_ATTEMPTS; attempt++) {
    const candidate = `${slug}-${randomBytes(3).toString('hex')}`;
    if (!(await isTaken(candidate))) return candidate;
  }
  throw new Error('Could not derive a unique username');
}

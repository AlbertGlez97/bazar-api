import { randomBytes } from 'node:crypto';
import { sha256Hex } from '../common/canonical-json.js';

/** An invitation link works for 72 hours. */
export const INVITATION_TTL_MS = 72 * 60 * 60 * 1000;
/** At most this many invitations per socio in the last 24 hours (the first one included). */
export const INVITATION_MAX_PER_DAY = 3;
/** Minimum time between two invitations for the same socio. */
export const INVITATION_MIN_GAP_MS = 60 * 1000;

/** 32 random bytes as base64url: exactly 43 URL-safe characters. */
export const INVITATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function hashInvitationToken(token: string): string {
  return sha256Hex(token);
}

/** A fresh single-use token. Only `hash` is ever stored; `token` goes into the emailed link. */
export function generateInvitationToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashInvitationToken(token) };
}

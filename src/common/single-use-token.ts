import { randomBytes } from 'node:crypto';
import { sha256Hex } from './canonical-json.js';

/** 32 random bytes as base64url: exactly 43 URL-safe characters. */
export const SINGLE_USE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** The only thing ever stored about a link token: its SHA-256. */
export function hashSingleUseToken(token: string): string {
  return sha256Hex(token);
}

/** A fresh link token. Only `hash` is stored; `token` goes into the emailed link and nowhere else. */
export function generateSingleUseToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashSingleUseToken(token) };
}

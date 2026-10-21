import {
  SINGLE_USE_TOKEN_PATTERN,
  generateSingleUseToken,
  hashSingleUseToken,
} from '../common/single-use-token.js';

/** An invitation link works for 72 hours. */
export const INVITATION_TTL_MS = 72 * 60 * 60 * 1000;
/** At most this many invitations per socio in the last 24 hours (the first one included). */
export const INVITATION_MAX_PER_DAY = 3;
/** At most this many people a socio can invite for the first time in 24 hours (resends not counted). */
export const INVITATION_MAX_NEW_PER_DAY = 10;
/** Minimum time between two invitations for the same socio. */
export const INVITATION_MIN_GAP_MS = 60 * 1000;

/** 32 random bytes as base64url: exactly 43 URL-safe characters. */
export const INVITATION_TOKEN_PATTERN = SINGLE_USE_TOKEN_PATTERN;

export const hashInvitationToken = hashSingleUseToken;

/** A fresh single-use token. Only `hash` is ever stored; `token` goes into the emailed link. */
export const generateInvitationToken = generateSingleUseToken;

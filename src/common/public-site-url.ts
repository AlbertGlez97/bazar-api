import { stripQueryAndFragment, trimTrailingSlashes } from './url-parts.js';

/**
 * Public origin of the FRONTEND, for the links in emails. Null in production when it is not
 * configured (a link built from a guess could point somewhere else); a local address elsewhere.
 */
export function publicSiteUrl(): string | null {
  const configured = process.env.PUBLIC_SITE_URL?.trim();
  if (configured) return trimTrailingSlashes(stripQueryAndFragment(configured));
  return process.env.NODE_ENV === 'production' ? null : 'http://localhost:5173';
}

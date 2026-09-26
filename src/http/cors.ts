import type { NestExpressApplication } from '@nestjs/platform-express';

/**
 * Validates one `ALLOWED_ORIGIN` entry and returns it unchanged.
 *
 * Browsers send `Origin` as the normalized origin (lower-case scheme and
 * host, no default port, no path), and the CORS middleware compares strings
 * exactly. An entry that differs from its own normalized origin can therefore
 * never match: the API would start fine and the browser would block every
 * request. Those entries are rejected here, with the origin to use instead.
 */
function assertExactOrigin(entry: string): string {
  if (entry.includes('*')) {
    throw new Error(
      `ALLOWED_ORIGIN must list exact origins; a wildcard (*) is not allowed (entry "${entry}")`,
    );
  }

  let url: URL;
  try {
    url = new URL(entry);
  } catch {
    throw new Error(
      `ALLOWED_ORIGIN entry "${entry}" is not a valid origin URL; expected scheme and host, for example https://site.example`,
    );
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`ALLOWED_ORIGIN entry "${entry}" must use http or https`);
  }

  if (url.origin !== entry) {
    throw new Error(
      `ALLOWED_ORIGIN entry "${entry}" is not an exact origin and would never match a browser Origin header; use "${url.origin}"`,
    );
  }

  return entry;
}

/**
 * Parses `ALLOWED_ORIGIN`: a comma-separated list of exact origins
 * (scheme + host + optional non-default port, no path). Entries are trimmed,
 * a trailing slash is dropped and empty entries are ignored; every remaining
 * entry must already be an exact origin (see `assertExactOrigin`).
 */
function parseAllowedOrigins(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter((origin) => origin !== '')
    .map(assertExactOrigin);
}

/**
 * Enables CORS for an explicit allow-list of browser origins, only when
 * `ALLOWED_ORIGIN` is set.
 *
 * It is opt-in on purpose: with the variable blank or absent this function
 * registers nothing, so the same-origin flow (the Vite dev proxy, curl,
 * server-to-server calls) behaves exactly as before and no
 * `Access-Control-*` header is ever sent. A frontend served from another
 * origin (for example a Netlify site talking to a public or tunneled API)
 * needs its origin listed here, or the browser blocks every request.
 *
 * A wildcard is refused: this API carries real authentication, and
 * `Access-Control-Allow-Origin: *` would let any website's scripts call it
 * from a visitor's browser.
 *
 * Only the headers the API actually reads are allowed (`Authorization`,
 * `Content-Type`, `x-member-id`, `x-device-id` and, BE-12, `x-device-token`,
 * the secret a device activated through the one-time flow presents on every
 * request). Credentials/cookies are not used (the session travels in
 * `Authorization`), so they stay off.
 *
 * @throws Error at startup if an entry contains `*`, is not a valid http(s)
 * URL, or is not an exact origin (path, upper-case letters, explicit default
 * port, query, credentials), so a misconfigured deployment fails loudly
 * instead of silently opening the API to any origin or silently blocking
 * every browser request.
 */
export function configureCors(app: NestExpressApplication): void {
  const origins = parseAllowedOrigins(process.env.ALLOWED_ORIGIN);
  if (origins.length === 0) return;

  app.enableCors({
    origin: origins,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Authorization',
      'Content-Type',
      'x-member-id',
      'x-device-id',
      'x-device-token',
    ],
    credentials: false,
    maxAge: 600,
  });
}

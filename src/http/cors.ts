import type { NestExpressApplication } from '@nestjs/platform-express';

/**
 * Parses `ALLOWED_ORIGIN`: a comma-separated list of exact origins
 * (scheme + host + optional port, no path). Entries are trimmed, a trailing
 * slash is dropped and empty entries are ignored.
 */
function parseAllowedOrigins(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter((origin) => origin !== '');
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
 * `Content-Type`, `x-member-id`, `x-device-id`). Credentials/cookies are not
 * used (the session travels in `Authorization`), so they stay off.
 *
 * @throws Error at startup if the list contains `*`, so a misconfigured
 * deployment fails loudly instead of silently opening the API to any origin.
 */
export function configureCors(app: NestExpressApplication): void {
  const origins = parseAllowedOrigins(process.env.ALLOWED_ORIGIN);
  if (origins.length === 0) return;

  if (origins.includes('*')) {
    throw new Error(
      'ALLOWED_ORIGIN must list exact origins; a wildcard (*) is not allowed',
    );
  }

  app.enableCors({
    origin: origins,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Authorization',
      'Content-Type',
      'x-member-id',
      'x-device-id',
    ],
    credentials: false,
    maxAge: 600,
  });
}

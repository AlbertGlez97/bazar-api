import { escapeHtml } from '../common/escape-html.js';

/**
 * Tiny, dependency-free HTML page renderer for the business-registration
 * approve/reject endpoints (BE-11). These links are opened straight from
 * an email client by a human, not called by a frontend API client, so a
 * raw JSON error body would be a broken user experience — every outcome
 * (success, already processed, expired, invalid) gets its own simple,
 * self-contained status page instead.
 *
 * Both `title` and `message` are treated as plain text and escaped here, at
 * the render boundary, because callers interpolate public form input (the
 * business name) into them: callers must pass raw text and never
 * pre-escape it, or it would be escaped twice.
 */
export function renderStatusPage(title: string, message: string): string {
  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message);
  return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <title>${safeTitle}</title>
  </head>
  <body style="font-family: sans-serif; max-width: 480px; margin: 80px auto; text-align: center;">
    <h1>${safeTitle}</h1>
    <p>${safeMessage}</p>
  </body>
</html>`;
}

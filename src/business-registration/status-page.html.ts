/**
 * Tiny, dependency-free HTML page renderer for the business-registration
 * approve/reject endpoints (BE-11). These links are opened straight from
 * an email client by a human, not called by a frontend API client, so a
 * raw JSON error body would be a broken user experience — every outcome
 * (success, already processed, expired, invalid) gets its own simple,
 * self-contained status page instead.
 */
export function renderStatusPage(title: string, message: string): string {
  return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <title>${title}</title>
  </head>
  <body style="font-family: sans-serif; max-width: 480px; margin: 80px auto; text-align: center;">
    <h1>${title}</h1>
    <p>${message}</p>
  </body>
</html>`;
}

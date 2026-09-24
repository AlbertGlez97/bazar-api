/**
 * Escapes untrusted text before interpolating it into HTML (element content
 * or a quoted attribute value). Shared by every place that builds HTML from
 * user-derived data (status pages, emails) so there is a single, tested
 * implementation.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

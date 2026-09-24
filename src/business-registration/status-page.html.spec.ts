import { describe, expect, it } from 'vitest';
import { renderStatusPage } from './status-page.html.js';

describe('renderStatusPage', () => {
  it('escapes markup in both the title and the message', () => {
    const html = renderStatusPage(
      '<img src=x onerror=alert(1)>',
      '"<script>alert(1)</script>" & \'co\'',
    );

    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&quot;');
    expect(html).toContain('&amp;');
    expect(html).toContain('&#39;');
  });

  it('keeps plain Spanish text readable (accents are not escaped)', () => {
    const html = renderStatusPage('Enlace inválido', 'Este enlace ya expiró.');

    expect(html).toContain('<title>Enlace inválido</title>');
    expect(html).toContain('<p>Este enlace ya expiró.</p>');
  });
});

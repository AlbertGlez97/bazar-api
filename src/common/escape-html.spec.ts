import { describe, expect, it } from 'vitest';
import { escapeHtml } from './escape-html.js';

describe('escapeHtml', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    );
  });

  it('escapes the ampersand first so entities are not produced twice', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });

  it('leaves plain text (including accents) untouched', () => {
    expect(escapeHtml('Bonsáis del Alberto 123')).toBe(
      'Bonsáis del Alberto 123',
    );
  });
});

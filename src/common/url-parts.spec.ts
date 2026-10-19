import { describe, expect, it } from 'vitest';
import { maskEmail } from './text-sanitize.js';
import {
  stripQueryAndFragment,
  stripTrailingApiPrefix,
  trimTrailingSlashes,
} from './url-parts.js';

// Las expresiones regulares de ANTES, como referencia. Se usan solo aquí, con cadenas cortas
// (con cadenas largas son justamente las que tardaban segundos).
const referenceStrip = (value: string) => value.replace(/[?#].*$/, '');
const referenceTrim = (value: string) => value.replace(/\/+$/, '');
const referenceApi = (value: string) => value.replace(/\/api\/v1$/i, '');
const referenceMask = (email: string) => {
  const match = /^([^@\s])[^@\s]*@([^@\s.])[^@\s]*(\.[^@\s]+)$/.exec(email);
  return match ? `${match[1]}***@${match[2]}***${match[3]}` : '***';
};

/** Todas las cadenas de hasta `maxLength` caracteres sobre `alphabet`. */
function* allStrings(alphabet: readonly string[], maxLength: number): Generator<string> {
  yield '';
  let current = [''];
  for (let length = 1; length <= maxLength; length += 1) {
    const next: string[] = [];
    for (const prefix of current) {
      for (const char of alphabet) {
        const value = prefix + char;
        next.push(value);
        yield value;
      }
    }
    current = next;
  }
}

describe('recortes de URL: iguales a las expresiones de antes en TODAS las cadenas cortas', () => {
  const alphabet = ['/', '?', '#', 'a', '\n', '\r', ' ', ' '] as const;

  it('stripQueryAndFragment (incluidos los saltos de línea)', () => {
    let checked = 0;
    for (const value of allStrings(alphabet, 6)) {
      expect(stripQueryAndFragment(value), JSON.stringify(value)).toBe(referenceStrip(value));
      checked += 1;
    }
    expect(checked).toBeGreaterThan(290_000);
  });

  it('trimTrailingSlashes', () => {
    for (const value of allStrings(['/', 'a', '?', '\n'], 8)) {
      expect(trimTrailingSlashes(value), JSON.stringify(value)).toBe(referenceTrim(value));
    }
  });

  it('stripTrailingApiPrefix (sin distinguir mayúsculas)', () => {
    for (const value of ['/api/v1', '/API/V1', '/Api/v1', 'x/api/v1', '/api/v1/', '/api/v', 'api/v1', '', '/', '/api/v1/api/v1', '/api/v12', 'https://a.test/Api/V1']) {
      expect(stripTrailingApiPrefix(value), value).toBe(referenceApi(value));
    }
  });
});

/** Cadenas donde la implementación nueva y la de referencia dan distinto (debe quedar vacío). */
function mismatches(alphabet: readonly string[], maxLength: number): { checked: number; bad: string[] } {
  const bad: string[] = [];
  let checked = 0;
  for (const value of allStrings(alphabet, maxLength)) {
    checked += 1;
    if (maskEmail(value) !== referenceMask(value)) bad.push(JSON.stringify(value));
  }
  return { checked, bad: bad.slice(0, 5) };
}

describe('maskEmail: igual que la expresión de antes en TODAS las cadenas cortas', () => {
  it('alfabeto de arroba, punto, letras, espacio y salto de línea (hasta 7 caracteres)', () => {
    const { checked, bad } = mismatches(['@', '.', 'a', 'b', ' ', '\n'], 7);

    expect(bad).toEqual([]);
    expect(checked).toBeGreaterThan(335_000);
  });

  it('con símbolos de uso real: guion, más, eñe y emoji (hasta 6 caracteres)', () => {
    const { bad } = mismatches(['@', '.', 'a', '-', '+', 'ñ', '😀'], 6);

    expect(bad).toEqual([]);
  });
});

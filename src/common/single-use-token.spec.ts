import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SINGLE_USE_TOKEN_PATTERN,
  generateSingleUseToken,
  hashSingleUseToken,
} from './single-use-token.js';
import { publicSiteUrl } from './public-site-url.js';

describe('single-use tokens', () => {
  it('son de 43 caracteres seguros para una dirección, distintos cada vez, y solo se guarda su hash', () => {
    const a = generateSingleUseToken();
    const b = generateSingleUseToken();
    expect(a.token).toMatch(SINGLE_USE_TOKEN_PATTERN);
    expect(a.token).not.toBe(b.token);
    expect(a.hash).toBe(hashSingleUseToken(a.token));
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.hash).not.toContain(a.token);
  });

  it('el patrón rechaza lo que no es un token', () => {
    for (const bad of ['', 'corto', 'A'.repeat(42), 'A'.repeat(44), `${'A'.repeat(42)}!`, `${'A'.repeat(42)} `])
      expect(bad).not.toMatch(SINGLE_USE_TOKEN_PATTERN);
  });
});

describe('publicSiteUrl', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('usa la dirección configurada, sin diagonal final, sin parámetros ni ancla', () => {
    vi.stubEnv('PUBLIC_SITE_URL', ' https://marchanta.example/?x=1#y ');
    expect(publicSiteUrl()).toBe('https://marchanta.example');
  });

  it('en producción sin configurar no inventa una dirección', () => {
    vi.stubEnv('PUBLIC_SITE_URL', '');
    vi.stubEnv('NODE_ENV', 'production');
    expect(publicSiteUrl()).toBeNull();
  });

  it('fuera de producción cae en la dirección local', () => {
    vi.stubEnv('PUBLIC_SITE_URL', '');
    vi.stubEnv('NODE_ENV', 'test');
    expect(publicSiteUrl()).toBe('http://localhost:5173');
  });
});

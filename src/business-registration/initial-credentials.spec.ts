import { describe, expect, it, vi } from 'vitest';
import {
  deriveUniqueUsername,
  generateTemporaryPassword,
  normalizeEmailContact,
  slugifyBusinessName,
} from './initial-credentials.js';

describe('normalizeEmailContact', () => {
  it.each([
    ['alberto@example.com', 'alberto@example.com'],
    ['  Alberto.Gomez+bazar@Example.COM  ', 'alberto.gomez+bazar@example.com'],
    ['a@b.co', 'a@b.co'],
  ])('accepts %j as an email', (contact, normalized) => {
    expect(normalizeEmailContact(contact)).toBe(normalized);
  });

  it.each([
    '555-000-0000',
    '+52 55 1234 5678',
    'alberto@',
    '@example.com',
    'alberto@example',
    'a b@example.com',
    'a@example.com, b@example.com',
    'Alberto <a@example.com>',
    '<b>a@example.com</b>',
    `${'a'.repeat(250)}@example.com`,
  ])('does not treat %j as an email', (contact) => {
    expect(normalizeEmailContact(contact)).toBeUndefined();
  });
});

describe('generateTemporaryPassword', () => {
  it('is url-safe, long enough and different every time', () => {
    const passwords = new Set(
      Array.from({ length: 50 }, () => generateTemporaryPassword()),
    );

    expect(passwords.size).toBe(50);
    for (const password of passwords) {
      expect(password).toMatch(/^[A-Za-z0-9_-]{22,}$/);
    }
  });
});

describe('slugifyBusinessName', () => {
  it.each([
    ['Bolsas de Adid', 'bolsas-de-adid'],
    ['Bonsáis del Ñandú!!', 'bonsais-del-nandu'],
    ['  --  ', 'negocio'],
    ['<script>alert(1)</script>', 'script-alert-1-script'],
    ['x'.repeat(100), 'x'.repeat(30)],
  ])('turns %j into %j', (input, slug) => {
    expect(slugifyBusinessName(input)).toBe(slug);
  });
});

describe('deriveUniqueUsername', () => {
  const never = () => Promise.resolve(false);

  it('uses the normalized email when it is free', async () => {
    await expect(
      deriveUniqueUsername(
        { contactoSocio: ' Socio@Example.com ', nombreNegocio: 'Bolsas' },
        never,
      ),
    ).resolves.toBe('socio@example.com');
  });

  it('falls back to a business slug plus a random suffix when the contact is not an email', async () => {
    const username = await deriveUniqueUsername(
      { contactoSocio: '555-000-0000', nombreNegocio: 'Bolsas de Adid' },
      never,
    );

    expect(username).toMatch(/^bolsas-de-adid-[0-9a-f]{6}$/);
  });

  it('falls back to the slug when the email-derived username is already taken', async () => {
    const taken = new Set(['socio@example.com']);
    const isTaken = vi.fn((u: string) => Promise.resolve(taken.has(u)));

    const username = await deriveUniqueUsername(
      { contactoSocio: 'Socio@example.com', nombreNegocio: 'Bolsas' },
      isTaken,
    );

    expect(username).toMatch(/^bolsas-[0-9a-f]{6}$/);
    expect(isTaken).toHaveBeenCalledWith('socio@example.com');
  });

  it('retries with a new suffix when a generated candidate is taken', async () => {
    let calls = 0;
    const isTaken = () => Promise.resolve(++calls <= 2);

    const username = await deriveUniqueUsername(
      { contactoSocio: '555', nombreNegocio: 'Bolsas' },
      isTaken,
    );

    expect(username).toMatch(/^bolsas-[0-9a-f]{6}$/);
    expect(calls).toBe(3);
  });

  it('does not use an email longer than the login limit (100) as username', async () => {
    const long = `${'a'.repeat(95)}@example.com`;

    const username = await deriveUniqueUsername(
      { contactoSocio: long, nombreNegocio: 'Bolsas' },
      never,
    );

    expect(username).toMatch(/^bolsas-[0-9a-f]{6}$/);
  });

  it('gives up instead of looping forever when everything is taken', async () => {
    await expect(
      deriveUniqueUsername(
        { contactoSocio: '555', nombreNegocio: 'Bolsas' },
        () => Promise.resolve(true),
      ),
    ).rejects.toThrow(/unique username/i);
  });
});

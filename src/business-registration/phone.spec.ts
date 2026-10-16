import { describe, expect, it } from 'vitest';
import { normalizeMexicanPhone, whatsappUrl } from './phone.js';

describe('normalizeMexicanPhone', () => {
  it.each([
    ['5512345678', '5512345678'],
    ['55 1234 5678', '5512345678'],
    ['55-1234-5678', '5512345678'],
    ['55 1234-5678', '5512345678'],
    ['+52 55 1234 5678', '5512345678'],
    ['+52 5512345678', '5512345678'],
    ['+525512345678', '5512345678'],
    ['  +52-55-1234-5678  ', '5512345678'],
    ['2221234567', '2221234567'],
  ])('acepta %s y lo guarda como %s', (input, expected) => {
    expect(normalizeMexicanPhone(input)).toBe(expected);
  });

  it.each([
    '',
    '   ',
    '123',
    '551234567',
    '55123456789',
    '0512345678',
    '1512345678',
    '(55) 1234 5678',
    '55.1234.5678',
    'ext. 22',
    '55 1234 5678 ext 3',
    '+1 555 123 4567',
    '+52 1 55 1234 5678',
    '52 55 1234 5678',
    '5512345678a',
    '+5255123456789',
    '+++525512345678',
  ])('rechaza %j', (input) => {
    expect(normalizeMexicanPhone(input)).toBeUndefined();
  });

  it('rechaza lo que no es texto', () => {
    expect(normalizeMexicanPhone(5512345678 as unknown as string)).toBeUndefined();
    expect(normalizeMexicanPhone(undefined as unknown as string)).toBeUndefined();
  });
});

describe('whatsappUrl: wa.me con 52 + 10 dígitos y un mensaje codificado', () => {
  it('arma https://wa.me/52XXXXXXXXXX?text=... con el mensaje en español codificado', () => {
    const url = whatsappUrl('5512345678', 'Ana', 'Bonsáis de Alberto');
    const parsed = new URL(url);

    expect(parsed.origin).toBe('https://wa.me');
    expect(parsed.pathname).toBe('/525512345678');
    const text = parsed.searchParams.get('text')!;
    expect(text).toContain('Hola Ana');
    expect(text).toContain('Bonsáis de Alberto');
    expect(text).toContain('quiero confirmar unos datos');
  });

  it('el texto va codificado (sin espacios ni signos sueltos en la URL)', () => {
    const url = whatsappUrl('5512345678', 'Ana', 'Tacos & más');

    expect(url).not.toMatch(/\s/);
    expect(url).toContain('Tacos%20%26%20m%C3%A1s');
    expect(url.split('?')).toHaveLength(2);
  });

  it('un nombre con & = # ? no rompe la URL ni agrega parámetros', () => {
    const url = whatsappUrl('5512345678', 'A&B=C#D?E', 'N&x=1');
    const parsed = new URL(url);

    expect([...parsed.searchParams.keys()]).toEqual(['text']);
    expect(parsed.hash).toBe('');
  });

  it('no incluye enlaces de mapas ni de redes sociales', () => {
    const url = whatsappUrl('5512345678', 'Ana', 'Negocio');

    expect(url).not.toMatch(/maps|goo\.gl|facebook|instagram|tiktok/i);
  });

  it('solo acepta un teléfono normalizado de 10 dígitos', () => {
    expect(() => whatsappUrl('55 1234', 'Ana', 'N')).toThrow();
    expect(() => whatsappUrl('+525512345678', 'Ana', 'N')).toThrow();
  });
});

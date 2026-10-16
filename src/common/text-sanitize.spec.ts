import { describe, expect, it } from 'vitest';
import { cleanText, maskEmail, maskPhone } from './text-sanitize.js';

describe('cleanText: texto libre no confiable', () => {
  it('recorta y junta los espacios repetidos', () => {
    expect(cleanText('  Bonsáis   de   Alberto ')).toBe('Bonsáis de Alberto');
  });

  it('cambia saltos de línea y tabuladores por un espacio', () => {
    expect(cleanText('línea uno\nlínea\tdos\r\ntres')).toBe(
      'línea uno línea dos tres',
    );
  });

  it('quita los caracteres de control (C0, DEL y C1)', () => {
    expect(cleanText('a\u0000b\u0007c\u007fd\u0085e\u009ff')).toBe('abcdef');
  });

  it('quita los de dirección de texto y los de ancho cero, que sirven para engañar', () => {
    expect(cleanText('abc‮def​ghi﻿jkl⁦mno')).toBe(
      'abcdefghijklmno',
    );
  });

  it('deja intactos acentos, ñ, emojis y signos', () => {
    expect(cleanText('Piñatas y dulces 🎉 ¿hoy?')).toBe('Piñatas y dulces 🎉 ¿hoy?');
  });

  it('no toca el HTML: el escape se hace al mostrarlo, no aquí', () => {
    expect(cleanText('<b>hola</b> & "adiós"')).toBe('<b>hola</b> & "adiós"');
  });

  it('un valor que no es texto se devuelve igual para que lo rechace el validador', () => {
    expect(cleanText(42 as unknown)).toBe(42);
    expect(cleanText(undefined as unknown)).toBeUndefined();
  });

  it('un texto solo de basura queda vacío', () => {
    expect(cleanText(' \u0000​\n ')).toBe('');
  });
});

describe('máscaras para los logs (nunca el correo ni el teléfono completos)', () => {
  it('maskEmail deja solo la primera letra y el dominio acortado', () => {
    expect(maskEmail('alberto@example.com')).toBe('a***@e***.com');
    expect(maskEmail('a@b.mx')).toBe('a***@b***.mx');
  });

  it('maskEmail con algo que no es correo no revela nada', () => {
    expect(maskEmail('texto raro')).toBe('***');
    expect(maskEmail('')).toBe('***');
  });

  it('maskPhone deja solo los últimos 2 dígitos', () => {
    expect(maskPhone('5512345678')).toBe('********78');
    expect(maskPhone('')).toBe('***');
  });

  it('las máscaras no contienen el valor original', () => {
    expect(maskEmail('alberto@example.com')).not.toContain('alberto');
    expect(maskPhone('5512345678')).not.toContain('123456');
  });
});

// PRUEBAS DE CARACTERIZACIÓN: fijan lo que hacen HOY cleanText, maskEmail y maskPhone para que la
// reescritura (sin expresiones con retroceso) no cambie nada observable. Las salidas se
// obtuvieron ejecutando la implementación anterior, no a mano.
import { describe, expect, it } from 'vitest';
import { cleanText, maskEmail, maskPhone } from './text-sanitize.js';

describe('maskEmail: caracterización', () => {
  it.each([
    ['alberto@example.com', 'a***@e***.com'],
    ['a@b.mx', 'a***@b***.mx'],
    ['ana.pérez@ejemplo.com.mx', 'a***@e***.mx'],
    ['ÁNGEL@piñata.mx', 'Á***@p***.mx'],
    ['x@y.co', 'x***@y***.co'],
    ['a+tag@sub.example.co.uk', 'a***@s***.uk'],
    ['a@b.c.d.e', 'a***@b***.e'],
    ['a@b.c.d', 'a***@b***.d'],
    ['a@1.2', 'a***@1***.2'],
    ['a@b..c', 'a***@b***.c'],
    ['a@b.-c', 'a***@b***.-c'],
    ['a@-b.com', 'a***@-***.com'],
    ['a@b.😀', 'a***@b***.😀'],
    ['a@b.c.', 'a***@b***.c.'],
    ['a@b.c..', 'a***@b***..'],
    ['a'.repeat(64) + '@' + 'b'.repeat(63) + '.com', 'a***@b***.com'],
  ])('%s -> %s', (email, masked) => {
    expect(maskEmail(email)).toBe(masked);
  });

  it('con emojis recorta por unidad UTF-16, igual que antes (primera mitad del par)', () => {
    expect(maskEmail('😀@b.com')).toBe('\ud83d***@b***.com');
    expect(maskEmail('a@😀.com')).toBe('a***@\ud83d***.com');
  });

  it.each([
    'a@b.',
    'a@b',
    'a@.com',
    '@b.com',
    'a@@b.com',
    'a@b@c.com',
    'a b@c.com',
    'a@b c.com',
    ' a@b.com',
    'a@b.com ',
    'a@b.c\n',
    'user@localhost',
    '',
    '***',
    'texto raro',
  ])('"%s" no es un correo reconocible: no revela nada', (value) => {
    expect(maskEmail(value)).toBe('***');
  });
});

describe('maskPhone: caracterización', () => {
  it.each([
    ['5512345678', '********78'],
    ['55 1234 5678', '********78'],
    ['+52 55 1234 5678', '**********78'],
    ['+52-55-1234-5678', '**********78'],
    ['(55) 1234-5678', '********78'],
    ['123', '***'],
    ['', '***'],
    ['abc', '***'],
    ['1234', '**34'],
  ])('%s -> %s', (phone, masked) => {
    expect(maskPhone(phone)).toBe(masked);
  });
});

describe('cleanText: caracterización', () => {
  it.each([
    ['Bonsáis de Alberto', 'Bonsáis de Alberto'],
    ['  Bonsáis   de   Alberto ', 'Bonsáis de Alberto'],
    ['Ñandú y piñata', 'Ñandú y piñata'],
    ['Pastelería 🎂 Dulce', 'Pastelería 🎂 Dulce'],
    ['línea uno\nlínea\tdos\r\ntres', 'línea uno línea dos tres'],
    ['a\u0000b\u001Fc\u007Fd\u0085e\u009Ff', 'abcdef'],
    ['a​b‮c⁦d⁩e﻿f', 'abcdef'],
    ['<b onclick="x()">Tienda</b> & "Co" \'1\'', '<b onclick="x()">Tienda</b> & "Co" \'1\''],
    ['', ''],
    ['   ', ''],
    ['\n\n\t', ''],
    ['a    b', 'a b'],
    ['a \n b', 'a b'],
    [' a ', 'a'], // trim() también quita el espacio de no separación en los bordes
    ['a  b', 'a  b'], // adentro NO se junta: solo los espacios normales
  ])('%j -> %j', (input, output) => {
    expect(cleanText(input)).toBe(output);
  });

  it('lo que no es texto vuelve igual para que lo rechace el validador', () => {
    expect(cleanText(42)).toBe(42);
    expect(cleanText(null)).toBeNull();
    expect(cleanText(undefined)).toBeUndefined();
    const objeto = { a: 1 };
    expect(cleanText(objeto)).toBe(objeto);
  });

  it('un texto en el máximo permitido (400) pasa entero', () => {
    const max = 'x'.repeat(400);

    expect(cleanText(max)).toBe(max);
  });
});

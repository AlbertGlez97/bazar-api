import { describe, expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CreateBusinessRegistrationDto,
  INVALID_CORREO_MESSAGE,
  LONG_CORREO_MESSAGE,
} from './create-business-registration.dto.js';

const valid = {
  nombreNegocio: 'Bonsáis de Alberto',
  nombre: 'Alberto',
  apellidos: 'Gómez Pérez',
  correo: 'alberto@example.com',
};

// Same options as the controller's ValidationPipe.
const check = async (body: unknown) => {
  const dto = plainToInstance(
    CreateBusinessRegistrationDto,
    body as Record<string, unknown>,
  );
  const errors = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return {
    dto,
    properties: errors.map((error) => error.property),
    messages: errors.flatMap((error) => Object.values(error.constraints ?? {})),
  };
};

describe('CreateBusinessRegistrationDto', () => {
  it('accepts the required fields without telefono', async () => {
    const { properties, dto } = await check(valid);

    expect(properties).toEqual([]);
    expect(dto.telefono).toBeUndefined();
  });

  it('accepts a telefono with no strict format', async () => {
    for (const telefono of ['555-123-4567', '+52 (55) 1234 5678', 'ext. 22']) {
      const { properties } = await check({ ...valid, telefono });
      expect(properties, telefono).toEqual([]);
    }
  });

  it.each(['nombreNegocio', 'nombre', 'apellidos', 'correo'])(
    'requires %s (missing, empty and blank are rejected)',
    async (field) => {
      const { [field]: _omitted, ...rest } = valid as Record<string, string>;
      for (const body of [rest, { ...rest, [field]: '' }, { ...rest, [field]: '   ' }]) {
        const { properties } = await check(body);
        expect(properties).toContain(field);
      }
    },
  );

  it.each([
    ['nombreNegocio', 201],
    ['nombre', 101],
    ['apellidos', 101],
    ['telefono', 31],
  ])('rejects %s longer than its limit', async (field, length) => {
    const { properties } = await check({ ...valid, [field]: 'a'.repeat(length) });

    expect(properties).toContain(field);
  });

  it.each([
    ['nombreNegocio', 200],
    ['nombre', 100],
    ['apellidos', 100],
    ['telefono', 30],
  ])('accepts %s at exactly its limit', async (field, length) => {
    const { properties } = await check({ ...valid, [field]: 'a'.repeat(length) });

    expect(properties).toEqual([]);
  });

  it('rejects a blank telefono when present', async () => {
    for (const telefono of ['', '   ', null, 5551234]) {
      const { properties } = await check({ ...valid, telefono });
      expect(properties, String(telefono)).toContain('telefono');
    }
  });

  it.each([
    'not-an-email',
    'alberto@',
    '@example.com',
    'alberto@example',
    'a b@example.com',
    'a@example.com, b@example.com',
    '555-123-4567',
    'ana@example..com',
    'ana@@example.com',
  ])('rejects the invalid correo %j with a clear Spanish message', async (correo) => {
    const { properties, messages } = await check({ ...valid, correo });

    expect(properties).toContain('correo');
    expect(messages).toContain(INVALID_CORREO_MESSAGE);
  });

  it('rejects a missing or blank correo with the same clear message', async () => {
    const { correo: _omitted, ...missing } = valid;
    for (const body of [missing, { ...valid, correo: '   ' }]) {
      const { messages } = await check(body);
      expect(messages).toContain(INVALID_CORREO_MESSAGE);
    }
  });

  it('rejects a correo longer than 254 characters', async () => {
    const correo = `${'a'.repeat(64)}@${'b'.repeat(60)}.${'c'.repeat(60)}.${'d'.repeat(60)}.example.com`;
    expect(correo.length).toBeGreaterThan(254);

    const { properties, messages } = await check({ ...valid, correo });

    expect(properties).toContain('correo');
    expect(messages).toEqual([LONG_CORREO_MESSAGE]);
  });

  it('accepts a correo of exactly 254 characters', async () => {
    const correo = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(57)}.com`;
    expect(correo.length).toBe(254);

    const { properties } = await check({ ...valid, correo });

    expect(properties).toEqual([]);
  });

  it('trims surrounding whitespace of nombre, apellidos, correo and telefono', async () => {
    const { properties, dto } = await check({
      ...valid,
      nombre: '  Alberto ',
      apellidos: ' Gómez ',
      correo: '  alberto@example.com ',
      telefono: ' 555-1 ',
    });

    expect(properties).toEqual([]);
    expect(dto).toMatchObject({
      nombre: 'Alberto',
      apellidos: 'Gómez',
      correo: 'alberto@example.com',
      telefono: '555-1',
    });
  });

  it('rejects the removed nombreSocio and contactoSocio fields as unknown', async () => {
    const legacy = await check({
      ...valid,
      nombreSocio: 'Alberto',
      contactoSocio: 'alberto@example.com',
    });

    expect(legacy.properties).toEqual(
      expect.arrayContaining(['nombreSocio', 'contactoSocio']),
    );
  });
});

import { describe, expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CreateBusinessRegistrationDto,
  INVALID_CORREO_MESSAGE,
  INVALID_TELEFONO_MESSAGE,
} from './create-business-registration.dto.js';

const valid = {
  nombreNegocio: 'Bonsáis de Alberto',
  tipoNegocio: 'plantas_y_jardineria',
  queVende: 'Bonsáis y macetas hechas a mano',
  nombre: 'Alberto',
  apellidos: 'Gómez Pérez',
  correo: 'alberto@example.com',
  telefono: '55 1234 5678',
  aceptaLegal: true,
  versionLegal: '2026-10-16',
  turnstileToken: 'token-de-turnstile',
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

describe('CreateBusinessRegistrationDto: datos obligatorios', () => {
  it('acepta una solicitud completa y guarda el teléfono normalizado a 10 dígitos', async () => {
    const { properties, dto } = await check(valid);

    expect(properties).toEqual([]);
    expect(dto.telefono).toBe('5512345678');
  });

  it('los opcionales pueden faltar o venir vacíos', async () => {
    for (const extra of [{}, { dondeVende: '', recomendadoPor: '' }, { dondeVende: '   ' }]) {
      const { properties, dto } = await check({ ...valid, ...extra });
      expect(properties, JSON.stringify(extra)).toEqual([]);
      expect(dto.dondeVende).toBeUndefined();
    }
  });

  it.each([
    'nombreNegocio',
    'tipoNegocio',
    'queVende',
    'nombre',
    'apellidos',
    'correo',
    'telefono',
    'aceptaLegal',
    'versionLegal',
    'turnstileToken',
  ])('exige %s (falta, vacío o en blanco se rechazan)', async (field) => {
    const { [field]: _omitted, ...rest } = valid as Record<string, unknown>;
    for (const body of [rest, { ...rest, [field]: '' }, { ...rest, [field]: '   ' }]) {
      const { properties } = await check(body);
      expect(properties, `${field}: ${JSON.stringify(body[field as keyof typeof body])}`).toContain(field);
    }
  });
});

describe('CreateBusinessRegistrationDto: límites de longitud', () => {
  it.each([
    ['nombreNegocio', 201, 200],
    ['nombre', 101, 100],
    ['apellidos', 101, 100],
    ['dondeVende', 201, 200],
    ['recomendadoPor', 121, 120],
  ])('%s: rechaza %i caracteres y acepta %i', async (field, over, ok) => {
    expect((await check({ ...valid, [field]: 'a'.repeat(over) })).properties).toContain(field);
    expect((await check({ ...valid, [field]: 'a'.repeat(ok) })).properties).toEqual([]);
  });

  it('queVende: de 10 a 400 caracteres', async () => {
    expect((await check({ ...valid, queVende: 'a'.repeat(9) })).properties).toContain('queVende');
    expect((await check({ ...valid, queVende: 'a'.repeat(10) })).properties).toEqual([]);
    expect((await check({ ...valid, queVende: 'a'.repeat(400) })).properties).toEqual([]);
    expect((await check({ ...valid, queVende: 'a'.repeat(401) })).properties).toContain('queVende');
  });

  it('la longitud cuenta DESPUÉS de limpiar: 9 letras rodeadas de espacios no llegan a 10', async () => {
    expect((await check({ ...valid, queVende: '   aaaaaaaaa   ' })).properties).toContain('queVende');
  });

  it('el token de Turnstile: hasta 2048 caracteres', async () => {
    expect((await check({ ...valid, turnstileToken: 'a'.repeat(2048) })).properties).toEqual([]);
    expect((await check({ ...valid, turnstileToken: 'a'.repeat(2049) })).properties).toContain('turnstileToken');
  });
});

describe('CreateBusinessRegistrationDto: tipo de negocio', () => {
  it.each([
    'bazar_o_tianguis',
    'abarrotes',
    'ropa_y_accesorios',
    'comida_y_bebidas',
    'plantas_y_jardineria',
    'artesanias',
    'servicios',
    'otro',
  ])('acepta %s', async (tipoNegocio) => {
    expect((await check({ ...valid, tipoNegocio })).properties).toEqual([]);
  });

  it.each(['joyería', 'OTRO', 'bazar', 7, null])('rechaza %j', async (tipoNegocio) => {
    expect((await check({ ...valid, tipoNegocio })).properties).toContain('tipoNegocio');
  });
});

describe('CreateBusinessRegistrationDto: teléfono de México', () => {
  it.each([
    ['5512345678', '5512345678'],
    ['55-1234-5678', '5512345678'],
    ['+52 55 1234 5678', '5512345678'],
  ])('acepta %s', async (telefono, stored) => {
    const { properties, dto } = await check({ ...valid, telefono });
    expect(properties).toEqual([]);
    expect(dto.telefono).toBe(stored);
  });

  it.each(['12345', '(55) 1234 5678', 'ext. 22', '+1 555 123 4567', '0512345678'])(
    'rechaza %j con un mensaje sencillo',
    async (telefono) => {
      const { properties, messages } = await check({ ...valid, telefono });
      expect(properties).toContain('telefono');
      expect(messages).toContain(INVALID_TELEFONO_MESSAGE);
    },
  );
});

describe('CreateBusinessRegistrationDto: correo', () => {
  it('acepta un correo bien escrito y lo recorta', async () => {
    const { properties, dto } = await check({ ...valid, correo: '  ana@x.com ' });
    expect(properties).toEqual([]);
    expect(dto.correo).toBe('ana@x.com');
  });

  it.each(['sin-arroba', 'a@', '@b.com', 'a b@c.com', `${'a'.repeat(250)}@x.com`])(
    'rechaza %j con un mensaje sencillo',
    async (correo) => {
      const { properties, messages } = await check({ ...valid, correo });
      expect(properties).toContain('correo');
      expect(messages).toContain(INVALID_CORREO_MESSAGE);
    },
  );
});

describe('CreateBusinessRegistrationDto: aceptación del aviso y los términos', () => {
  it('exige aceptaLegal === true', async () => {
    for (const aceptaLegal of [false, 'true', 1, null]) {
      expect((await check({ ...valid, aceptaLegal })).properties, String(aceptaLegal)).toContain('aceptaLegal');
    }
  });

  it.each(['2026-10-16', '2027-01-01', '2026-02-28'])('acepta la versión %s', async (versionLegal) => {
    expect((await check({ ...valid, versionLegal })).properties).toEqual([]);
  });

  it.each(['16-10-2026', '2026-13-01', '2026-02-30', 'hoy', '2026-1-1', '2026-10-16T00:00'])(
    'rechaza la versión %j',
    async (versionLegal) => {
      expect((await check({ ...valid, versionLegal })).properties).toContain('versionLegal');
    },
  );
});

describe('CreateBusinessRegistrationDto: texto no confiable', () => {
  it('limpia caracteres de control, invisibles y espacios repetidos antes de validar', async () => {
    const { dto, properties } = await check({
      ...valid,
      nombreNegocio: '  Tacos\u0000  de\n\tla‮ esquina ',
      queVende: 'Tacos\ny​   refrescos hechos al momento',
    });

    expect(properties).toEqual([]);
    expect(dto.nombreNegocio).toBe('Tacos de la esquina');
    expect(dto.queVende).toBe('Tacos y refrescos hechos al momento');
  });

  it('un nombre que solo tiene caracteres invisibles cuenta como vacío', async () => {
    expect((await check({ ...valid, nombre: '​​\u0000' })).properties).toContain('nombre');
  });

  it('el HTML se conserva como texto (se escapa al mostrarlo)', async () => {
    const { dto } = await check({ ...valid, nombreNegocio: '<script>alert(1)</script>' });
    expect(dto.nombreNegocio).toBe('<script>alert(1)</script>');
  });
});

describe('CreateBusinessRegistrationDto: campo trampa y campos de más', () => {
  it('acepta el campo trampa vacío o ausente', async () => {
    expect((await check({ ...valid, sitioWebEmpresa: '' })).properties).toEqual([]);
    expect((await check(valid)).properties).toEqual([]);
  });

  it('acepta que venga lleno (el servicio lo trata como robot sin avisarle)', async () => {
    const { properties, dto } = await check({ ...valid, sitioWebEmpresa: 'http://spam.example' });
    expect(properties).toEqual([]);
    expect(dto.sitioWebEmpresa).toBe('http://spam.example');
  });

  it('el campo trampa tiene tope de longitud', async () => {
    expect((await check({ ...valid, sitioWebEmpresa: 'a'.repeat(501) })).properties).toContain('sitioWebEmpresa');
  });

  it('rechaza campos que no existen (nada de enlaces de redes ni de mapas)', async () => {
    for (const extra of [{ instagram: '@x' }, { mapa: 'https://maps.google.com' }, { status: 'aprobado' }]) {
      expect((await check({ ...valid, ...extra })).properties, JSON.stringify(extra)).toContain(Object.keys(extra)[0]);
    }
  });
});

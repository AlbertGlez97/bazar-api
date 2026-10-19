import { describe, expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CreateProductDto,
  PatchProductDto,
  ProductListDto,
} from './product.dto.js';

// Same options as the controller's ValidationPipe.
const options = { whitelist: true, forbidNonWhitelisted: true };
const base = {
  name: 'Playera',
  tipo: 'cantidad',
  unitPriceMinor: 15000,
  initialStock: 3,
  purchaseCostMinor: 9000,
};

const create = async (extra: Record<string, unknown>) => {
  const dto = plainToInstance(CreateProductDto, { ...base, ...extra });
  const errors = await validate(dto, options);
  return { dto, properties: errors.map((error) => error.property) };
};
const patch = async (body: Record<string, unknown>) => {
  const dto = plainToInstance(PatchProductDto, body);
  const errors = await validate(dto, options);
  return { dto, properties: errors.map((error) => error.property) };
};
const list = async (query: Record<string, unknown>) => {
  const dto = plainToInstance(ProductListDto, query);
  const errors = await validate(dto, options);
  return { dto, properties: errors.map((error) => error.property) };
};

const FIELDS = [
  ['brand', 40],
  ['presentation', 40],
  ['description', 200],
] as const;

describe.each([
  ['crear', create],
  ['editar', patch],
] as const)('marca, presentación y descripción al %s', (label, run) => {

  it.each(FIELDS)('%s: ausente queda ausente (el producto viejo no cambia)', async (field) => {
    const { dto, properties } = await run(label === 'editar' ? { name: 'x' } : {});

    expect(properties).toEqual([]);
    expect((dto as Record<string, unknown>)[field]).toBeUndefined();
  });

  it.each(FIELDS)('%s: recorta y junta los espacios internos', async (field) => {
    const { dto, properties } = await run({ [field]: '  Azul   ·    28  ' });

    expect(properties).toEqual([]);
    expect((dto as Record<string, unknown>)[field]).toBe('Azul · 28');
  });

  it.each(FIELDS)('%s: vacío o solo espacios es null (borrar el dato)', async (field) => {
    for (const empty of ['', '   ', '\n\t ']) {
      const { dto, properties } = await run({ [field]: empty });

      expect(properties).toEqual([]);
      expect((dto as Record<string, unknown>)[field]).toBeNull();
    }
  });

  it.each(FIELDS)('%s: null explícito se acepta', async (field) => {
    const { dto, properties } = await run({ [field]: null });

    expect(properties).toEqual([]);
    expect((dto as Record<string, unknown>)[field]).toBeNull();
  });

  it.each(FIELDS)('%s: quita caracteres de control e invisibles', async (field) => {
    const { dto } = await run({ [field]: 'A\u0000​z‮' });

    expect((dto as Record<string, unknown>)[field]).toBe('Az');
  });

  it.each(FIELDS)('%s: un salto de línea se vuelve un espacio', async (field) => {
    const { dto } = await run({ [field]: 'uno\ndos\r\ntres' });

    expect((dto as Record<string, unknown>)[field]).toBe('uno dos tres');
  });

  it.each(FIELDS)('%s: el límite se mide DESPUÉS de limpiar', async (field, max) => {
    const exact = await run({ [field]: `  ${'x'.repeat(max)}  ` });
    const over = await run({ [field]: 'x'.repeat(max + 1) });
    const spacedOver = await run({ [field]: `${'x'.repeat(max - 1)}   y` });

    expect(exact.properties).toEqual([]);
    expect(over.properties).toEqual([field]);
    expect(spacedOver.properties).toEqual([field]);
  });

  it.each(FIELDS)('%s: algo que no es texto se rechaza', async (field) => {
    for (const value of [5, true, ['a'], { a: 1 }]) {
      const { properties } = await run({ [field]: value });

      expect(properties).toEqual([field]);
    }
  });
});

describe('PatchProductDto: editar solo los campos nuevos', () => {
  it('basta con uno de ellos', async () => {
    const { properties } = await patch({ brand: 'Nike' });

    expect(properties).toEqual([]);
  });
});

describe('ProductListDto: filtro por marca', () => {
  it('ausente queda ausente', async () => {
    const { dto, properties } = await list({});

    expect(properties).toEqual([]);
    expect(dto.brand).toBeUndefined();
  });

  it('se normaliza igual que al guardar (recorta y junta espacios)', async () => {
    const { dto, properties } = await list({ brand: '  Casa   Vieja ' });

    expect(properties).toEqual([]);
    expect(dto.brand).toBe('Casa Vieja');
  });

  it('vacío es "sin filtro", no "productos sin marca"', async () => {
    for (const empty of ['', '  ']) {
      const { dto, properties } = await list({ brand: empty });

      expect(properties).toEqual([]);
      expect(dto.brand).toBeUndefined();
    }
  });

  it('más de 40 caracteres se rechaza', async () => {
    const { properties } = await list({ brand: 'x'.repeat(41) });

    expect(properties).toEqual(['brand']);
  });
});

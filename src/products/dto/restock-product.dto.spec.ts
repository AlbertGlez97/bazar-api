import { describe, expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RestockProductDto } from './product.dto.js';

// Same options as the controller's ValidationPipe.
const check = async (body: Record<string, unknown>) => {
  const dto = plainToInstance(RestockProductDto, body);
  const errors = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return { dto, properties: errors.map((error) => error.property) };
};

describe('RestockProductDto', () => {
  it('accepts only a quantity', async () => {
    const { dto, properties } = await check({ quantity: 3 });

    expect(properties).toEqual([]);
    expect(dto.unitCostMinor).toBeUndefined();
    expect(dto.note).toBeUndefined();
  });

  it('accepts a unit cost (including 0) and a note', async () => {
    expect((await check({ quantity: 1, unitCostMinor: 0 })).properties).toEqual([]);
    const { dto, properties } = await check({
      quantity: 2,
      unitCostMinor: 1250,
      note: 'Compra del sábado',
    });

    expect(properties).toEqual([]);
    expect(dto.note).toBe('Compra del sábado');
  });

  it.each([
    ['missing', undefined],
    ['0', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['text', '3'],
    ['null', null],
    ['above the Int range', 2_147_483_648],
  ])('rejects a quantity that is %s', async (_label, quantity) => {
    const { properties } = await check({ quantity });

    expect(properties).toContain('quantity');
  });

  it.each([
    ['negative', -1],
    ['fractional', 10.5],
    ['text', '12'],
    ['above the Int range', 2_147_483_648],
  ])('rejects a unit cost that is %s', async (_label, unitCostMinor) => {
    const { properties } = await check({ quantity: 1, unitCostMinor });

    expect(properties).toEqual(['unitCostMinor']);
  });

  it('treats a null unit cost like an empty one', async () => {
    const { properties } = await check({ quantity: 1, unitCostMinor: null });

    expect(properties).toEqual([]);
  });

  it('trims the note and treats a blank one as absent', async () => {
    expect((await check({ quantity: 1, note: '  hola  ' })).dto.note).toBe('hola');
    const blank = await check({ quantity: 1, note: '   ' });

    expect(blank.properties).toEqual([]);
    expect(blank.dto.note).toBeUndefined();
  });

  it('rejects a note over 1000 characters and a non-text note', async () => {
    expect((await check({ quantity: 1, note: 'x'.repeat(1001) })).properties).toEqual(['note']);
    expect((await check({ quantity: 1, note: 5 })).properties).toEqual(['note']);
  });

  it.each(['contextId', 'stock', 'productId', 'type'])(
    'rejects the unknown field %s',
    async (field) => {
      const { properties } = await check({ quantity: 1, [field]: 'x' });

      expect(properties).toEqual([field]);
    },
  );
});

import { describe, expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ProductListDto } from './product.dto.js';

// Same options as the controller's ValidationPipe (forbidNonWhitelisted).
const check = async (query: Record<string, unknown>) => {
  const dto = plainToInstance(ProductListDto, query);
  const errors = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return { dto, properties: errors.map((error) => error.property) };
};

describe('ProductListDto catalog filters', () => {
  it('leaves every new filter absent when none is sent', async () => {
    const { dto, properties } = await check({});

    expect(properties).toEqual([]);
    expect(dto.agotados).toBeUndefined();
    expect(dto.sinCosto).toBeUndefined();
    expect(dto.tipo).toBeUndefined();
  });

  it.each(['agotados', 'sinCosto'] as const)(
    'parses %s=true / false from the query string',
    async (name) => {
      const on = await check({ [name]: 'true' });
      const off = await check({ [name]: 'false' });

      expect(on.properties).toEqual([]);
      expect(on.dto[name]).toBe(true);
      expect(off.properties).toEqual([]);
      expect(off.dto[name]).toBe(false);
    },
  );

  it.each(['agotados', 'sinCosto'] as const)(
    'treats an empty %s as absent',
    async (name) => {
      const { dto, properties } = await check({ [name]: '' });

      expect(properties).toEqual([]);
      expect(dto[name]).toBeUndefined();
    },
  );

  it.each(['agotados', 'sinCosto'] as const)(
    'rejects a non-boolean %s with a validation error',
    async (name) => {
      const { properties } = await check({ [name]: 'yes' });

      expect(properties).toEqual([name]);
    },
  );

  it.each(['unica', 'cantidad'])('accepts tipo=%s', async (tipo) => {
    const { dto, properties } = await check({ tipo });

    expect(properties).toEqual([]);
    expect(dto.tipo).toBe(tipo);
  });

  it('treats an empty tipo as absent', async () => {
    const { dto, properties } = await check({ tipo: '' });

    expect(properties).toEqual([]);
    expect(dto.tipo).toBeUndefined();
  });

  it.each(['otro', 'UNICA', '1'])('rejects tipo=%s', async (tipo) => {
    const { properties } = await check({ tipo });

    expect(properties).toEqual(['tipo']);
  });

  it('still rejects an unknown query parameter', async () => {
    const { properties } = await check({ agotado: 'true' });

    expect(properties).toEqual(['agotado']);
  });
});

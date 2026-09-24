import { describe, expect, it } from 'vitest';
import { validate, version } from 'uuid';
import { createServerId } from './server-id.js';

describe('createServerId', () => {
  it('creates UUIDv7 identifiers', () => {
    const id = createServerId();

    expect(validate(id)).toBe(true);
    expect(version(id)).toBe(7);
    expect(id[14]).toBe('7');
  });

  it('creates unique identifiers in temporal order', () => {
    const ids = Array.from({ length: 100 }, () => createServerId());

    expect(new Set(ids)).toHaveLength(ids.length);
    expect([...ids].sort()).toEqual(ids);
  });
});

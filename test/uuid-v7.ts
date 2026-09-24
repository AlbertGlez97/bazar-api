import { expect } from 'vitest';
import { validate, version } from 'uuid';

export function expectUuidV7(id: string): void {
  expect(validate(id)).toBe(true);
  expect(version(id)).toBe(7);
  expect(id[14]).toBe('7');
}

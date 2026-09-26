import { describe, expect, it } from 'vitest';
import {
  generateDeviceToken,
  hashDeviceToken,
  verifyDeviceToken,
} from './device-secret.js';

describe('generateDeviceToken', () => {
  it('is 32 random bytes in base64url (43 chars, URL-safe alphabet)', () => {
    const token = generateDeviceToken();
    expect(token).toHaveLength(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('never repeats over many calls', () => {
    const tokens = new Set(
      Array.from({ length: 2000 }, () => generateDeviceToken()),
    );
    expect(tokens.size).toBe(2000);
  });
});

describe('hashDeviceToken', () => {
  it('is a deterministic sha256 hex digest (64 lowercase hex chars)', () => {
    const hash = hashDeviceToken('some-token');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashDeviceToken('some-token')).toBe(hash);
  });

  it('matches the known sha256 of a fixed input', () => {
    expect(hashDeviceToken('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('gives a different hash for a different token', () => {
    expect(hashDeviceToken('a')).not.toBe(hashDeviceToken('b'));
  });

  it('does not contain the token itself', () => {
    const token = generateDeviceToken();
    expect(hashDeviceToken(token)).not.toContain(token);
  });
});

describe('verifyDeviceToken', () => {
  it('accepts the token whose hash is stored', () => {
    const token = generateDeviceToken();
    expect(verifyDeviceToken(token, hashDeviceToken(token))).toBe(true);
  });

  it('rejects another token and a near-miss', () => {
    const token = generateDeviceToken();
    const stored = hashDeviceToken(token);
    expect(verifyDeviceToken(generateDeviceToken(), stored)).toBe(false);
    expect(verifyDeviceToken(`${token} `, stored)).toBe(false);
    expect(verifyDeviceToken(token.slice(0, -1), stored)).toBe(false);
  });

  it('rejects the stored hash presented as if it were the token', () => {
    const token = generateDeviceToken();
    const stored = hashDeviceToken(token);
    expect(verifyDeviceToken(stored, stored)).toBe(false);
  });

  it.each([
    ['empty string', ''],
    ['undefined', undefined],
    ['null', null],
    ['a number', 42],
    ['an object', { token: 'x' }],
    ['an array', ['x']],
  ])('rejects %s as the presented token, without throwing', (_, presented) => {
    expect(verifyDeviceToken(presented, hashDeviceToken('x'))).toBe(false);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty string', ''],
    ['a short hash', 'abcd'],
    ['a too-long hash', 'a'.repeat(65)],
    ['a non-hex hash of the right length', 'z'.repeat(64)],
  ])(
    'rejects %s as the stored hash, without throwing',
    (_, storedHash) => {
      expect(verifyDeviceToken('some-token', storedHash)).toBe(false);
    },
  );
});

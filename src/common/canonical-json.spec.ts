import { canonicalDigest, canonicalJson, sha256Hex } from './canonical-json.js';

describe('canonicalJson', () => {
  it('sorts object keys recursively regardless of insertion order', () => {
    const a = { b: 1, a: { d: [1, 2], c: 'x' } };
    const b = { a: { c: 'x', d: [1, 2] }, b: 1 };
    expect(canonicalJson(a)).toBe('{"a":{"c":"x","d":[1,2]},"b":1}');
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it('keeps array order significant', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it('serializes primitives, null and unicode like JSON', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(-0)).toBe('0');
    expect(canonicalJson({ n: 'Ñandú "x" ☃ \n' })).toBe(
      JSON.stringify({ n: 'Ñandú "x" ☃ \n' }),
    );
    expect(canonicalJson({ ñ: 1, a: 2 })).toBe('{"a":2,"ñ":1}');
  });

  it('distinguishes null, empty string and missing information', () => {
    expect(canonicalJson({ note: null })).not.toBe(canonicalJson({ note: '' }));
  });

  it.each([
    ['undefined value', { a: undefined }],
    ['NaN', { a: Number.NaN }],
    ['Infinity', [Number.POSITIVE_INFINITY]],
    ['bigint', { a: 1n }],
    ['Date', { a: new Date(0) }],
    ['function', { a: () => 1 }],
    ['symbol', { a: Symbol('x') }],
    ['top-level undefined', undefined],
  ])('rejects %s', (_label, value) => {
    expect(() => canonicalJson(value)).toThrow(TypeError);
  });

  it('digests deterministically', () => {
    expect(canonicalDigest({ b: 1, a: 2 })).toBe(
      canonicalDigest({ a: 2, b: 1 }),
    );
    expect(canonicalDigest({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

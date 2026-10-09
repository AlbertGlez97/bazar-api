import { createHash } from 'node:crypto';

/**
 * Deterministic JSON serialization used to fingerprint documents: object keys
 * are sorted recursively (code-unit order), arrays keep their order and no
 * whitespace is emitted. Values JSON cannot represent faithfully (undefined,
 * NaN, Infinity, bigint, functions, symbols, class instances such as Date) are
 * rejected instead of silently dropped, so two different inputs can never
 * collapse into the same fingerprint.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, '$');
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** sha256 hex digest of the canonical JSON of `value`. */
export function canonicalDigest(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

function serialize(value: unknown, path: string): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value))
        throw new TypeError(
          `Canonical JSON rejects a non-finite number at ${path}`,
        );
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value))
        return `[${value.map((item, index) => serialize(item, `${path}[${index}]`)).join(',')}]`;
      const prototype: unknown = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null)
        throw new TypeError(
          `Canonical JSON rejects a non-plain object at ${path}`,
        );
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      return `{${keys
        .map(
          (key) =>
            `${JSON.stringify(key)}:${serialize(record[key], `${path}.${key}`)}`,
        )
        .join(',')}}`;
    }
    default:
      throw new TypeError(
        `Canonical JSON rejects a value of type ${typeof value} at ${path}`,
      );
  }
}

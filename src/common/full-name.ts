/**
 * "nombre apellidos" as one display name. Legacy registration rows have an
 * empty `apellidos` (their single old name column became `nombre`), so the
 * result is trimmed and never ends with a stray space.
 */
export function fullName(nombre: string, apellidos: string): string {
  return `${nombre} ${apellidos}`.trim();
}

// Recortes de URL en TIEMPO LINEAL (un solo recorrido, sin expresiones regulares con retroceso).
// Reemplazan a replace(/[?#].*$/, '') y replace(/\/+$/, ''), que con decenas de miles de
// caracteres (barras seguidas y un carácter final) tardaban segundos por retroceso super-lineal.

/** Saltos de línea que `.` no cruza en una expresión regular. */
const LINE_TERMINATORS = new Set(['\n', '\r', ' ', ' ']);

/**
 * Quita desde el primer "?" o "#" hasta el final (la query y el fragmento). Igual que
 * `value.replace(/[?#].*$/, '')`, incluida su regla con varias líneas: `.` no cruza un salto de
 * línea y `$` solo cae al final del texto, así que solo corta un "?" o "#" que quede DESPUÉS del
 * último salto de línea.
 */
export function stripQueryAndFragment(value: string): string {
  let start = 0;
  for (let i = value.length - 1; i >= 0; i -= 1) {
    if (LINE_TERMINATORS.has(value.charAt(i))) {
      start = i + 1;
      break;
    }
  }
  for (let i = start; i < value.length; i += 1) {
    const char = value.charAt(i);
    if (char === '?' || char === '#') return value.slice(0, i);
  }
  return value;
}

/** Quita las barras del final. Igual que `value.replace(/\/+$/, '')`. */
export function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
}

/** Quita un "/api/v1" final, sin distinguir mayúsculas. Igual que `value.replace(/\/api\/v1$/i, '')`. */
export function stripTrailingApiPrefix(value: string): string {
  const suffix = '/api/v1';
  return value.length >= suffix.length && value.slice(-suffix.length).toLowerCase() === suffix
    ? value.slice(0, -suffix.length)
    : value;
}

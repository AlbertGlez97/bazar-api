// Caracteres de control: C0 (0x00-0x1F, incluye salto de línea y tabulador), DEL y C1 (0x7F-0x9F).
// Se quitan los de dirección de texto (U+202A-202E, U+2066-2069) y los de ancho cero
// (U+200B-200F, U+2060, U+FEFF): sirven para disfrazar nombres en correos y pantallas.
const SPACING_CONTROLS = /[\t\n\r\v\f]+/g;
// oxlint-disable-next-line no-control-regex -- quitar caracteres de control es justamente el propósito
const CONTROLS = /[\u0000-\u001F\u007F-\u009F]/g;
const INVISIBLES = /[\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g;

/**
 * Limpia texto libre NO CONFIABLE que escribe una persona: sin caracteres de control ni
 * invisibles, con los saltos de línea y tabuladores convertidos en un espacio, los espacios
 * repetidos juntos y recortado. NO escapa HTML: el escape se hace al mostrarlo (correos y
 * páginas), nunca al guardar. Lo que no es texto se devuelve igual para que lo rechace el
 * validador.
 */
export function cleanText<T>(value: T): T | string {
  if (typeof value !== 'string') return value;
  return value
    .replace(SPACING_CONTROLS, ' ')
    .replace(CONTROLS, '')
    .replace(INVISIBLES, '')
    .replace(/ {2,}/g, ' ')
    .trim();
}

/** "alberto@example.com" -> "a***@e***.com": para los logs, nunca el correo completo. */
export function maskEmail(email: string): string {
  // Un recorrido sin expresiones con retroceso (la anterior, con `[^@\s]*` seguido de
  // `\.[^@\s]+$`, tardaba segundos con decenas de miles de puntos). Mismas reglas de antes: sin
  // espacios, una sola arroba con algo antes, el dominio no empieza con punto y termina en un
  // tramo ".algo" cuyo punto es el último que todavía tiene algún carácter detrás.
  if (/\s/.test(email)) return '***';
  const at = email.indexOf('@');
  if (at < 1 || at !== email.lastIndexOf('@')) return '***';
  const domain = email.slice(at + 1);
  if (domain.startsWith('.')) return '***';
  const dot = domain.lastIndexOf('.', domain.length - 2);
  if (dot < 0) return '***';
  return `${email.charAt(0)}***@${domain.charAt(0)}***${domain.slice(dot)}`;
}

/** "5512345678" -> "********78": para los logs, nunca el teléfono completo. */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 4) return '***';
  return `${'*'.repeat(digits.length - 2)}${digits.slice(-2)}`;
}

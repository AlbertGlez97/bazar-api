// PRUEBAS ADVERSARIALES: entradas patológicas contra las funciones de texto SIN pasar por el
// límite de los DTO (text-sanitize.ts es común y puede usarse en otros sitios). Una expresión
// con retroceso super-lineal tarda segundos con decenas de miles de caracteres; una lineal, un
// par de milisegundos. La cota (250 ms) deja holgura de sobra a una máquina lenta.
import { describe, expect, it } from 'vitest';
import { cleanText, maskEmail, maskPhone } from './text-sanitize.js';

const BUDGET_MS = 250;
const N = 50_000;

function timed<T>(fn: () => T): { result: T; ms: number } {
  const start = performance.now();
  const result = fn();
  return { result, ms: performance.now() - start };
}

describe('maskEmail: tiempo lineal con entradas patológicas', () => {
  it.each([
    ['muchos puntos y un espacio final (no cumple el patrón)', `a@b${'.c'.repeat(N)} `],
    ['muchos puntos y una arroba final', `a@b${'.c'.repeat(N)}@`],
    ['solo puntos después de la arroba y un espacio', `a@b${'.'.repeat(N)} `],
    ['un dominio larguísimo sin punto final válido', `a@${'b'.repeat(N)}`],
    ['una parte local larguísima sin arroba', 'a'.repeat(N)],
    ['muchas arrobas', `a${'@b'.repeat(N)}`],
    ['espacios por todas partes', `${' '.repeat(N)}@${' '.repeat(N)}`],
    ['un correo válido enorme', `a@b${'.c'.repeat(N)}`],
  ])('%s', (_label, input) => {
    const { ms } = timed(() => maskEmail(input));

    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it('un correo enorme y válido se enmascara igual que uno normal (primera letra, dominio acortado, último tramo)', () => {
    expect(maskEmail(`a@b${'.c'.repeat(N)}`)).toBe('a***@b***.c');
  });
});

describe('cleanText: tiempo lineal con entradas patológicas', () => {
  it.each([
    ['decenas de miles de espacios seguidos de un carácter', `${' '.repeat(N)}x`],
    ['espacios, un carácter y más espacios', `${' '.repeat(N)}x${' '.repeat(N)}`],
    ['espacios alternados con letras', 'a '.repeat(N)],
    ['dos espacios repetidos', '  '.repeat(N)],
    ['saltos de línea y tabuladores seguidos', '\n\t'.repeat(N)],
    ['caracteres invisibles seguidos', '​'.repeat(N)],
    ['controles seguidos de un carácter válido', `${'\u0000'.repeat(N)}x`],
  ])('%s', (_label, input) => {
    const { ms } = timed(() => cleanText(input));

    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it('y el resultado sigue siendo el correcto', () => {
    expect(cleanText(`${' '.repeat(N)}x${' '.repeat(N)}`)).toBe('x');
    expect(cleanText('a '.repeat(5))).toBe('a a a a a');
  });
});

describe('maskPhone: tiempo lineal con entradas patológicas', () => {
  it('decenas de miles de caracteres que no son dígitos', () => {
    const { ms } = timed(() => maskPhone(`${'-'.repeat(N)}1`));

    expect(ms).toBeLessThan(BUDGET_MS);
  });
});

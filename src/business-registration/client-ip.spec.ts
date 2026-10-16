import { afterEach, describe, expect, it, vi } from 'vitest';
import { clientIp } from './client-ip.js';

const req = (headers: Record<string, string>, remoteAddress = '172.18.0.5') =>
  ({ headers, socket: { remoteAddress } }) as never;

afterEach(() => vi.unstubAllEnvs());

describe('clientIp: de dónde sale la IP detrás del túnel de Cloudflare', () => {
  it('usa CF-Connecting-IP, que Cloudflare pone en cada petición', () => {
    expect(clientIp(req({ 'cf-connecting-ip': '203.0.113.7' }))).toBe('203.0.113.7');
  });

  it('acepta IPv6', () => {
    expect(clientIp(req({ 'cf-connecting-ip': '2001:db8::1' }))).toBe('2001:db8::1');
  });

  it('NO usa X-Forwarded-For (se puede escribir a mano)', () => {
    expect(
      clientIp(req({ 'x-forwarded-for': '198.51.100.9' }, '172.18.0.5')),
    ).toBe('172.18.0.5');
  });

  it('si la cabecera no es una IP válida, usa la dirección de la conexión', () => {
    expect(clientIp(req({ 'cf-connecting-ip': 'no-soy-ip' }))).toBe('172.18.0.5');
    expect(clientIp(req({ 'cf-connecting-ip': '1.2.3.4, 5.6.7.8' }))).toBe('172.18.0.5');
  });

  it('sin cabecera (desarrollo local) usa la dirección de la conexión', () => {
    expect(clientIp(req({}, '127.0.0.1'))).toBe('127.0.0.1');
  });

  it('quita el prefijo ::ffff: de las IPv4 mapeadas', () => {
    expect(clientIp(req({}, '::ffff:192.168.1.20'))).toBe('192.168.1.20');
  });

  it('sin ninguna de las dos devuelve "unknown" (una sola cubeta, nunca falla)', () => {
    expect(clientIp({ headers: {}, socket: {} } as never)).toBe('unknown');
  });

  it('la cabecera confiable se puede cambiar con CLIENT_IP_HEADER', () => {
    vi.stubEnv('CLIENT_IP_HEADER', 'x-real-ip');

    expect(clientIp(req({ 'x-real-ip': '203.0.113.50', 'cf-connecting-ip': '1.1.1.1' }))).toBe('203.0.113.50');
  });
});

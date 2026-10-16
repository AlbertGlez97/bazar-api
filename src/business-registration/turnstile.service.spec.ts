import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { TURNSTILE_VERIFY_URL, TurnstileService } from './turnstile.service.js';

const respond = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('TurnstileService con clave configurada', () => {
  beforeEach(() => vi.stubEnv('TURNSTILE_SECRET_KEY', 'test-secret-not-real'));

  it('llama a siteverify de Cloudflare con la clave, el token y la IP', async () => {
    fetchMock.mockResolvedValue(respond({ success: true }));

    const result = await new TurnstileService().verify('token-1', '203.0.113.7');

    expect(result).toBe('ok');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(TURNSTILE_VERIFY_URL);
    expect(TURNSTILE_VERIFY_URL).toBe(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
    );
    expect(init.method).toBe('POST');
    const body = new URLSearchParams(String(init.body));
    expect(body.get('secret')).toBe('test-secret-not-real');
    expect(body.get('response')).toBe('token-1');
    expect(body.get('remoteip')).toBe('203.0.113.7');
  });

  it('un token rechazado (usado, vencido o falso) da "invalid"', async () => {
    fetchMock.mockResolvedValue(
      respond({ success: false, 'error-codes': ['timeout-or-duplicate'] }),
    );

    expect(await new TurnstileService().verify('viejo', '1.2.3.4')).toBe('invalid');
  });

  it('sin token no llama a Cloudflare y da "invalid"', async () => {
    expect(await new TurnstileService().verify('', '1.2.3.4')).toBe('invalid');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('un token larguísimo ni se envía', async () => {
    expect(await new TurnstileService().verify('x'.repeat(3000), '1.2.3.4')).toBe('invalid');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('si Cloudflare no contesta o falla, da "unavailable" (503 amable), no "invalid"', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    expect(await new TurnstileService().verify('t', '1.2.3.4')).toBe('unavailable');

    fetchMock.mockResolvedValue(respond({}, 500));
    expect(await new TurnstileService().verify('t', '1.2.3.4')).toBe('unavailable');
  });

  it('una respuesta que no es JSON da "unavailable"', async () => {
    fetchMock.mockResolvedValue(new Response('<html>', { status: 200 }));

    expect(await new TurnstileService().verify('t', '1.2.3.4')).toBe('unavailable');
  });

  it('un error de configuración de Cloudflare (clave mala) da "unavailable" y lo registra', async () => {
    fetchMock.mockResolvedValue(
      respond({ success: false, 'error-codes': ['invalid-input-secret'] }),
    );
    const error = vi.spyOn(Logger.prototype, 'error');

    expect(await new TurnstileService().verify('t', '1.2.3.4')).toBe('unavailable');
    expect(error).toHaveBeenCalled();
  });

  it('pone un límite de tiempo a la llamada (no se queda colgado)', async () => {
    fetchMock.mockResolvedValue(respond({ success: true }));

    await new TurnstileService().verify('t', '1.2.3.4');

    expect(fetchMock.mock.calls[0]![1].signal).toBeInstanceOf(AbortSignal);
  });

  it('no escribe la clave ni el token en los logs', async () => {
    fetchMock.mockRejectedValue(new Error('boom'));
    const warn = vi.spyOn(Logger.prototype, 'warn');
    const error = vi.spyOn(Logger.prototype, 'error');

    await new TurnstileService().verify('token-secreto', '1.2.3.4');

    const logged = JSON.stringify([...warn.mock.calls, ...error.mock.calls]);
    expect(logged).not.toContain('test-secret-not-real');
    expect(logged).not.toContain('token-secreto');
  });
});

describe('TurnstileService sin clave configurada', () => {
  it('EN PRODUCCIÓN rechaza todo ("unavailable") y avisa en el log', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const error = vi.spyOn(Logger.prototype, 'error');

    expect(await new TurnstileService().verify('t', '1.2.3.4')).toBe('unavailable');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
    expect(String(error.mock.calls[0]![0])).toContain('TURNSTILE_SECRET_KEY');
  });

  it('en desarrollo, sin modo explícito, también rechaza (no se salta la verificación por descuido)', async () => {
    vi.stubEnv('NODE_ENV', 'development');

    expect(await new TurnstileService().verify('t', '1.2.3.4')).toBe('unavailable');
  });

  it('en desarrollo con TURNSTILE_DEV_BYPASS=true acepta cualquier token no vacío y lo avisa', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('TURNSTILE_DEV_BYPASS', 'true');
    const warn = vi.spyOn(Logger.prototype, 'warn');

    expect(await new TurnstileService().verify('cualquiera', '1.2.3.4')).toBe('ok');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it('EN PRODUCCIÓN el bypass no existe aunque la variable esté puesta', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('TURNSTILE_DEV_BYPASS', 'true');

    expect(await new TurnstileService().verify('t', '1.2.3.4')).toBe('unavailable');
  });

  it('el bypass sigue exigiendo un token (la verificación del formulario no se salta del todo)', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('TURNSTILE_DEV_BYPASS', 'true');

    expect(await new TurnstileService().verify('', '1.2.3.4')).toBe('invalid');
  });
});

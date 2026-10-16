import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import {
  REGISTRATION_RULES,
  RegistrationLimits,
  ipRateLimit,
} from './registration-limits.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const reqWith = (headers: Record<string, string>, remote = '172.18.0.9') =>
  ({ headers, socket: { remoteAddress: remote } }) as never;

function resMock() {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    set(name: string, value: string) {
      res.headers[name] = value;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
  };
  return res;
}

describe('REGISTRATION_RULES: los números acordados', () => {
  it('5 solicitudes/h por IP, 3 correos/h por correo, 10 verificaciones/h por IP', () => {
    expect(REGISTRATION_RULES.createPerIpPerHour).toBe(5);
    expect(REGISTRATION_RULES.verificationEmailsPerCorreoPerHour).toBe(3);
    expect(REGISTRATION_RULES.verifyPerIpPerHour).toBe(10);
  });

  it('reenvío: 60 s de espera y máximo 3 correos por solicitud', () => {
    expect(REGISTRATION_RULES.resendWaitMs).toBe(60_000);
    expect(REGISTRATION_RULES.maxVerificationEmailsPerRequest).toBe(3);
  });

  it('el enlace de verificación vence a las 48 h y el de aprobación a los 30 días', () => {
    expect(REGISTRATION_RULES.verificationTtlMs).toBe(48 * 60 * 60 * 1000);
    expect(REGISTRATION_RULES.approvalTtlMs).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it('limpieza: 7 días sin confirmar, 30 días rechazadas o vencidas', () => {
    expect(REGISTRATION_RULES.unconfirmedRetentionMs).toBe(7 * 24 * 60 * 60 * 1000);
    expect(REGISTRATION_RULES.rejectedOrExpiredRetentionMs).toBe(30 * 24 * 60 * 60 * 1000);
  });
});

describe('ipRateLimit (middleware)', () => {
  it('deja pasar hasta el límite y responde 429 con Retry-After en el siguiente', () => {
    const middleware = ipRateLimit(new RegistrationLimits(), 'create', 2);
    const next = vi.fn();
    const request = reqWith({ 'cf-connecting-ip': '203.0.113.5' });

    middleware(request, resMock() as never, next);
    middleware(request, resMock() as never, next);
    const blocked = resMock();
    middleware(request, blocked as never, next);

    expect(next).toHaveBeenCalledTimes(2);
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers['Retry-After'])).toBeGreaterThan(0);
    expect(blocked.body).toMatchObject({ statusCode: 429, code: 'rate_limited' });
  });

  it('cuenta por IP de CF-Connecting-IP, no por la conexión (que es siempre la del túnel)', () => {
    const middleware = ipRateLimit(new RegistrationLimits(), 'create', 1);
    const next = vi.fn();

    middleware(reqWith({ 'cf-connecting-ip': '203.0.113.1' }), resMock() as never, next);
    middleware(reqWith({ 'cf-connecting-ip': '203.0.113.2' }), resMock() as never, next);

    expect(next).toHaveBeenCalledTimes(2);
  });

  it('cada ruta tiene su propia cubeta', () => {
    const limits = new RegistrationLimits();
    const next = vi.fn();
    const request = reqWith({ 'cf-connecting-ip': '203.0.113.7' });

    ipRateLimit(limits, 'create', 1)(request, resMock() as never, next);
    ipRateLimit(limits, 'verify', 1)(request, resMock() as never, next);

    expect(next).toHaveBeenCalledTimes(2);
  });

  it('sin cabecera todos comparten la IP de la conexión: lo avisa UNA vez en producción', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const middleware = ipRateLimit(new RegistrationLimits(), 'create', 100);

    middleware(reqWith({}), resMock() as never, vi.fn());
    middleware(reqWith({}), resMock() as never, vi.fn());

    const messages = warn.mock.calls.map((call) => String(call[0]));
    expect(messages.filter((m) => m.includes('CF-Connecting-IP'))).toHaveLength(1);
  });

  it('con la cabecera presente no avisa', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    ipRateLimit(new RegistrationLimits(), 'create', 100)(
      reqWith({ 'cf-connecting-ip': '203.0.113.9' }),
      resMock() as never,
      vi.fn(),
    );

    expect(warn).not.toHaveBeenCalled();
  });

  it('fuera de producción (desarrollo local) tampoco avisa', () => {
    vi.stubEnv('NODE_ENV', 'development');
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    ipRateLimit(new RegistrationLimits(), 'create', 100)(reqWith({}), resMock() as never, vi.fn());

    expect(warn).not.toHaveBeenCalled();
  });

  it('el aviso no escribe la IP completa de nadie', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    ipRateLimit(new RegistrationLimits(), 'create', 100)(reqWith({}, '172.18.0.9'), resMock() as never, vi.fn());

    expect(JSON.stringify(warn.mock.calls)).not.toContain('172.18.0.9');
  });
});

describe('RegistrationLimits por correo', () => {
  it('deja mandar 3 correos de verificación por hora a un mismo correo, y el cuarto no', () => {
    const limits = new RegistrationLimits();

    expect([1, 2, 3, 4].map(() => limits.allowVerificationEmail('a@example.test'))).toEqual([true, true, true, false]);
  });

  it('cada correo lleva su cuenta', () => {
    const limits = new RegistrationLimits();
    for (let i = 0; i < 3; i += 1) limits.allowVerificationEmail('a@example.test');

    expect(limits.allowVerificationEmail('b@example.test')).toBe(true);
  });
});

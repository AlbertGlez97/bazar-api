// PRUEBAS ADVERSARIALES de la normalización de APP_BASE_URL y PUBLIC_SITE_URL: cadenas largas de
// barras o de "?" con un carácter final que rompe el patrón. Con una expresión de retroceso
// super-lineal tardan segundos; en tiempo lineal, milisegundos.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BusinessRegistrationService, apiBaseUrl } from './business-registration.service.js';
import { RegistrationLimits } from './registration-limits.js';
import type { RegistrationCleanupService } from './registration-cleanup.service.js';
import type { TurnstileService } from './turnstile.service.js';
import type { EmailService } from '../email/email.service.js';
import { FakeRegistrationDb } from '../../test/support/fake-registration-db.js';

const BUDGET_MS = 250;
const N = 50_000;

afterEach(() => vi.unstubAllEnvs());

const PATHOLOGICAL: [string, string][] = [
  ['muchas barras y un carácter final', `${'/'.repeat(N)}x`],
  ['https:// y muchas barras y un carácter final', `https://a.test${'/'.repeat(N)}x`],
  ['muchos "?" y un salto de línea final', `${'?'.repeat(N)}\n`],
  ['muchos "#" y un salto de línea final', `a${'#'.repeat(N)}\n`],
  ['"?" con salto de línea al final de cada tramo', `${'?x\n'.repeat(N / 3)}y`],
  ['barras y "?" mezclados', `${'/?'.repeat(N / 2)}\n`],
  ['barras seguidas de "/api/v1" y un carácter final', `${'/'.repeat(N)}/api/v1x`],
  ['solo barras', '/'.repeat(N)],
];

describe('apiBaseUrl: tiempo lineal con entradas patológicas', () => {
  it.each(PATHOLOGICAL)('%s', (_label, value) => {
    vi.stubEnv('APP_BASE_URL', value);
    const start = performance.now();

    apiBaseUrl();

    expect(performance.now() - start).toBeLessThan(BUDGET_MS);
  });

  it('y el resultado sigue siendo el correcto', () => {
    vi.stubEnv('APP_BASE_URL', `https://a.test${'/'.repeat(N)}`);
    expect(apiBaseUrl()).toBe('https://a.test');
    vi.stubEnv('APP_BASE_URL', `https://a.test/x${'/'.repeat(N)}y`);
    expect(apiBaseUrl()).toBe(`https://a.test/x${'/'.repeat(N)}y`);
  });
});

describe('PUBLIC_SITE_URL: tiempo lineal con entradas patológicas', () => {
  let service: BusinessRegistrationService;
  let sendVerification: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const db = new FakeRegistrationDb();
    sendVerification = vi.fn().mockResolvedValue(undefined);
    service = new BusinessRegistrationService(
      db.prisma,
      { sendRegistrationVerificationEmail: sendVerification } as unknown as EmailService,
      { verify: vi.fn().mockResolvedValue('ok') } as unknown as TurnstileService,
      new RegistrationLimits(),
      { runBatch: vi.fn().mockResolvedValue(0) } as unknown as RegistrationCleanupService,
    );
  });

  const register = (siteUrl: string, n: number) => {
    vi.stubEnv('PUBLIC_SITE_URL', siteUrl);
    return service.create(
      {
        nombreNegocio: 'Tienda',
        tipoNegocio: 'otro',
        queVende: 'Cosas de prueba',
        nombre: 'Ana',
        apellidos: 'Pérez',
        correo: `ana${n}@example.com`,
        telefono: '5512345678',
        aceptaLegal: true,
        versionLegal: '2026-10-19',
        turnstileToken: 't',
      } as never,
      '203.0.113.5',
    );
  };

  it.each(PATHOLOGICAL)('%s', async (_label, value) => {
    const start = performance.now();

    await register(value, 1);

    expect(performance.now() - start).toBeLessThan(BUDGET_MS);
  });

  it('y el enlace sigue saliendo bien', async () => {
    await register(`https://a.test${'/'.repeat(N)}`, 2);

    const { verifyUrl } = sendVerification.mock.calls.at(-1)![0] as { verifyUrl: string };
    expect(verifyUrl.startsWith('https://a.test/verificar-correo?token=')).toBe(true);
  });
});

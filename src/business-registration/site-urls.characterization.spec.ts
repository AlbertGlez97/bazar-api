// PRUEBAS DE CARACTERIZACIÓN de cómo se normalizan APP_BASE_URL (enlaces de aprobar/rechazar) y
// PUBLIC_SITE_URL (enlace de verificación): fijan las salidas de la implementación anterior para
// que reescribirla sin expresiones con retroceso no cambie nada observable.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BusinessRegistrationService, apiBaseUrl } from './business-registration.service.js';
import { RegistrationLimits } from './registration-limits.js';
import type { RegistrationCleanupService } from './registration-cleanup.service.js';
import type { TurnstileService } from './turnstile.service.js';
import type { EmailService } from '../email/email.service.js';
import { FakeRegistrationDb } from '../../test/support/fake-registration-db.js';

afterEach(() => vi.unstubAllEnvs());

describe('apiBaseUrl: caracterización', () => {
  it.each([
    ['https://marchanta.albertogdlc.org', 'https://marchanta.albertogdlc.org'],
    ['https://marchanta.albertogdlc.org/', 'https://marchanta.albertogdlc.org'],
    ['https://marchanta.albertogdlc.org///', 'https://marchanta.albertogdlc.org'],
    ['https://a.test/?x=1', 'https://a.test'],
    ['https://a.test/#frag', 'https://a.test'],
    ['https://a.test/path/?x=1#y', 'https://a.test/path'],
    ['https://a.test/api/v1', 'https://a.test'],
    ['https://a.test/API/v1/', 'https://a.test'],
    ['https://a.test/Api/V1///', 'https://a.test'],
    ['https://a.test/api/v1?x=1', 'https://a.test'],
    ['https://a.test/api/v1#f', 'https://a.test'],
    ['https://a.test/api/v1/api/v1', 'https://a.test/api/v1'],
    ['https://a.test/api', 'https://a.test/api'],
    ['http://localhost:5173', 'http://localhost:5173'],
    ['   https://a.test/   ', 'https://a.test'],
    ['/', ''],
    ['//', ''],
    ['?', ''],
    ['#', ''],
    ['a?b?c', 'a'],
    ['a#b?c', 'a'],
    ['a/?/', 'a'],
    ['a//?x//', 'a'],
    ['https://a.test/ñandú/', 'https://a.test/ñandú'],
    ['https://a.test/😀/', 'https://a.test/😀'],
    ['https://a.test/a b/', 'https://a.test/a b'],
    ['https://a.test/\n', 'https://a.test'],
    ['https://a.test\n/', 'https://a.test\n'],
    // con saltos de línea el "?" solo corta si no queda ningún salto de línea después de él
    ['a?b\nc', 'a?b\nc'],
    ['a\n?b', 'a\n'],
    ['a?b\r\n?c', 'a?b\r\n'],
    ['a#b #c', 'a#b '],
  ])('%j -> %j', (value, expected) => {
    vi.stubEnv('APP_BASE_URL', value);
    vi.stubEnv('PORT', '3100');

    expect(apiBaseUrl()).toBe(expected);
  });

  it('sin APP_BASE_URL usa el puerto local', () => {
    vi.stubEnv('APP_BASE_URL', '');
    vi.stubEnv('PORT', '3100');

    expect(apiBaseUrl()).toBe('http://localhost:3100');
  });
});

describe('PUBLIC_SITE_URL (enlace de verificación): caracterización', () => {
  let db: FakeRegistrationDb;
  let sendVerification: ReturnType<typeof vi.fn>;
  let service: BusinessRegistrationService;

  beforeEach(() => {
    db = new FakeRegistrationDb();
    sendVerification = vi.fn().mockResolvedValue(undefined);
    service = new BusinessRegistrationService(
      db.prisma,
      { sendRegistrationVerificationEmail: sendVerification } as unknown as EmailService,
      { verify: vi.fn().mockResolvedValue('ok') } as unknown as TurnstileService,
      new RegistrationLimits(),
      { runBatch: vi.fn().mockResolvedValue(0) } as unknown as RegistrationCleanupService,
    );
  });

  const linkFor = async (siteUrl: string) => {
    vi.stubEnv('PUBLIC_SITE_URL', siteUrl);
    await service.create(
      {
        nombreNegocio: 'Tienda',
        tipoNegocio: 'otro',
        queVende: 'Cosas de prueba',
        nombre: 'Ana',
        apellidos: 'Pérez',
        correo: `ana${db.rows.length}@example.com`,
        telefono: '5512345678',
        aceptaLegal: true,
        versionLegal: '2026-10-19',
        turnstileToken: 't',
      } as never,
      '203.0.113.5',
    );
    return (sendVerification.mock.calls.at(-1)![0] as { verifyUrl: string }).verifyUrl.split('/verificar-correo?token=')[0];
  };

  it.each([
    ['https://marchanta.albertogdlc.org', 'https://marchanta.albertogdlc.org'],
    ['https://marchanta.albertogdlc.org/', 'https://marchanta.albertogdlc.org'],
    ['https://marchanta.albertogdlc.org///', 'https://marchanta.albertogdlc.org'],
    ['https://a.test/?x=1', 'https://a.test'],
    ['https://a.test/#frag', 'https://a.test'],
    ['https://a.test/path/?x=1#y', 'https://a.test/path'],
    ['https://a.test/api/v1', 'https://a.test/api/v1'],
    ['https://a.test/API/v1/', 'https://a.test/API/v1'],
    ['   https://a.test/   ', 'https://a.test'],
    ['a?b?c', 'a'],
    ['a/?/', 'a'],
    ['a//?x//', 'a'],
    ['https://a.test/ñandú/', 'https://a.test/ñandú'],
    ['https://a.test/😀/', 'https://a.test/😀'],
    ['https://a.test/\n', 'https://a.test'],
    ['https://a.test\n/', 'https://a.test\n'],
    ['a?b\nc', 'a?b\nc'],
    ['a\n?b', 'a\n'],
  ])('%j -> %j', async (value, expected) => {
    expect(await linkFor(value)).toBe(expected);
  });
});

// Pruebas unitarias del flujo de registro con correo verificado (create, resend, verifyEmail).
// Usan una base en memoria (test/support/fake-registration-db.ts) para afirmar EFECTOS: qué fila
// quedó guardada, qué correo salió y qué se revirtió; no solo que se llamó a un método.
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, Logger, ServiceUnavailableException } from '@nestjs/common';
import { BusinessRegistrationService } from './business-registration.service.js';
import { REGISTRATION_RULES, RegistrationLimits } from './registration-limits.js';
import type { RegistrationCleanupService } from './registration-cleanup.service.js';
import type { TurnstileResult, TurnstileService } from './turnstile.service.js';
import type { CreateBusinessRegistrationDto } from './dto/create-business-registration.dto.js';
import type { EmailService } from '../email/email.service.js';
import { FakeRegistrationDb, type Row } from '../../test/support/fake-registration-db.js';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const tokenOf = (url: string) => new URL(url).searchParams.get('token')!;
const MINUTE = 60_000;

const dto = (over: Partial<CreateBusinessRegistrationDto> = {}): CreateBusinessRegistrationDto =>
  ({
    nombreNegocio: 'Abarrotes Los Pinos',
    tipoNegocio: 'abarrotes',
    queVende: 'Abarrotes, dulces y refrescos',
    dondeVende: 'Tianguis de Acolman',
    recomendadoPor: 'Doña Luz',
    nombre: 'Ana',
    apellidos: 'Pérez Soto',
    correo: 'Ana@Example.com',
    telefono: '5512345678',
    aceptaLegal: true,
    versionLegal: '2026-10-19',
    turnstileToken: 'token-turnstile',
    ...over,
  }) as CreateBusinessRegistrationDto;

describe('BusinessRegistrationService: registro con correo verificado', () => {
  let db: FakeRegistrationDb;
  let sendVerification: ReturnType<typeof vi.fn>;
  let sendApproval: ReturnType<typeof vi.fn>;
  let turnstileVerify: ReturnType<typeof vi.fn<(token: string, ip: string) => Promise<TurnstileResult>>>;
  let runBatch: ReturnType<typeof vi.fn>;
  let limits: RegistrationLimits;
  let service: BusinessRegistrationService;
  let logged: string[];

  const verificationEmails = () => sendVerification.mock.calls.map((c) => c[0] as { correo: string; nombre: string; verifyUrl: string });
  const lastEmailedToken = () => tokenOf(verificationEmails().at(-1)!.verifyUrl);
  const only = (correo = 'ana@example.com') => {
    const rows = db.byCorreo(correo);
    expect(rows).toHaveLength(1);
    return rows[0];
  };

  beforeEach(() => {
    vi.stubEnv('PUBLIC_SITE_URL', 'https://marchanta.example.test/');
    vi.stubEnv('APP_BASE_URL', 'https://api.example.test');
    db = new FakeRegistrationDb();
    sendVerification = vi.fn().mockResolvedValue(undefined);
    sendApproval = vi.fn().mockResolvedValue(undefined);
    turnstileVerify = vi.fn<(token: string, ip: string) => Promise<TurnstileResult>>().mockResolvedValue('ok');
    runBatch = vi.fn().mockResolvedValue(0);
    limits = new RegistrationLimits();
    service = new BusinessRegistrationService(
      db.prisma,
      { sendRegistrationVerificationEmail: sendVerification, sendBusinessRegistrationApprovalEmail: sendApproval } as unknown as EmailService,
      { verify: turnstileVerify } as unknown as TurnstileService,
      limits,
      { runBatch } as unknown as RegistrationCleanupService,
    );
    logged = [];
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation((message: unknown) => {
        logged.push(String(message));
      });
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe('create: una solicitud nueva', () => {
    it('guarda la solicitud "pendiente_correo" con los datos limpios, el correo en minúsculas y la aceptación legal', async () => {
      const before = Date.now();
      await service.create(dto(), '203.0.113.5');

      const row = only();
      expect(row).toMatchObject({
        status: 'pendiente_correo',
        nombreNegocio: 'Abarrotes Los Pinos',
        tipoNegocio: 'abarrotes',
        queVende: 'Abarrotes, dulces y refrescos',
        dondeVende: 'Tianguis de Acolman',
        recomendadoPor: 'Doña Luz',
        nombre: 'Ana',
        apellidos: 'Pérez Soto',
        correo: 'ana@example.com',
        telefono: '5512345678',
        legalVersion: '2026-10-19',
        verificationEmailsSent: 1,
      });
      expect((row.legalAcceptedAt as Date).getTime()).toBeGreaterThanOrEqual(before);
      expect((row.legalAcceptedAt as Date).getTime()).toBeLessThanOrEqual(Date.now());
      expect(row.emailVerifiedAt).toBeNull();
    });

    it('lo opcional que no vino se guarda como nulo', async () => {
      await service.create(dto({ dondeVende: undefined, recomendadoPor: undefined }), '203.0.113.5');

      expect(only()).toMatchObject({ dondeVende: null, recomendadoPor: null });
    });

    it('manda el enlace al frontend (/verificar-correo) con un token de 32 bytes y solo guarda su hash', async () => {
      await service.create(dto(), '203.0.113.5');

      const [email] = verificationEmails();
      expect(email).toMatchObject({ correo: 'ana@example.com', nombre: 'Ana' });
      expect(email.verifyUrl).toMatch(/^https:\/\/marchanta\.example\.test\/verificar-correo\?token=[A-Za-z0-9_-]{43}$/);
      const token = tokenOf(email.verifyUrl);
      expect(Buffer.from(token, 'base64url')).toHaveLength(32);
      const row = only();
      expect(row.emailTokenHash).toBe(sha256(token));
      expect(JSON.stringify(row)).not.toContain(token); // el token en claro no queda en ninguna columna
    });

    it('el enlace de verificación vence a las 48 horas', async () => {
      const before = Date.now();
      await service.create(dto(), '203.0.113.5');

      const expires = (only().emailTokenExpiresAt as Date).getTime();
      expect(expires - before).toBeGreaterThanOrEqual(REGISTRATION_RULES.verificationTtlMs);
      expect(expires - Date.now()).toBeLessThanOrEqual(REGISTRATION_RULES.verificationTtlMs);
      expect(REGISTRATION_RULES.verificationTtlMs).toBe(48 * 60 * MINUTE);
    });

    it('NO avisa al aprobador: nadie puede aprobar todavía (el token de aprobación es de relleno)', async () => {
      await service.create(dto(), '203.0.113.5');

      expect(sendApproval).not.toHaveBeenCalled();
      const row = only();
      expect(row.approvalTokenHash).not.toBe(sha256(lastEmailedToken()));
      expect(row.approvalTokenHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('guarda con transacción de presupuesto holgado (el correo sale desde dentro)', async () => {
      await service.create(dto(), '203.0.113.5');

      expect(db.transactionOptions[0]).toMatchObject({ maxWait: 5_000, timeout: 15_000 });
    });

    it('lanza una limpieza de solicitudes vencidas sin esperarla', async () => {
      await service.create(dto(), '203.0.113.5');

      expect(runBatch).toHaveBeenCalledTimes(1);
    });

    it('si la limpieza falla, el registro sigue funcionando', async () => {
      runBatch.mockRejectedValue(new Error('la base se cayó'));

      await expect(service.create(dto(), '203.0.113.5')).resolves.toBeUndefined();

      expect(only().status).toBe('pendiente_correo');
    });
  });

  describe('create: campo trampa y Turnstile', () => {
    it('un bot que llena el campo trampa no crea nada, no manda correo ni gasta una verificación de Turnstile', async () => {
      await expect(service.create(dto({ sitioWebEmpresa: 'http://spam.example' }), '203.0.113.5')).resolves.toBeUndefined();

      expect(db.rows).toHaveLength(0);
      expect(sendVerification).not.toHaveBeenCalled();
      expect(turnstileVerify).not.toHaveBeenCalled();
    });

    it('un campo trampa en blanco (solo espacios) no cuenta: es una persona', async () => {
      await service.create(dto({ sitioWebEmpresa: '   ' }), '203.0.113.5');

      expect(only().status).toBe('pendiente_correo');
    });

    it('manda a Turnstile el token y la IP del visitante', async () => {
      await service.create(dto({ turnstileToken: 'abc' }), '198.51.100.9');

      expect(turnstileVerify).toHaveBeenCalledExactlyOnceWith('abc', '198.51.100.9');
    });

    it('un token inválido responde 400 turnstile_invalid y no guarda ni manda nada', async () => {
      turnstileVerify.mockResolvedValue('invalid');

      const error = await service.create(dto(), '203.0.113.5').catch((e: unknown) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toMatchObject({ statusCode: 400, code: 'turnstile_invalid' });
      expect(db.rows).toHaveLength(0);
      expect(sendVerification).not.toHaveBeenCalled();
    });

    it('Turnstile caído o sin configurar responde 503 turnstile_unavailable y no guarda ni manda nada', async () => {
      turnstileVerify.mockResolvedValue('unavailable');

      const error = await service.create(dto(), '203.0.113.5').catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect((error as ServiceUnavailableException).getResponse()).toMatchObject({ statusCode: 503, code: 'turnstile_unavailable' });
      expect(db.rows).toHaveLength(0);
      expect(sendVerification).not.toHaveBeenCalled();
    });
  });

  describe('create: un correo que ya tiene solicitud (respuesta siempre igual, sin duplicados)', () => {
    const existing = (over: Row = {}) =>
      db.seed({
        correo: 'ana@example.com',
        nombre: 'Ana',
        status: 'pendiente_correo',
        legalVersion: '2026-10-16',
        verificationEmailsSent: 1,
        lastVerificationEmailAt: new Date(Date.now() - 2 * MINUTE),
        emailTokenHash: sha256('token-viejo'),
        emailTokenExpiresAt: new Date(Date.now() + 60 * MINUTE),
        ...over,
      });

    it('sin confirmar y pasado el minuto: REENVÍA con un token nuevo (el viejo deja de servir) y no duplica la fila', async () => {
      existing();

      await service.create(dto(), '203.0.113.5');

      const row = only();
      expect(row.verificationEmailsSent).toBe(2);
      expect(row.emailTokenHash).toBe(sha256(lastEmailedToken()));
      expect(row.emailTokenHash).not.toBe(sha256('token-viejo'));
      expect(verificationEmails()).toHaveLength(1);
    });

    it('dentro de los 60 segundos no manda otro correo y la fila no cambia', async () => {
      const row = existing({ lastVerificationEmailAt: new Date(Date.now() - 10_000) });
      const before = { ...row };

      await service.create(dto(), '203.0.113.5');

      expect(sendVerification).not.toHaveBeenCalled();
      expect(only()).toEqual(before);
    });

    it('lo que NO se reenvía no gasta el límite por hora del correo (los 3 cupos siguen disponibles)', async () => {
      const cases: Row[] = [
        { status: 'aprobado' },
        { status: 'pendiente' },
        { lastVerificationEmailAt: new Date(Date.now() - 10_000) }, // dentro de los 60 s
        { verificationEmailsSent: REGISTRATION_RULES.maxVerificationEmailsPerRequest },
      ];
      for (const over of cases) {
        db.rows = [];
        existing(over);

        await service.create(dto(), '203.0.113.5');
      }

      const spare = [1, 2, 3].map(() => limits.allowVerificationEmail('ana@example.com'));
      expect(spare).toEqual([true, true, true]);
      expect(sendVerification).not.toHaveBeenCalled();
    });

    it('con 3 correos ya enviados no manda un cuarto', async () => {
      existing({ verificationEmailsSent: REGISTRATION_RULES.maxVerificationEmailsPerRequest });

      await service.create(dto(), '203.0.113.5');

      expect(sendVerification).not.toHaveBeenCalled();
      expect(only().verificationEmailsSent).toBe(3);
    });

    it.each(['pendiente', 'aprobado'])('si ya está %s no manda nada ni toca la fila', async (status) => {
      const row = existing({ status });
      const before = { ...row };

      await service.create(dto(), '203.0.113.5');

      expect(sendVerification).not.toHaveBeenCalled();
      expect(sendApproval).not.toHaveBeenCalled();
      expect(only()).toEqual(before);
    });

    it('una solicitud RECHAZADA libera el correo: se crea una nueva', async () => {
      existing({ status: 'rechazado' });

      await service.create(dto(), '203.0.113.5');

      expect(db.byCorreo('ana@example.com')).toHaveLength(2);
      expect(db.byCorreo('ana@example.com').filter((r) => r.status === 'pendiente_correo')).toHaveLength(1);
      expect(verificationEmails()).toHaveLength(1);
    });

    it('una fila anterior a este flujo (sin versión legal) no cuenta como solicitud viva', async () => {
      existing({ legalVersion: null, status: 'pendiente' });

      await service.create(dto(), '203.0.113.5');

      expect(db.byCorreo('ana@example.com')).toHaveLength(2);
      expect(verificationEmails()).toHaveLength(1);
    });

    it('si dos envíos simultáneos chocan en el índice único, el perdedor se trata como reenvío y NO duplica', async () => {
      db.raceOnNextCreate = {
        correo: 'ana@example.com',
        nombre: 'Ana',
        status: 'pendiente_correo',
        legalVersion: '2026-10-19',
        verificationEmailsSent: 1,
        lastVerificationEmailAt: new Date(),
      };

      await expect(service.create(dto(), '203.0.113.5')).resolves.toBeUndefined();

      expect(db.byCorreo('ana@example.com')).toHaveLength(1);
      expect(sendVerification).not.toHaveBeenCalled(); // el ganador acaba de mandar el suyo: 60 s
    });
  });

  describe('create: límite de correos por hora a un mismo correo', () => {
    it('al llegar a 3 en la hora no se guarda ni se manda un cuarto, y la respuesta no cambia', async () => {
      for (let i = 0; i < REGISTRATION_RULES.verificationEmailsPerCorreoPerHour; i += 1) {
        expect(limits.allowVerificationEmail('ana@example.com')).toBe(true);
      }

      await expect(service.create(dto(), '203.0.113.5')).resolves.toBeUndefined();

      expect(db.rows).toHaveLength(0);
      expect(sendVerification).not.toHaveBeenCalled();
    });

    it('el aviso del log no trae el correo completo', async () => {
      for (let i = 0; i < 3; i += 1) limits.allowVerificationEmail('ana@example.com');

      await service.create(dto(), '203.0.113.5');

      expect(logged.some((line) => line.includes('limit reached'))).toBe(true);
      expect(logged.join('\n')).not.toContain('ana@example.com');
    });
  });

  describe('create: si el correo no sale, no queda nada a medias', () => {
    it('Resend caído: responde 503 email_unavailable y la fila se revierte', async () => {
      sendVerification.mockRejectedValue(new Error('Resend: dominio no verificado'));

      const error = await service.create(dto(), '203.0.113.5').catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect((error as ServiceUnavailableException).getResponse()).toMatchObject({ statusCode: 503, code: 'email_unavailable' });
      expect(db.rows).toHaveLength(0);
    });

    it('el error de Resend se registra sin el token ni el correo', async () => {
      sendVerification.mockRejectedValue(new Error('Resend: boom'));

      await service.create(dto(), '203.0.113.5').catch(() => undefined);

      const text = logged.join('\n');
      expect(text).toContain('boom');
      expect(text).not.toContain('ana@example.com');
      expect(text).not.toMatch(/token=/);
    });

    it('una transacción que se agota también responde 503 amable y se revierte', async () => {
      db.failNextCreate = Object.assign(new Error('Transaction already closed: expired'), {
        code: 'P2028',
        meta: { operation: 'commit', timeout: 15_000, timeTaken: 15_100 },
      });

      const error = await service.create(dto(), '203.0.113.5').catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect(db.rows).toHaveLength(0);
    });

    it('un error que no es nuestro (la base se cayó) se propaga tal cual', async () => {
      const boom = new Error('connection refused');
      db.failNextCreate = boom;

      await expect(service.create(dto(), '203.0.113.5')).rejects.toBe(boom);
    });
  });

  describe('PUBLIC_SITE_URL', () => {
    it('quita la barra final y cualquier ?query para armar el enlace', async () => {
      vi.stubEnv('PUBLIC_SITE_URL', ' https://marchanta.example.test/?x=1 ');

      await service.create(dto(), '203.0.113.5');

      expect(verificationEmails()[0].verifyUrl.startsWith('https://marchanta.example.test/verificar-correo?token=')).toBe(true);
    });

    it('en producción sin PUBLIC_SITE_URL responde 503 y no guarda nada (no sabe a dónde enlazar)', async () => {
      vi.stubEnv('PUBLIC_SITE_URL', '');
      vi.stubEnv('NODE_ENV', 'production');

      const error = await service.create(dto(), '203.0.113.5').catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect(db.rows).toHaveLength(0);
      expect(logged.some((line) => line.includes('PUBLIC_SITE_URL is not configured'))).toBe(true);
    });

    it('fuera de producción sin la variable usa el servidor de desarrollo del frontend', async () => {
      vi.stubEnv('PUBLIC_SITE_URL', '');
      vi.stubEnv('NODE_ENV', 'test');

      await service.create(dto(), '203.0.113.5');

      expect(verificationEmails()[0].verifyUrl.startsWith('http://localhost:5173/verificar-correo?token=')).toBe(true);
    });
  });

  describe('privacidad en los logs', () => {
    it('un registro completo no deja en el log el correo, el teléfono ni el token', async () => {
      await service.create(dto(), '203.0.113.5');

      const text = logged.join('\n');
      expect(text).not.toContain('ana@example.com');
      expect(text).not.toContain('5512345678');
      expect(text).not.toContain(lastEmailedToken());
      expect(text).toContain('a***@e***.com'); // el correo va enmascarado
    });
  });

  describe('resend', () => {
    const pendingRow = (over: Row = {}) =>
      db.seed({
        correo: 'ana@example.com',
        nombre: 'Ana',
        status: 'pendiente_correo',
        legalVersion: '2026-10-19',
        verificationEmailsSent: 1,
        lastVerificationEmailAt: new Date(Date.now() - 2 * MINUTE),
        emailTokenHash: sha256('token-viejo'),
        emailTokenExpiresAt: new Date(Date.now() + 60 * MINUTE),
        ...over,
      });

    it('manda un enlace nuevo a una solicitud sin confirmar y deja sin efecto el anterior', async () => {
      pendingRow();

      await service.resend('  ANA@Example.com ');

      const row = only();
      expect(verificationEmails()).toEqual([
        expect.objectContaining({ correo: 'ana@example.com', nombre: 'Ana' }),
      ]);
      expect(row.emailTokenHash).toBe(sha256(lastEmailedToken()));
      expect(row.emailTokenHash).not.toBe(sha256('token-viejo'));
      expect(row.verificationEmailsSent).toBe(2);
    });

    it('con el límite de 3 correos por hora del correo agotado no manda otro, la fila no cambia y el log no trae el correo', async () => {
      const row = pendingRow();
      const before = { ...row };
      for (let i = 0; i < REGISTRATION_RULES.verificationEmailsPerCorreoPerHour; i += 1) limits.allowVerificationEmail('ana@example.com');

      await service.resend('ana@example.com');

      expect(sendVerification).not.toHaveBeenCalled();
      expect(only()).toEqual(before);
      expect(logged.some((line) => line.includes('limit reached'))).toBe(true);
      expect(logged.join('\n')).not.toContain('ana@example.com');
    });

    it('un correo que no existe responde igual y no manda nada', async () => {
      await expect(service.resend('nadie@example.com')).resolves.toBeUndefined();

      expect(sendVerification).not.toHaveBeenCalled();
      expect(db.rows).toHaveLength(0);
    });

    it('con 3 correos ya enviados no manda más', async () => {
      pendingRow({ verificationEmailsSent: 3 });

      await service.resend('ana@example.com');

      expect(sendVerification).not.toHaveBeenCalled();
    });

    it('dos reenvíos seguidos: el segundo cae dentro de los 60 s y no sale', async () => {
      pendingRow();

      await service.resend('ana@example.com');
      await service.resend('ana@example.com');

      expect(verificationEmails()).toHaveLength(1);
      expect(only().verificationEmailsSent).toBe(2);
    });

    it('dos reenvíos simultáneos: solo uno gana la fila y solo sale un correo', async () => {
      pendingRow();

      await Promise.all([service.resend('ana@example.com'), service.resend('ana@example.com')]);

      expect(verificationEmails()).toHaveLength(1);
      expect(only().verificationEmailsSent).toBe(2);
    });

    it('si el correo no sale, responde 503 y el contador y el token no cambian', async () => {
      pendingRow();
      sendVerification.mockRejectedValue(new Error('Resend caído'));

      const error = await service.resend('ana@example.com').catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ServiceUnavailableException);
      const row = only();
      expect(row.verificationEmailsSent).toBe(1);
      expect(row.emailTokenHash).toBe(sha256('token-viejo'));
    });

    it('un error inesperado se propaga tal cual', async () => {
      const boom = new Error('connection refused');
      vi.spyOn(db.prisma, '$transaction').mockRejectedValue(boom);

      await expect(service.resend('ana@example.com')).rejects.toBe(boom);
    });
  });

  describe('verifyEmail: confirmar el correo', () => {
    /** Registra por create() y devuelve el token que viajó por correo. */
    async function registered(over: Partial<CreateBusinessRegistrationDto> = {}) {
      await service.create(dto(over), '203.0.113.5');
      const token = lastEmailedToken();
      sendVerification.mockClear();
      return token;
    }

    it('pasa la solicitud a "pendiente", borra el token de verificación y marca cuándo se confirmó', async () => {
      const token = await registered();
      const before = Date.now();

      await service.verifyEmail(token);

      const row = only();
      expect(row.status).toBe('pendiente');
      expect(row.emailTokenHash).toBeNull();
      expect(row.emailTokenExpiresAt).toBeNull();
      expect((row.emailVerifiedAt as Date).getTime()).toBeGreaterThanOrEqual(before);
    });

    it('solo ahora avisa al aprobador, UNA vez, con los datos y los enlaces de aprobar y rechazar', async () => {
      const token = await registered();
      expect(sendApproval).not.toHaveBeenCalled();

      await service.verifyEmail(token);

      expect(sendApproval).toHaveBeenCalledTimes(1);
      const email = sendApproval.mock.calls[0][0];
      expect(email).toMatchObject({
        nombreNegocio: 'Abarrotes Los Pinos',
        tipoNegocio: 'abarrotes',
        queVende: 'Abarrotes, dulces y refrescos',
        dondeVende: 'Tianguis de Acolman',
        recomendadoPor: 'Doña Luz',
        nombre: 'Ana',
        apellidos: 'Pérez Soto',
        correo: 'ana@example.com',
        telefono: '5512345678',
        duplicates: { telefono: 0, correo: 0 },
      });
      expect(email.emailVerifiedAt).toEqual(only().emailVerifiedAt);
      expect(email.approveUrl).toMatch(/^https:\/\/api\.example\.test\/api\/v1\/business-registration\/approve\?token=[A-Za-z0-9_-]{43}$/);
      expect(email.rejectUrl).toMatch(/^https:\/\/api\.example\.test\/api\/v1\/business-registration\/reject\?token=[A-Za-z0-9_-]{43}$/);
      expect(tokenOf(email.approveUrl)).toBe(tokenOf(email.rejectUrl));
    });

    it('el token de aprobación es nuevo, se guarda hasheado y vence a los 30 días', async () => {
      const token = await registered();
      const before = Date.now();

      await service.verifyEmail(token);

      const approvalToken = tokenOf(sendApproval.mock.calls[0][0].approveUrl);
      const row = only();
      expect(approvalToken).not.toBe(token);
      expect(row.approvalTokenHash).toBe(sha256(approvalToken));
      expect(JSON.stringify(row)).not.toContain(approvalToken);
      const ttl = (row.tokenExpiresAt as Date).getTime() - before;
      expect(ttl).toBeGreaterThanOrEqual(REGISTRATION_RULES.approvalTtlMs - 1_000);
      expect(ttl).toBeLessThanOrEqual(REGISTRATION_RULES.approvalTtlMs + 1_000);
    });

    it('avisa al aprobador si el teléfono o el correo ya aparecen en otra solicitud', async () => {
      db.seed({ correo: 'otra@example.com', telefono: '5512345678', status: 'pendiente' });
      db.seed({ correo: 'otra2@example.com', telefono: '5512345678', status: 'rechazado' });
      const token = await registered();

      await service.verifyEmail(token);

      expect(sendApproval.mock.calls[0][0].duplicates).toEqual({ telefono: 2, correo: 0 });
    });

    it('cuenta como repetido el correo de una solicitud anterior (rechazada) de la misma persona', async () => {
      db.seed({ correo: 'ana@example.com', telefono: '5599999999', status: 'rechazado', legalVersion: '2026-10-16' });
      const token = await registered();

      await service.verifyEmail(token);

      expect(sendApproval.mock.calls[0][0].duplicates).toEqual({ telefono: 0, correo: 1 });
    });

    it('el token es de UN solo uso: la segunda vez responde 400 link_invalid y no avisa otra vez', async () => {
      const token = await registered();
      await service.verifyEmail(token);

      const error = await service.verifyEmail(token).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toMatchObject({ statusCode: 400, code: 'link_invalid' });
      expect(sendApproval).toHaveBeenCalledTimes(1);
    });

    it('dos confirmaciones simultáneas: gana una sola y el aprobador recibe un solo correo', async () => {
      const token = await registered();

      const results = await Promise.allSettled([service.verifyEmail(token), service.verifyEmail(token)]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
      expect(sendApproval).toHaveBeenCalledTimes(1);
    });

    it('un token vencido responde 400 y la solicitud no cambia', async () => {
      const token = await registered();
      only().emailTokenExpiresAt = new Date(Date.now() - 1_000);
      const before = { ...only() };

      const error = await service.verifyEmail(token).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      expect(only()).toEqual(before);
      expect(sendApproval).not.toHaveBeenCalled();
    });

    it('un token que no existe responde lo mismo que uno usado o vencido', async () => {
      const used = await registered();
      await service.verifyEmail(used);
      const answers = await Promise.all(
        [used, 'no-existe-nunca-jamas-token-1234567890'].map((t) =>
          service.verifyEmail(t).then(
            () => null,
            (e: BadRequestException) => e.getResponse(),
          ),
        ),
      );

      expect(answers[0]).toEqual(answers[1]);
      expect(answers[0]).toMatchObject({ statusCode: 400, code: 'link_invalid' });
    });

    it('un token cuya solicitud ya no está "pendiente_correo" no sirve', async () => {
      const token = await registered();
      only().status = 'rechazado';

      await expect(service.verifyEmail(token)).rejects.toBeInstanceOf(BadRequestException);
      expect(only().status).toBe('rechazado');
    });

    it('si el correo al aprobador falla: 503, todo se revierte y el MISMO enlace sigue sirviendo', async () => {
      const token = await registered();
      sendApproval.mockRejectedValueOnce(new Error('Resend caído'));

      const error = await service.verifyEmail(token).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ServiceUnavailableException);
      const row = only();
      expect(row.status).toBe('pendiente_correo');
      expect(row.emailTokenHash).toBe(sha256(token));
      expect(row.emailVerifiedAt).toBeNull();

      await service.verifyEmail(token);
      expect(only().status).toBe('pendiente');
      expect(sendApproval).toHaveBeenCalledTimes(2);
    });

    it('el correo al aprobador sale con teléfono nulo sin contar teléfonos repetidos', async () => {
      const token = await registered({ telefono: undefined as unknown as string });
      only().telefono = null;
      db.seed({ correo: 'x@example.com', telefono: null, status: 'pendiente' });

      await service.verifyEmail(token);

      expect(sendApproval.mock.calls[0][0]).toMatchObject({ telefono: null, duplicates: { telefono: 0 } });
    });

    it('un error inesperado (no del correo) se propaga tal cual', async () => {
      const token = await registered();
      const boom = new Error('connection refused');
      vi.spyOn(db.prisma, '$transaction').mockRejectedValue(boom);

      await expect(service.verifyEmail(token)).rejects.toBe(boom);
    });

    it('no deja en el log el correo, el teléfono ni los tokens', async () => {
      const token = await registered();
      await service.verifyEmail(token);

      const text = logged.join('\n');
      const approvalToken = tokenOf(sendApproval.mock.calls[0][0].approveUrl);
      for (const secret of ['ana@example.com', '5512345678', token, approvalToken]) {
        expect(text).not.toContain(secret);
      }
    });
  });
});

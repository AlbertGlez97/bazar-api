import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';
import { vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { EmailService } from '../src/email/email.service.js';
import { TurnstileService } from '../src/business-registration/turnstile.service.js';
import { RegistrationLimits } from '../src/business-registration/registration-limits.js';
import { RegistrationCleanupService } from '../src/business-registration/registration-cleanup.service.js';
import { createServerId } from '../src/common/server-id.js';
import { withTestTenant } from './tenant-scope.js';

/**
 * Registro de negocios v2: el correo se verifica con un enlace ANTES de que la solicitud llegue
 * al aprobador. Resend y Cloudflare Turnstile se simulan (no hay red).
 */
describe('business registration v2: email verification', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cleanup: RegistrationCleanupService;

  const sendVerification = vi.fn();
  const sendApproval = vi.fn();
  const sendCredentials = vi.fn();
  const turnstileVerify = vi.fn();

  const run = randomUUID();
  const name = (label: string) => `${label} ${run}`;
  const mail = (label: string) => `${label}.${run}@example.test`;
  const sha = (value: string) => createHash('sha256').update(value).digest('hex');
  const HOUR = 60 * 60 * 1000;

  // Una IP distinta por prueba (los límites por IP son de una hora): 198.51.100.x y 203.0.113.x.
  let ipCounter = Math.floor(Math.random() * 100);
  const nextIp = () => `203.0.${(ipCounter += 1) % 250}.${Math.floor(Math.random() * 250) + 1}`;

  const body = (overrides: Record<string, unknown> = {}) => ({
    nombreNegocio: name('Bonsáis de Alberto'),
    tipoNegocio: 'plantas_y_jardineria',
    queVende: 'Bonsáis y macetas hechas a mano',
    dondeVende: 'Tianguis de Acolman',
    recomendadoPor: 'Doña Luz',
    nombre: 'Alberto',
    apellidos: 'Gómez Pérez',
    correo: mail('alberto'),
    telefono: '55 1234 5678',
    aceptaLegal: true,
    versionLegal: '2026-10-16',
    turnstileToken: 'ok-token',
    ...overrides,
  });

  const submit = (data: object, ip = nextIp()) =>
    request(app.getHttpServer())
      .post('/api/v1/business-registration')
      .set('CF-Connecting-IP', ip)
      .send(data);
  const verify = (token: string, ip = nextIp()) =>
    request(app.getHttpServer())
      .post('/api/v1/business-registration/verify-email')
      .set('CF-Connecting-IP', ip)
      .send({ token });
  const resend = (correo: string, ip = nextIp()) =>
    request(app.getHttpServer())
      .post('/api/v1/business-registration/resend')
      .set('CF-Connecting-IP', ip)
      .send({ correo });

  const tokenOf = (url: string) => new URL(url).searchParams.get('token')!;
  const lastVerification = () => sendVerification.mock.calls.at(-1)![0] as { correo: string; nombre: string; verifyUrl: string };
  const rowOf = (correo: string) =>
    prisma.businessRegistrationRequest.findFirst({ where: { correo }, orderBy: { createdAt: 'desc' } });
  /** Hace que la última verificación se vea enviada hace más de 60 s (para probar el reenvío). */
  const age = (correo: string, ms = 61_000) =>
    prisma.businessRegistrationRequest.updateMany({
      where: { correo },
      data: { lastVerificationEmailAt: new Date(Date.now() - ms) },
    });

  beforeAll(async () => {
    vi.stubEnv('APP_BASE_URL', 'https://api.example.test');
    vi.stubEnv('PUBLIC_SITE_URL', 'https://marchanta.example.test/');
    vi.stubEnv('APPROVAL_NOTIFICATION_EMAIL', 'approver@example.test');
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EmailService)
      .useValue({
        sendRegistrationVerificationEmail: sendVerification,
        sendBusinessRegistrationApprovalEmail: sendApproval,
        sendBusinessCredentialsEmail: sendCredentials,
      })
      .overrideProvider(TurnstileService)
      .useValue({ verify: turnstileVerify })
      .compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
    prisma = app.get(PrismaService);
    cleanup = app.get(RegistrationCleanupService);
  });

  beforeEach(() => {
    sendVerification.mockReset().mockResolvedValue(undefined);
    sendApproval.mockReset().mockResolvedValue(undefined);
    sendCredentials.mockReset().mockResolvedValue({ deliveredTo: 'socio' });
    turnstileVerify.mockReset().mockImplementation(async (token: string) =>
      token === 'ok-token' ? 'ok' : token === 'down-token' ? 'unavailable' : 'invalid',
    );
  });

  afterAll(async () => {
    const rows = await prisma.businessRegistrationRequest.findMany({
      where: { OR: [{ nombreNegocio: { endsWith: run } }, { correo: { endsWith: `${run}@example.test` } }] },
    });
    for (const { createdContextId } of rows) {
      if (!createdContextId) continue;
      // Accounts first: Account.memberId is ON DELETE RESTRICT.
      await prisma.account.deleteMany({ where: { contextId: createdContextId } });
      await withTestTenant(createdContextId, async () => {
        await prisma.device.deleteMany({ where: { contextId: createdContextId } });
        await prisma.member.deleteMany({ where: { contextId: createdContextId } });
      });
    }
    await prisma.businessRegistrationRequest.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
    await app.close();
    vi.unstubAllEnvs();
  });

  describe('POST /business-registration', () => {
    it('crea la solicitud en "pendiente_correo" y responde 202 con una respuesta genérica', async () => {
      const data = body();
      const res = await submit(data).expect(202);

      expect(res.body).toEqual({ ok: true });
      const row = await rowOf(mail('alberto'));
      expect(row).toMatchObject({
        status: 'pendiente_correo',
        nombreNegocio: data.nombreNegocio,
        tipoNegocio: 'plantas_y_jardineria',
        queVende: 'Bonsáis y macetas hechas a mano',
        dondeVende: 'Tianguis de Acolman',
        recomendadoPor: 'Doña Luz',
        nombre: 'Alberto',
        apellidos: 'Gómez Pérez',
        telefono: '5512345678',
        emailVerifiedAt: null,
        verificationEmailsSent: 1,
      });
    });

    it('guarda la aceptación: versión y la fecha del SERVIDOR', async () => {
      const before = Date.now();
      await submit(body({ correo: mail('acepta') })).expect(202);

      const row = (await rowOf(mail('acepta')))!;
      expect(row.legalVersion).toBe('2026-10-16');
      expect(row.legalAcceptedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
      expect(row.legalAcceptedAt!.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    });

    it('guarda el correo en minúsculas y el teléfono normalizado a 10 dígitos', async () => {
      await submit(body({ correo: `  Mayus.${run}@Example.TEST `, telefono: '+52 55-1234-5678' })).expect(202);

      const row = (await rowOf(`mayus.${run}@example.test`))!;
      expect(row.correo).toBe(`mayus.${run}@example.test`);
      expect(row.telefono).toBe('5512345678');
    });

    it('manda el correo de verificación a la persona, con un enlace a la página del FRONTEND', async () => {
      await submit(body({ correo: mail('enlace') })).expect(202);

      expect(sendVerification).toHaveBeenCalledTimes(1);
      const call = lastVerification();
      expect(call.correo).toBe(mail('enlace'));
      expect(call.nombre).toBe('Alberto');
      const url = new URL(call.verifyUrl);
      expect(url.origin).toBe('https://marchanta.example.test');
      expect(url.pathname).toBe('/verificar-correo');
      expect(tokenOf(call.verifyUrl)).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes en base64url
    });

    it('guarda SOLO el hash (sha-256) del token, nunca el token, y vence a las 48 horas', async () => {
      const before = Date.now();
      await submit(body({ correo: mail('hash') })).expect(202);

      const token = tokenOf(lastVerification().verifyUrl);
      const row = (await rowOf(mail('hash')))!;
      expect(row.emailTokenHash).toBe(sha(token));
      expect(JSON.stringify(row)).not.toContain(token);
      const ttl = row.emailTokenExpiresAt!.getTime() - before;
      expect(ttl).toBeGreaterThan(48 * HOUR - 60_000);
      expect(ttl).toBeLessThan(48 * HOUR + 60_000);
    });

    it('NO manda nada al aprobador antes de que se confirme el correo', async () => {
      await submit(body({ correo: mail('nada-aprobador') })).expect(202);

      expect(sendApproval).not.toHaveBeenCalled();
    });

    it('el aprobador no puede aprobar ni rechazar una solicitud sin confirmar', async () => {
      await submit(body({ correo: mail('sin-confirmar') })).expect(202);
      const row = (await rowOf(mail('sin-confirmar')))!;

      // ni con el hash guardado ni con cualquier cosa: la solicitud no tiene enlace de aprobación válido
      const res = await request(app.getHttpServer())
        .get('/api/v1/business-registration/approve')
        .query({ token: row.approvalTokenHash });

      expect(res.status).toBe(404);
      expect((await rowOf(mail('sin-confirmar')))!.status).toBe('pendiente_correo');
    });

    it('un texto libre hostil se guarda como texto (se escapa al mostrarlo) y se limpia', async () => {
      await submit(body({ correo: mail('hostil'), nombreNegocio: name('<img src=x onerror=alert(1)>'), queVende: 'Cosas\u0000 con\ncontrol‮ y <b>html</b>' })).expect(202);

      const row = (await rowOf(mail('hostil')))!;
      expect(row.nombreNegocio).toBe(name('<img src=x onerror=alert(1)>'));
      expect(row.queVende).toBe('Cosas con control y <b>html</b>');
    });

    it('400 con datos inválidos y no crea ni manda nada', async () => {
      for (const bad of [{ telefono: '12345' }, { tipoNegocio: 'joyería' }, { queVende: 'corto' }, { aceptaLegal: false }, { versionLegal: 'hoy' }, { turnstileToken: '' }]) {
        await submit(body({ correo: mail('invalido'), ...bad })).expect(400);
      }
      expect(await prisma.businessRegistrationRequest.count({ where: { correo: mail('invalido') } })).toBe(0);
      expect(sendVerification).not.toHaveBeenCalled();
      expect(turnstileVerify).not.toHaveBeenCalled();
    });

    it('rechaza los campos viejos y los de redes o mapas', async () => {
      await submit(body({ nombreSocio: 'x', contactoSocio: 'y' })).expect(400);
      await submit(body({ instagram: '@x', mapa: 'https://maps.google.com' })).expect(400);
    });
  });

  describe('Cloudflare Turnstile', () => {
    it('verifica el token en el servidor, con la IP de CF-Connecting-IP', async () => {
      await submit(body({ correo: mail('ts') }), '203.0.113.77').expect(202);

      expect(turnstileVerify).toHaveBeenCalledWith('ok-token', '203.0.113.77');
    });

    it('un token falso, usado o vencido da 400 con un código claro y no crea nada', async () => {
      const res = await submit(body({ correo: mail('ts-malo'), turnstileToken: 'viejo' })).expect(400);

      expect(res.body.code).toBe('turnstile_invalid');
      expect(await prisma.businessRegistrationRequest.count({ where: { correo: mail('ts-malo') } })).toBe(0);
      expect(sendVerification).not.toHaveBeenCalled();
    });

    it('si Cloudflare no responde o falta la clave da 503 amable y no crea nada', async () => {
      const res = await submit(body({ correo: mail('ts-caido'), turnstileToken: 'down-token' })).expect(503);

      expect(res.body.code).toBe('turnstile_unavailable');
      expect(await prisma.businessRegistrationRequest.count({ where: { correo: mail('ts-caido') } })).toBe(0);
    });

    it('un token de un solo uso: el mismo token se manda a verificar en cada envío (Cloudflare lo rechaza la segunda vez)', async () => {
      turnstileVerify.mockResolvedValueOnce('ok').mockResolvedValueOnce('invalid');
      await submit(body({ correo: mail('ts-uno'), turnstileToken: 'mismo' })).expect(202);

      await submit(body({ correo: mail('ts-dos'), turnstileToken: 'mismo' })).expect(400);
    });
  });

  describe('campo trampa', () => {
    it('lleno: responde igual que un éxito (202 genérico) pero no crea nada, no manda correo y no gasta Turnstile', async () => {
      const res = await submit(body({ correo: mail('robot'), sitioWebEmpresa: 'http://spam.example' })).expect(202);

      expect(res.body).toEqual({ ok: true });
      expect(await prisma.businessRegistrationRequest.count({ where: { correo: mail('robot') } })).toBe(0);
      expect(sendVerification).not.toHaveBeenCalled();
      expect(turnstileVerify).not.toHaveBeenCalled();
    });

    it('vacío: es una solicitud normal', async () => {
      await submit(body({ correo: mail('humano'), sitioWebEmpresa: '' })).expect(202);

      expect(await prisma.businessRegistrationRequest.count({ where: { correo: mail('humano') } })).toBe(1);
    });
  });

  describe('POST /business-registration/verify-email', () => {
    const registered = async (label: string) => {
      await submit(body({ correo: mail(label), nombreNegocio: name(`Negocio ${label}`) })).expect(202);
      return tokenOf(lastVerification().verifyUrl);
    };

    it('confirma el correo: estado "pendiente", fecha de confirmación y token consumido', async () => {
      const token = await registered('confirma');

      const res = await verify(token).expect(200);

      expect(res.body).toEqual({ ok: true });
      const row = (await rowOf(mail('confirma')))!;
      expect(row.status).toBe('pendiente');
      expect(row.emailVerifiedAt).toBeInstanceOf(Date);
      expect(row.emailTokenHash).toBeNull();
      expect(row.emailTokenExpiresAt).toBeNull();
    });

    it('RECIÉN ENTONCES manda al aprobador el correo de solicitud, con todos los datos nuevos', async () => {
      const token = await registered('aprobador');
      expect(sendApproval).not.toHaveBeenCalled();

      await verify(token).expect(200);

      expect(sendApproval).toHaveBeenCalledTimes(1);
      const call = sendApproval.mock.calls[0]![0];
      expect(call).toMatchObject({
        nombreNegocio: name('Negocio aprobador'),
        tipoNegocio: 'plantas_y_jardineria',
        queVende: 'Bonsáis y macetas hechas a mano',
        dondeVende: 'Tianguis de Acolman',
        recomendadoPor: 'Doña Luz',
        nombre: 'Alberto',
        apellidos: 'Gómez Pérez',
        correo: mail('aprobador'),
        telefono: '5512345678',
        duplicates: { telefono: expect.any(Number), correo: 0 },
      });
      expect(call.emailVerifiedAt).toBeInstanceOf(Date);
      expect(new URL(call.approveUrl).pathname).toBe('/api/v1/business-registration/approve');
      expect(new URL(call.rejectUrl).pathname).toBe('/api/v1/business-registration/reject');
    });

    it('el enlace de aprobar del correo SÍ funciona y crea el negocio', async () => {
      const token = await registered('flujo-completo');
      await verify(token).expect(200);
      const { approveUrl } = sendApproval.mock.calls[0]![0];

      const res = await request(app.getHttpServer()).get(new URL(approveUrl).pathname + new URL(approveUrl).search).expect(200);

      expect(res.text).toMatch(/aprobado/i);
      expect((await rowOf(mail('flujo-completo')))!.status).toBe('aprobado');
      expect(sendCredentials).toHaveBeenCalledTimes(1);
    });

    it('el token de aprobación del aprobador vence a los 30 días desde la confirmación', async () => {
      const token = await registered('vence30');
      const before = Date.now();
      await verify(token).expect(200);

      const row = (await rowOf(mail('vence30')))!;
      const ttl = row.tokenExpiresAt.getTime() - before;
      expect(ttl).toBeGreaterThan(30 * 24 * HOUR - 60_000);
      expect(ttl).toBeLessThan(30 * 24 * HOUR + 60_000);
    });

    it('avisa al aprobador si el teléfono o el correo ya aparecen en otra solicitud', async () => {
      const t1 = await registered('dup-a');
      await verify(t1).expect(200);
      await submit(body({ correo: mail('dup-b'), nombreNegocio: name('Negocio dup-b') })).expect(202);
      const t2 = tokenOf(lastVerification().verifyUrl);
      sendApproval.mockClear();

      await verify(t2).expect(200);

      // mismo teléfono (5512345678) que la solicitud dup-a y que las demás de esta prueba
      expect(sendApproval.mock.calls[0]![0].duplicates.telefono).toBeGreaterThanOrEqual(1);
      expect(sendApproval.mock.calls[0]![0].duplicates.correo).toBe(0);
    });

    it('NO se confirma con un GET (los escáneres de correo abren los enlaces solos)', async () => {
      const token = await registered('sin-get');

      const res = await request(app.getHttpServer()).get('/api/v1/business-registration/verify-email').query({ token });

      expect(res.status).toBe(404);
      expect((await rowOf(mail('sin-get')))!.status).toBe('pendiente_correo');
      expect(sendApproval).not.toHaveBeenCalled();
    });

    it('es de UN SOLO USO: la segunda vez da 400 y no manda otro correo al aprobador', async () => {
      const token = await registered('un-uso');
      await verify(token).expect(200);

      const res = await verify(token).expect(400);

      expect(res.body.code).toBe('link_invalid');
      expect(sendApproval).toHaveBeenCalledTimes(1);
    });

    it('un enlace vencido da 400 y la solicitud sigue sin confirmar', async () => {
      const token = await registered('vencido');
      await prisma.businessRegistrationRequest.updateMany({
        where: { correo: mail('vencido') },
        data: { emailTokenExpiresAt: new Date(Date.now() - 1000) },
      });

      const res = await verify(token).expect(400);

      expect(res.body.code).toBe('link_invalid');
      expect((await rowOf(mail('vencido')))!.status).toBe('pendiente_correo');
      expect(sendApproval).not.toHaveBeenCalled();
    });

    it('un token que no existe da exactamente la misma respuesta que uno vencido o usado', async () => {
      const token = await registered('misma');
      await verify(token).expect(200);
      const used = await verify(token);
      const unknown = await verify('x'.repeat(43));

      expect(unknown.status).toBe(used.status);
      expect(unknown.body).toEqual(used.body);
    });

    it('si se abre el mismo enlace 5 veces a la vez, solo una confirma y el aprobador recibe UN correo', async () => {
      const token = await registered('concurrente');

      const results = await Promise.all(Array.from({ length: 5 }, () => verify(token)));

      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status === 400)).toHaveLength(4);
      expect(sendApproval).toHaveBeenCalledTimes(1);
    });

    it('si Resend falla al avisar al aprobador: 503, nada a medias, y se puede reintentar con el mismo enlace', async () => {
      const token = await registered('resend-caido');
      sendApproval.mockRejectedValueOnce(new Error('Resend rejected the approval email'));

      const failed = await verify(token).expect(503);

      expect(failed.body.code).toBe('email_unavailable');
      const row = (await rowOf(mail('resend-caido')))!;
      expect(row.status).toBe('pendiente_correo');
      expect(row.emailTokenHash).toBe(sha(token));
      expect(row.emailVerifiedAt).toBeNull();

      await verify(token).expect(200);
      expect((await rowOf(mail('resend-caido')))!.status).toBe('pendiente');
      expect(sendApproval).toHaveBeenCalledTimes(2);
    });

    it('400 si el cuerpo no trae un token razonable', async () => {
      for (const bad of [{}, { token: '' }, { token: 'a' }, { token: 'x'.repeat(300) }, { token: 5 }, { token: 'ok', extra: 1 }]) {
        await request(app.getHttpServer()).post('/api/v1/business-registration/verify-email').set('CF-Connecting-IP', nextIp()).send(bad).expect(400);
      }
    });

    it('un token de una solicitud no confirma a otra', async () => {
      const a = await registered('aislada-a');
      await registered('aislada-b');

      await verify(a).expect(200);

      expect((await rowOf(mail('aislada-a')))!.status).toBe('pendiente');
      expect((await rowOf(mail('aislada-b')))!.status).toBe('pendiente_correo');
    });
  });

  describe('Resend falla al mandar la verificación', () => {
    it('503 amable y SIN registros a medias', async () => {
      sendVerification.mockRejectedValueOnce(new Error('Resend rejected the verification email'));

      const res = await submit(body({ correo: mail('resend-no') })).expect(503);

      expect(res.body.code).toBe('email_unavailable');
      expect(await prisma.businessRegistrationRequest.count({ where: { correo: mail('resend-no') } })).toBe(0);
    });

    it('al reintentar después, funciona (no quedó ninguna solicitud que estorbe)', async () => {
      sendVerification.mockRejectedValueOnce(new Error('boom'));
      await submit(body({ correo: mail('reintento') })).expect(503);

      await submit(body({ correo: mail('reintento') })).expect(202);

      expect(await prisma.businessRegistrationRequest.count({ where: { correo: mail('reintento') } })).toBe(1);
    });

    it('un reenvío que falla no cuenta como enviado', async () => {
      await submit(body({ correo: mail('reenvio-falla') })).expect(202);
      await age(mail('reenvio-falla'));
      sendVerification.mockRejectedValueOnce(new Error('boom'));

      await resend(mail('reenvio-falla')).expect(503);

      const row = (await rowOf(mail('reenvio-falla')))!;
      expect(row.verificationEmailsSent).toBe(1);
    });
  });

  describe('respuestas genéricas (sin revelar si un correo ya existe)', () => {
    it('un correo ya registrado y confirmado responde igual y no manda nada', async () => {
      await submit(body({ correo: mail('ya-confirmado') })).expect(202);
      await verify(tokenOf(lastVerification().verifyUrl)).expect(200);
      sendVerification.mockClear();
      sendApproval.mockClear();

      const fresh = await submit(body({ correo: mail('nuevo-correo') })).expect(202);
      const again = await submit(body({ correo: mail('ya-confirmado') })).expect(202);

      expect(again.body).toEqual(fresh.body);
      expect(sendVerification).toHaveBeenCalledTimes(1); // solo el correo nuevo
      expect(await prisma.businessRegistrationRequest.count({ where: { correo: mail('ya-confirmado') } })).toBe(1);
    });

    it('un correo con solicitud aprobada también responde igual y no manda nada', async () => {
      await submit(body({ correo: mail('ya-aprobado') })).expect(202);
      await verify(tokenOf(lastVerification().verifyUrl)).expect(200);
      const { approveUrl } = sendApproval.mock.calls.at(-1)![0];
      await request(app.getHttpServer()).get(new URL(approveUrl).pathname + new URL(approveUrl).search).expect(200);
      sendVerification.mockClear();

      const res = await submit(body({ correo: mail('ya-aprobado') })).expect(202);

      expect(res.body).toEqual({ ok: true });
      expect(sendVerification).not.toHaveBeenCalled();
      expect(await prisma.businessRegistrationRequest.count({ where: { correo: mail('ya-aprobado') } })).toBe(1);
    });

    it('un correo con solicitud RECHAZADA puede volver a registrarse', async () => {
      await submit(body({ correo: mail('rechazado') })).expect(202);
      await verify(tokenOf(lastVerification().verifyUrl)).expect(200);
      const { rejectUrl } = sendApproval.mock.calls.at(-1)![0];
      await request(app.getHttpServer()).get(new URL(rejectUrl).pathname + new URL(rejectUrl).search).expect(200);

      await submit(body({ correo: mail('rechazado') })).expect(202);

      expect(await prisma.businessRegistrationRequest.count({ where: { correo: mail('rechazado'), status: 'pendiente_correo' } })).toBe(1);
    });

    it('un correo que NO existe en /resend responde igual que uno que sí', async () => {
      await submit(body({ correo: mail('existe') })).expect(202);
      await age(mail('existe'));

      const known = await resend(mail('existe')).expect(202);
      const unknown = await resend(mail('no-existe')).expect(202);

      expect(unknown.body).toEqual(known.body);
      expect(unknown.headers['content-length']).toBe(known.headers['content-length']);
    });
  });

  describe('reenvío del enlace', () => {
    it('un segundo envío del formulario con el mismo correo REENVÍA el enlace (después de 60 s) con un token NUEVO', async () => {
      await submit(body({ correo: mail('reenvia') })).expect(202);
      const first = tokenOf(lastVerification().verifyUrl);
      await age(mail('reenvia'));

      await submit(body({ correo: mail('reenvia') })).expect(202);

      expect(sendVerification).toHaveBeenCalledTimes(2);
      const second = tokenOf(lastVerification().verifyUrl);
      expect(second).not.toBe(first);
      expect(await prisma.businessRegistrationRequest.count({ where: { correo: mail('reenvia') } })).toBe(1);
      // el enlace anterior ya no sirve; el nuevo sí
      await verify(first).expect(400);
      await verify(second).expect(200);
    });

    it('espera de 60 segundos: dentro de ese tiempo no manda otro correo y responde igual', async () => {
      await submit(body({ correo: mail('espera') })).expect(202);

      const again = await submit(body({ correo: mail('espera') })).expect(202);
      const viaResend = await resend(mail('espera')).expect(202);

      expect(again.body).toEqual({ ok: true });
      expect(viaResend.body).toEqual({ ok: true });
      expect(sendVerification).toHaveBeenCalledTimes(1);
    });

    it('máximo 3 correos por solicitud (el primero cuenta), aun sin el límite por hora del correo', async () => {
      // El límite por correo (3/hora) coincide en número con este tope: se apaga para que
      // solo el tope por SOLICITUD pueda detener el cuarto correo.
      const perCorreo = vi.spyOn(app.get(RegistrationLimits), 'allowVerificationEmail').mockReturnValue(true);
      try {
        await submit(body({ correo: mail('tope3') })).expect(202);
        for (let i = 0; i < 4; i += 1) {
          await age(mail('tope3'));
          await resend(mail('tope3')).expect(202);
        }

        expect(sendVerification).toHaveBeenCalledTimes(3);
        expect((await rowOf(mail('tope3')))!.verificationEmailsSent).toBe(3);
      } finally {
        perCorreo.mockRestore();
      }
    });

    it('POST /resend valida el correo (400 si no es un correo)', async () => {
      await resend('no-es-correo').expect(400);
      await request(app.getHttpServer()).post('/api/v1/business-registration/resend').set('CF-Connecting-IP', nextIp()).send({ correo: mail('x'), otro: 1 }).expect(400);
    });

    it('un reenvío a una solicitud ya confirmada no manda nada', async () => {
      await submit(body({ correo: mail('reenvio-confirmada') })).expect(202);
      await verify(tokenOf(lastVerification().verifyUrl)).expect(200);
      sendVerification.mockClear();

      await resend(mail('reenvio-confirmada')).expect(202);

      expect(sendVerification).not.toHaveBeenCalled();
    });
  });

  describe('dos envíos simultáneos no crean duplicados', () => {
    it('10 formularios a la vez con el mismo correo dejan UNA solicitud y mandan UN correo', async () => {
      const results = await Promise.all(Array.from({ length: 10 }, () => submit(body({ correo: mail('carrera') }))));

      expect(results.every((r) => r.status === 202)).toBe(true);
      expect(await prisma.businessRegistrationRequest.count({ where: { correo: mail('carrera') } })).toBe(1);
      expect(sendVerification).toHaveBeenCalledTimes(1);
    });

    it('el índice único de la base de datos lo impide aunque falle la lógica de la aplicación', async () => {
      await submit(body({ correo: mail('indice') })).expect(202);

      await expect(
        prisma.businessRegistrationRequest.create({
          data: {
            id: createServerId(),
            nombreNegocio: name('Duplicado directo'),
            nombre: 'X',
            apellidos: 'Y',
            correo: mail('indice'),
            approvalTokenHash: sha(randomUUID()),
            tokenExpiresAt: new Date(Date.now() + HOUR),
            legalVersion: '2026-10-16',
            status: 'pendiente_correo',
          },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
    });
  });

  describe('límites de intentos', () => {
    it('5 solicitudes por hora por IP: la sexta da 429 con Retry-After', async () => {
      const ip = nextIp();
      for (let i = 0; i < 5; i += 1) await submit(body({ correo: mail(`ip5-${i}`) }), ip).expect(202);

      const res = await submit(body({ correo: mail('ip5-6') }), ip).expect(429);

      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
      expect(res.body.code).toBe('rate_limited');
      expect(await prisma.businessRegistrationRequest.count({ where: { correo: mail('ip5-6') } })).toBe(0);
    });

    it('el límite es POR IP: otra IP no se ve afectada', async () => {
      const ip = nextIp();
      for (let i = 0; i < 5; i += 1) await submit(body({ correo: mail(`aparte-${i}`) }), ip).expect(202);
      await submit(body({ correo: mail('aparte-x') }), ip).expect(429);

      await submit(body({ correo: mail('aparte-otra-ip') }), nextIp()).expect(202);
    });

    it('la IP sale de CF-Connecting-IP: X-Forwarded-For escrito a mano NO sirve para evadir el límite', async () => {
      const ip = nextIp();
      for (let i = 0; i < 5; i += 1) await submit(body({ correo: mail(`xff-${i}`) }), ip).expect(202);

      await request(app.getHttpServer())
        .post('/api/v1/business-registration')
        .set('CF-Connecting-IP', ip)
        .set('X-Forwarded-For', '8.8.8.8')
        .send(body({ correo: mail('xff-x') }))
        .expect(429);
    });

    it('sin la cabecera de IP (todos detrás del túnel) no se bloquea a todos juntos con 5 solicitudes de IPs distintas', async () => {
      // cada IP distinta lleva su propia cuenta: 8 IPs distintas, 8 solicitudes, ninguna bloqueada
      for (let i = 0; i < 8; i += 1) await submit(body({ correo: mail(`varias-${i}`) }), nextIp()).expect(202);
    });

    it('3 correos de verificación por hora por correo: el cuarto intento (desde otras IPs) no manda nada y responde igual', async () => {
      const correo = mail('por-correo');
      for (let i = 0; i < 3; i += 1) {
        await submit(body({ correo })).expect(202);
        await age(correo);
      }
      sendVerification.mockClear();

      const res = await submit(body({ correo })).expect(202);

      expect(res.body).toEqual({ ok: true });
      expect(sendVerification).not.toHaveBeenCalled();
    });

    it('el límite por correo es propio (no el de la solicitud): 3 correos por hora aunque cada solicitud anterior se rechace', async () => {
      const correo = mail('limite-correo');
      for (let i = 0; i < 3; i += 1) {
        await submit(body({ correo })).expect(202);
        await verify(tokenOf(lastVerification().verifyUrl)).expect(200);
        const { rejectUrl } = sendApproval.mock.calls.at(-1)![0];
        await request(app.getHttpServer()).get(new URL(rejectUrl).pathname + new URL(rejectUrl).search).expect(200);
      }
      sendVerification.mockClear();

      // la cuarta solicitud es una fila NUEVA (sin límites propios), pero el correo ya recibió 3 en la hora
      const res = await submit(body({ correo })).expect(202);

      expect(res.body).toEqual({ ok: true });
      expect(sendVerification).not.toHaveBeenCalled();
      expect(await prisma.businessRegistrationRequest.count({ where: { correo, status: 'pendiente_correo' } })).toBe(0);
    });

    it('10 verificaciones por hora por IP: la undécima da 429', async () => {
      const ip = nextIp();
      for (let i = 0; i < 10; i += 1) await verify(`token-inventado-${i}-${'x'.repeat(30)}`, ip).expect(400);

      const res = await verify(`token-inventado-11-${'x'.repeat(30)}`, ip).expect(429);

      expect(res.body.code).toBe('rate_limited');
    });

    it('10 reenvíos por hora por IP: el undécimo da 429', async () => {
      const ip = nextIp();
      for (let i = 0; i < 10; i += 1) await resend(mail(`rl-${i}`), ip).expect(202);

      await resend(mail('rl-11'), ip).expect(429);
    });
  });

  describe('filas antiguas y aislamiento', () => {
    it('una solicitud anterior (sin campos nuevos) sigue aprobándose igual', async () => {
      const token = randomUUID();
      const nombreNegocio = name('Antigua');
      await prisma.businessRegistrationRequest.create({
        data: {
          id: createServerId(),
          nombreNegocio,
          nombre: 'Vieja',
          apellidos: 'Solicitud',
          correo: mail('antigua'),
          telefono: '555-0100',
          approvalTokenHash: sha(token),
          tokenExpiresAt: new Date(Date.now() + 60_000),
        },
      });

      const before = await prisma.businessRegistrationRequest.findFirstOrThrow({ where: { nombreNegocio } });
      expect(before).toMatchObject({ status: 'pendiente', tipoNegocio: null, queVende: null, legalVersion: null, emailVerifiedAt: null, verificationEmailsSent: 0 });

      await request(app.getHttpServer()).get(`/api/v1/business-registration/approve?token=${token}`).expect(200);

      expect((await prisma.businessRegistrationRequest.findFirstOrThrow({ where: { nombreNegocio } })).status).toBe('aprobado');
    });

    it('una solicitud antigua con el mismo correo NO estorba un registro nuevo (y se avisa como duplicado)', async () => {
      await prisma.businessRegistrationRequest.create({
        data: {
          id: createServerId(),
          nombreNegocio: name('Antigua dup'),
          nombre: 'Vieja',
          apellidos: 'Solicitud',
          correo: mail('antigua-dup'),
          approvalTokenHash: sha(randomUUID()),
          tokenExpiresAt: new Date(Date.now() + 60_000),
        },
      });

      await submit(body({ correo: mail('antigua-dup') })).expect(202);
      await verify(tokenOf(lastVerification().verifyUrl)).expect(200);

      expect(sendApproval.mock.calls[0]![0].duplicates.correo).toBe(1);
    });

    it('registrar y aprobar un negocio no toca los datos de otros negocios', async () => {
      const contextA = `reg-aislado-${randomUUID()}`;
      await withTestTenant(contextA, () => prisma.member.create({ data: { name: 'Socio A', role: 'socio', contextId: contextA } }));
      try {
        await submit(body({ correo: mail('aislado') })).expect(202);
        await verify(tokenOf(lastVerification().verifyUrl)).expect(200);
        const { approveUrl } = sendApproval.mock.calls.at(-1)![0];
        await request(app.getHttpServer()).get(new URL(approveUrl).pathname + new URL(approveUrl).search).expect(200);

        const created = (await rowOf(mail('aislado')))!.createdContextId!;
        expect(created).not.toBe(contextA);
        expect(await withTestTenant(contextA, () => prisma.member.count({ where: { contextId: contextA } }))).toBe(1);
        expect(await withTestTenant(created, () => prisma.member.count({ where: { contextId: created } }))).toBe(1);
      } finally {
        await withTestTenant(contextA, () => prisma.member.deleteMany({ where: { contextId: contextA } }));
      }
    });
  });

  describe('enlaces de los correos: la URL correcta con cualquier forma de APP_BASE_URL y PUBLIC_SITE_URL', () => {
    afterEach(() => {
      vi.stubEnv('APP_BASE_URL', 'https://api.example.test');
      vi.stubEnv('PUBLIC_SITE_URL', 'https://marchanta.example.test/');
    });

    // Con y sin barra final, con y sin /api/v1 (en cualquier combinación de mayúsculas), con
    // espacios, con query o fragmento: el enlace SIEMPRE sale con el mismo origen y la misma ruta.
    it.each([
      ['https://marchanta.example.test'],
      ['https://marchanta.example.test/'],
      ['https://marchanta.example.test///'],
      ['  https://marchanta.example.test/  '],
      ['https://marchanta.example.test/?utm=1'],
      ['https://marchanta.example.test/#inicio'],
    ])('el enlace de verificación con PUBLIC_SITE_URL=%j es https://marchanta.example.test/verificar-correo?token=…', async (site) => {
      vi.stubEnv('PUBLIC_SITE_URL', site);
      const correo = mail(`enlace-v-${Math.random().toString(36).slice(2, 8)}`);

      await submit(body({ correo })).expect(202);

      const { verifyUrl } = lastVerification();
      expect(verifyUrl).toMatch(/^https:\/\/marchanta\.example\.test\/verificar-correo\?token=[A-Za-z0-9_-]{43}$/);
    });

    it.each([
      ['https://api.example.test'],
      ['https://api.example.test/'],
      ['https://api.example.test///'],
      ['https://api.example.test/api/v1'],
      ['https://api.example.test/api/v1/'],
      ['https://api.example.test/API/V1'],
      ['https://api.example.test//api/v1'],
      ['  https://api.example.test/api/v1  '],
      ['https://api.example.test/api/v1?x=1'],
      ['https://api.example.test/api/v1#f'],
    ])('los enlaces de aprobar y rechazar con APP_BASE_URL=%j son https://api.example.test/api/v1/business-registration/{approve,reject}?token=… y funcionan', async (base) => {
      vi.stubEnv('APP_BASE_URL', base);
      const correo = mail(`enlace-a-${Math.random().toString(36).slice(2, 8)}`);
      await submit(body({ correo })).expect(202);
      await verify(tokenOf(lastVerification().verifyUrl)).expect(200);

      const { approveUrl, rejectUrl } = sendApproval.mock.calls.at(-1)![0] as { approveUrl: string; rejectUrl: string };

      expect(approveUrl).toMatch(/^https:\/\/api\.example\.test\/api\/v1\/business-registration\/approve\?token=[A-Za-z0-9_-]{43}$/);
      expect(rejectUrl).toMatch(/^https:\/\/api\.example\.test\/api\/v1\/business-registration\/reject\?token=[A-Za-z0-9_-]{43}$/);
      expect(tokenOf(approveUrl)).toBe(tokenOf(rejectUrl));
      // el enlace no es solo bonito: abrirlo (como lo haría el aprobador) resuelve la solicitud
      const path = new URL(rejectUrl);
      await request(app.getHttpServer()).get(`${path.pathname}${path.search}`).expect(200);
      expect((await rowOf(correo))!.status).toBe('rechazado');
    });

    it('con APP_BASE_URL vacío los enlaces apuntan al puerto local (desarrollo)', async () => {
      vi.stubEnv('APP_BASE_URL', '');
      vi.stubEnv('PORT', '3100');
      const correo = mail('enlace-local');
      await submit(body({ correo })).expect(202);
      await verify(tokenOf(lastVerification().verifyUrl)).expect(200);

      const { approveUrl } = sendApproval.mock.calls.at(-1)![0] as { approveUrl: string };

      expect(approveUrl.startsWith('http://localhost:3100/api/v1/business-registration/approve?token=')).toBe(true);
      vi.unstubAllEnvs();
      vi.stubEnv('APP_BASE_URL', 'https://api.example.test');
    });
  });

  describe('limpieza de solicitudes', () => {
    const insert = (label: string, data: Record<string, unknown>) =>
      prisma.businessRegistrationRequest.create({
        data: {
          id: createServerId(),
          nombreNegocio: name(label),
          nombre: 'Limpieza',
          apellidos: 'Prueba',
          correo: mail(label),
          approvalTokenHash: sha(randomUUID()),
          tokenExpiresAt: new Date(Date.now() + HOUR),
          ...data,
        } as never,
      });
    const exists = async (label: string) => (await prisma.businessRegistrationRequest.count({ where: { nombreNegocio: name(label) } })) === 1;
    const DAY = 24 * HOUR;

    it('borra las sin confirmar de más de 7 días y deja las de menos de 7', async () => {
      await insert('sc-viejo', { status: 'pendiente_correo', legalVersion: '2026-10-16', createdAt: new Date(Date.now() - 8 * DAY) });
      await insert('sc-nuevo', { status: 'pendiente_correo', legalVersion: '2026-10-16', createdAt: new Date(Date.now() - 6 * DAY) });

      await cleanup.runBatch();

      expect(await exists('sc-viejo')).toBe(false);
      expect(await exists('sc-nuevo')).toBe(true);
    });

    it('borra las rechazadas de más de 30 días y deja las recientes', async () => {
      await insert('rech-viejo', { status: 'rechazado', resolvedAt: new Date(Date.now() - 31 * DAY) });
      await insert('rech-nuevo', { status: 'rechazado', resolvedAt: new Date(Date.now() - 29 * DAY) });

      await cleanup.runBatch();

      expect(await exists('rech-viejo')).toBe(false);
      expect(await exists('rech-nuevo')).toBe(true);
    });

    it('borra las vencidas (el enlace de aprobación venció hace más de 30 días) y deja las vigentes', async () => {
      await insert('venc-viejo', { status: 'pendiente', tokenExpiresAt: new Date(Date.now() - 31 * DAY) });
      await insert('venc-nuevo', { status: 'pendiente', tokenExpiresAt: new Date(Date.now() - 29 * DAY) });
      await insert('vigente', { status: 'pendiente', tokenExpiresAt: new Date(Date.now() + 10 * DAY) });

      await cleanup.runBatch();

      expect(await exists('venc-viejo')).toBe(false);
      expect(await exists('venc-nuevo')).toBe(true);
      expect(await exists('vigente')).toBe(true);
    });

    it('NUNCA borra una solicitud aprobada, por vieja que sea', async () => {
      await insert('aprobada-vieja', { status: 'aprobado', resolvedAt: new Date(Date.now() - 400 * DAY), createdAt: new Date(Date.now() - 400 * DAY), tokenExpiresAt: new Date(Date.now() - 370 * DAY) });

      await cleanup.runBatch();

      expect(await exists('aprobada-vieja')).toBe(true);
    });

    it('trabaja por lotes (no borra miles de filas de una vez)', async () => {
      for (let i = 0; i < 3; i += 1) {
        await insert(`lote-${i}`, { status: 'pendiente_correo', legalVersion: '2026-10-16', createdAt: new Date(Date.now() - 9 * DAY) });
      }

      const deleted = await cleanup.runBatch(undefined, 2);

      expect(deleted).toBeLessThanOrEqual(2 + 0); // el lote máximo se respeta
      expect(deleted).toBeGreaterThan(0);
      await cleanup.runBatch();
      await cleanup.runBatch();
      expect(await exists('lote-0')).toBe(false);
    });

    it('se ejecuta con cada registro nuevo', async () => {
      await insert('por-registro', { status: 'pendiente_correo', legalVersion: '2026-10-16', createdAt: new Date(Date.now() - 20 * DAY) });

      await submit(body({ correo: mail('dispara-limpieza') })).expect(202);
      await vi.waitFor(async () => expect(await exists('por-registro')).toBe(false));
    });
  });
});

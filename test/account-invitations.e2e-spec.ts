import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { Logger, type INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { EmailService } from '../src/email/email.service.js';
import { hashDeviceToken } from '../src/common/device-secret.js';
import { hashInvitationToken } from '../src/invitations/invitation-token.js';
import { withTestTenant } from './tenant-scope.js';
import { purgeRuleData } from './rules-cleanup.js';

const GENERIC_FAILURE = 'No pudimos enviar la invitación a ese correo.';
const INVALID_LINK = 'Este enlace no sirve. Pide una invitación nueva.';
const PASSWORD = 'una-clave-larga-1';

describe('account invitations', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const sendInvitation = vi.fn().mockResolvedValue(undefined);
  const contexts: string[] = [];
  const emails = new Set<string>();
  const uniqueEmail = (label = 'u') => {
    const email = `${label}-${randomUUID()}@example.test`;
    emails.add(email);
    return email;
  };

  interface Biz {
    contextId: string;
    deviceId: string;
    inviter: { memberId: string; token: string };
    invitee: string; // socio without a personal account
    colaborador: { memberId: string; token: string };
  }

  const business = async (label: string): Promise<Biz> => {
    const contextId = `inv-${label}-${randomUUID()}`;
    contexts.push(contextId);
    const jwt = app.get(JwtService);
    return withTestTenant(contextId, async () => {
      const make = (name: string, role: 'socio' | 'colaborador' = 'socio') =>
        prisma.member.create({ data: { contextId, name, role } });
      const deviceId = (await prisma.device.create({ data: { contextId, name: 'Tablet', authorized: true } })).id;
      const inviter = await make('Ana');
      const invitee = await make('Beto');
      const colab = await make('Colaborador', 'colaborador');
      const login = async (memberId: string) => {
        const account = await prisma.account.create({
          data: { username: uniqueEmail('acct'), passwordHash: 'x', contextId, memberId },
        });
        return jwt.signAsync({ sub: account.id });
      };
      return {
        contextId,
        deviceId,
        inviter: { memberId: inviter.id, token: await login(inviter.id) },
        invitee: invitee.id,
        colaborador: { memberId: colab.id, token: await login(colab.id) },
      };
    });
  };

  const asSocio = (b: Biz, req: request.Test, who = b.inviter) =>
    req.auth(who.token, { type: 'bearer' }).set('x-member-id', who.memberId).set('x-device-id', b.deviceId);
  const invite = (b: Biz, memberId: string, email: string, who = b.inviter) =>
    asSocio(b, request(app.getHttpServer()).post(`/api/v1/members/${memberId}/invitation`).send({ email }), who);
  const inspect = (token: string) => request(app.getHttpServer()).post('/api/v1/invitations/inspect').send({ token });
  const accept = (token: string, password = PASSWORD) =>
    request(app.getHttpServer()).post('/api/v1/invitations/accept').send({ token, password });
  /** The token that the (mocked) email would have carried. */
  const lastToken = () => {
    const call = sendInvitation.mock.calls.at(-1)![0] as { inviteUrl: string };
    return call.inviteUrl.split('/invitacion/')[1]!;
  };
  const rows = (b: Biz, memberId?: string) =>
    withTestTenant(b.contextId, () =>
      prisma.accountInvitation.findMany({ where: { contextId: b.contextId, ...(memberId ? { memberId } : {}) }, orderBy: { createdAt: 'asc' } }),
    );
  /** Moves every invitation of the business `ms` into the past, as if that much time had gone by. */
  const backdate = (b: Biz, ms: number) =>
    withTestTenant(b.contextId, async () => {
      for (const row of await prisma.accountInvitation.findMany({ where: { contextId: b.contextId } }))
        await prisma.accountInvitation.update({
          where: { id: row.id },
          data: {
            createdAt: new Date(row.createdAt.getTime() - ms),
            expiresAt: new Date(row.expiresAt.getTime() - ms),
          },
        });
    });

  beforeAll(async () => {
    process.env.PUBLIC_SITE_URL = 'https://site.test';
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EmailService)
      .useValue({ sendAccountInvitationEmail: sendInvitation })
      .compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
    prisma = app.get(PrismaService);
  });
  afterAll(async () => {
    if (prisma) {
      await purgeRuleData(contexts); // approvals made with an invited account reference it
      for (const contextId of contexts) {
        await withTestTenant(contextId, () => prisma.accountInvitation.deleteMany({ where: { contextId } }));
        await prisma.account.deleteMany({ where: { contextId } });
        await withTestTenant(contextId, async () => {
          await prisma.device.deleteMany({ where: { contextId } });
          await prisma.member.deleteMany({ where: { contextId } });
        });
      }
      await prisma.account.deleteMany({ where: { username: { in: [...emails] } } });
    }
    await app?.close();
  });
  beforeEach(() => sendInvitation.mockClear());

  describe('inviting', () => {
    it('manda un enlace de un solo uso con el hash en la base y sin ninguna contraseña', async () => {
      const b = await business('invite');
      const email = uniqueEmail('beto');
      const res = await invite(b, b.invitee, `  ${email.toUpperCase()} `).expect(201);

      expect(res.body).toEqual({ ok: true, expiresAt: expect.any(String) });
      expect(sendInvitation).toHaveBeenCalledTimes(1);
      const sent = sendInvitation.mock.calls[0]![0];
      expect(sent).toMatchObject({ to: email, memberName: 'Beto', inviterName: 'Ana', expiresInHours: 72 });
      expect(sent.inviteUrl).toMatch(/^https:\/\/site\.test\/invitacion\/[A-Za-z0-9_-]{43}$/);
      expect(JSON.stringify(sent)).not.toMatch(/contraseña|password/i);

      const [row] = await rows(b, b.invitee);
      expect(row!.tokenHash).toBe(hashInvitationToken(lastToken()));
      expect(JSON.stringify(row)).not.toContain(lastToken());
      expect(row!.email).toBe(email);
      const ttl = row!.expiresAt.getTime() - row!.createdAt.getTime();
      expect(ttl).toBe(72 * 60 * 60 * 1000);
    });

    it('un colaborador no puede invitar, ni nombrando a un socio', async () => {
      const b = await business('colab');
      await invite(b, b.invitee, uniqueEmail(), b.colaborador).expect(403);
      await invite(b, b.invitee, uniqueEmail(), { token: b.colaborador.token, memberId: b.inviter.memberId }).expect(403);
      expect(sendInvitation).not.toHaveBeenCalled();
    });

    it('solo se invita a un socio activo del mismo negocio y que aún no tenga cuenta propia', async () => {
      const b = await business('targets');
      const other = await business('targets-other');
      await invite(b, randomUUID(), uniqueEmail()).expect(404);
      await invite(b, other.invitee, uniqueEmail()).expect(404);
      await invite(b, b.colaborador.memberId, uniqueEmail()).expect(422);
      await invite(b, b.inviter.memberId, uniqueEmail()).expect(409);
      await withTestTenant(b.contextId, () => prisma.member.update({ where: { id: b.invitee }, data: { active: false } }));
      await invite(b, b.invitee, uniqueEmail()).expect(422);
      expect(sendInvitation).not.toHaveBeenCalled();
    });

    it('un correo mal escrito se rechaza', async () => {
      const b = await business('bad-email');
      for (const email of ['', 'sin-arroba', 'a@b', 'a b@c.com', 'a@b.com, c@d.com', `${'x'.repeat(95)}@e.com`])
        await invite(b, b.invitee, email).expect(400);
    });

    it('la respuesta es la misma si el correo ya tiene cuenta, en este negocio o en otro, o si falla el envío', async () => {
      const b = await business('generic');
      const other = await business('generic-other');
      const here = uniqueEmail('aqui');
      const there = uniqueEmail('alla');
      await prisma.account.create({ data: { username: here, passwordHash: 'x', contextId: b.contextId } });
      await prisma.account.create({ data: { username: there, passwordHash: 'x', contextId: other.contextId } });

      const sameBusiness = await invite(b, b.invitee, here);
      const otherBusiness = await invite(b, b.invitee, there);
      sendInvitation.mockRejectedValueOnce(new Error('resend down'));
      const delivery = await invite(b, b.invitee, uniqueEmail('falla'));

      for (const res of [sameBusiness, otherBusiness, delivery]) {
        expect(res.status).toBe(422);
        expect(res.body).toEqual({ code: 'INVITATION_NOT_SENT', message: GENERIC_FAILURE });
      }
      expect(sameBusiness.body).toEqual(otherBusiness.body);
      expect(sameBusiness.headers['content-length']).toBe(otherBusiness.headers['content-length']);
      expect(sendInvitation).toHaveBeenCalledTimes(1); // solo el intento que sí era nuevo
    });

    it('si el envío falla, el enlace queda sin efecto', async () => {
      const b = await business('send-fails');
      sendInvitation.mockRejectedValueOnce(new Error('resend down'));
      await invite(b, b.invitee, uniqueEmail()).expect(422);
      const [row] = await rows(b, b.invitee);
      expect(row!.supersededAt).toBeInstanceOf(Date);
    });
  });

  describe('resend limits', () => {
    it('un reenvío invalida el enlace anterior', async () => {
      const b = await business('resend');
      const email = uniqueEmail();
      await invite(b, b.invitee, email).expect(201);
      const first = lastToken();
      await backdate(b, 2 * 60 * 1000);
      await invite(b, b.invitee, email).expect(201);
      const second = lastToken();

      expect(second).not.toBe(first);
      expect((await inspect(first)).status).toBe(404);
      expect((await inspect(second)).status).toBe(200);
      expect((await accept(first)).status).toBe(404);
      expect((await accept(second)).status).toBe(200);
    });

    it('pide esperar un minuto entre envíos', async () => {
      const b = await business('gap');
      const email = uniqueEmail();
      await invite(b, b.invitee, email).expect(201);
      const res = await invite(b, b.invitee, email).expect(429);
      expect(res.body.code).toBe('INVITATION_TOO_SOON');
      expect(res.body.message).toBe('Espera un minuto antes de enviar otra invitación.');
      await backdate(b, 61 * 1000);
      await invite(b, b.invitee, email).expect(201);
    });

    it('máximo 3 invitaciones en 24 horas, y vuelve a permitir pasado el día', async () => {
      const b = await business('daily');
      const email = uniqueEmail();
      for (let i = 0; i < 3; i++) {
        await invite(b, b.invitee, email).expect(201);
        await backdate(b, 2 * 60 * 1000);
      }
      const res = await invite(b, b.invitee, email).expect(429);
      expect(res.body.code).toBe('INVITATION_DAILY_LIMIT');
      expect(res.body.message).toBe('Ya se enviaron 3 invitaciones hoy. Intenta mañana.');
      expect(sendInvitation).toHaveBeenCalledTimes(3);
      await backdate(b, 24 * 60 * 60 * 1000);
      await invite(b, b.invitee, email).expect(201);
    });
  });

  describe('tope de personas nuevas por socio que invita', () => {
    it('la número 11 del día se rechaza con un mensaje claro; los reenvíos y otro socio no se afectan', async () => {
      const b = await business('new-cap');
      const targets = await withTestTenant(b.contextId, async () => {
        const ids: string[] = [];
        for (let i = 0; i < 11; i++)
          ids.push((await prisma.member.create({ data: { contextId: b.contextId, name: `Extra ${i}`, role: 'socio' } })).id);
        return ids;
      });
      for (const id of targets.slice(0, 10)) await invite(b, id, uniqueEmail('n')).expect(201);

      const res = await invite(b, targets[10]!, uniqueEmail('n')).expect(429);
      expect(res.body).toEqual({ code: 'INVITATION_NEW_DAILY_LIMIT', message: 'Ya invitaste a 10 personas hoy. Intenta mañana.' });
      expect(sendInvitation).toHaveBeenCalledTimes(10);

      // Reenviar a alguien ya invitado no es una persona nueva.
      await backdate(b, 2 * 60 * 1000);
      await invite(b, targets[0]!, uniqueEmail('n')).expect(201);
      // Pasado el día, se puede invitar a otra persona.
      await backdate(b, 24 * 60 * 60 * 1000);
      await invite(b, targets[10]!, uniqueEmail('n')).expect(201);
    });
  });

  describe('public page', () => {
    it('ver la invitación no consume nada y las cabeceras impiden guardar el enlace', async () => {
      const b = await business('inspect');
      const email = uniqueEmail();
      await invite(b, b.invitee, email).expect(201);
      const token = lastToken();

      for (let i = 0; i < 3; i++) {
        const res = await inspect(token).expect(200);
        expect(res.body).toEqual({ memberName: 'Beto', email, expiresAt: expect.any(String) });
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.headers['referrer-policy']).toBe('no-referrer');
      }
      expect((await rows(b, b.invitee))[0]!.usedAt).toBeNull();
      expect(await prisma.account.count({ where: { username: email } })).toBe(0);
    });

    it('crear la contraseña usa el enlace una vez, ata la cuenta al socio y no inicia sesión sola', async () => {
      const b = await business('accept');
      const email = uniqueEmail();
      await invite(b, b.invitee, email).expect(201);
      const token = lastToken();

      const res = await accept(token).expect(200);
      expect(res.body).toEqual({
        ok: true,
        email,
        accountId: expect.any(String),
        device: {
          id: expect.any(String),
          identifier: expect.any(String),
          name: 'Dispositivo de Beto',
          token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        },
      });
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      // No session is handed out: only the device of this browser.
      expect(JSON.stringify(res.body)).not.toMatch(/jwt|accessToken|passwordHash/i);

      const account = await prisma.account.findFirstOrThrow({ where: { username: email } });
      expect(account).toMatchObject({ contextId: b.contextId, memberId: b.invitee, active: true });
      expect(account.passwordHash).not.toContain(PASSWORD);
      const [row] = await rows(b, b.invitee);
      expect(row).toMatchObject({ accountId: account.id });
      expect(row!.usedAt).toBeInstanceOf(Date);

      const login = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ username: email, password: PASSWORD });
      expect(login.status).toBe(200);
      const wrong = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ username: email, password: `${PASSWORD}x` });
      expect(wrong.status).toBe(401);
    });

    it('la cuenta nueva solo puede actuar como su socio', async () => {
      const b = await business('bound');
      const email = uniqueEmail();
      await invite(b, b.invitee, email).expect(201);
      await accept(lastToken()).expect(200);
      const login = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ username: email, password: PASSWORD }).expect(200);
      const token = (login.body.accessToken ?? login.body.access_token ?? login.body.token) as string;
      const ask = (memberId: string) =>
        request(app.getHttpServer()).get('/api/v1/finance/rules').auth(token, { type: 'bearer' }).set('x-member-id', memberId).set('x-device-id', b.deviceId);
      expect((await ask(b.invitee)).status).toBe(200);
      expect((await ask(b.inviter.memberId)).status).toBe(403);
    });

    it('doble clic: dos envíos a la vez dejan una sola cuenta y un solo ganador', async () => {
      const b = await business('double');
      const email = uniqueEmail();
      await invite(b, b.invitee, email).expect(201);
      const token = lastToken();

      const results = await Promise.all([accept(token), accept(token), accept(token)]);

      expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([200, 404, 404]);
      expect(await prisma.account.count({ where: { username: email } })).toBe(1);
    });

    it('enlace desconocido, usado, vencido o reemplazado: exactamente la misma respuesta', async () => {
      const b = await business('same-body');
      const email = uniqueEmail();
      await invite(b, b.invitee, email).expect(201);
      const live = lastToken();
      const unknown = 'A'.repeat(43);
      await backdate(b, 2 * 60 * 1000);
      await invite(b, b.invitee, email).expect(201); // reemplaza `live`
      const replaced = live;
      const usable = lastToken();
      await accept(usable).expect(200);
      const used = usable;
      const expiredBiz = await business('expired');
      await invite(expiredBiz, expiredBiz.invitee, uniqueEmail()).expect(201);
      const expired = lastToken();
      await backdate(expiredBiz, 73 * 60 * 60 * 1000);

      const outcomes = [];
      for (const token of [unknown, replaced, used, expired])
        outcomes.push(await inspect(token), await accept(token));
      for (const res of outcomes) {
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ code: 'INVITATION_INVALID', message: INVALID_LINK });
        expect(res.headers['cache-control']).toBe('no-store');
      }
    });

    it('si el socio ya no está activo o ya tiene cuenta, el enlace no sirve', async () => {
      const b = await business('stale');
      await invite(b, b.invitee, uniqueEmail()).expect(201);
      const token = lastToken();
      await withTestTenant(b.contextId, () => prisma.member.update({ where: { id: b.invitee }, data: { active: false } }));
      expect((await inspect(token)).status).toBe(404);
      expect((await accept(token)).status).toBe(404);
    });

    it('si el correo se ocupó mientras tanto, el enlace no sirve y no se crea nada', async () => {
      const b = await business('taken-meanwhile');
      const email = uniqueEmail();
      await invite(b, b.invitee, email).expect(201);
      const token = lastToken();
      await prisma.account.create({ data: { username: email, passwordHash: 'x', contextId: 'otro-negocio' } });
      expect((await accept(token)).status).toBe(404);
      expect((await rows(b, b.invitee))[0]!.usedAt).toBeNull();
      await prisma.account.deleteMany({ where: { contextId: 'otro-negocio' } });
    });

    it('la contraseña sigue la misma política que el cambio de contraseña', async () => {
      const b = await business('policy');
      await invite(b, b.invitee, uniqueEmail()).expect(201);
      const token = lastToken();
      expect((await accept(token, 'corta')).status).toBe(400);
      expect((await accept(token, 'x'.repeat(129))).status).toBe(400);
      expect((await rows(b, b.invitee))[0]!.usedAt).toBeNull();
      expect((await accept(token, 'x'.repeat(128))).status).toBe(200);
    });

    it('rechaza cuerpos con forma rara o campos de más', async () => {
      const post = (path: string, body: object) => request(app.getHttpServer()).post(`/api/v1/invitations/${path}`).send(body);
      expect((await post('inspect', {})).status).toBe(400);
      expect((await post('inspect', { token: 'corto' })).status).toBe(400);
      expect((await post('inspect', { token: 'A'.repeat(43), extra: 1 })).status).toBe(400);
      expect((await post('accept', { token: 'A'.repeat(43) })).status).toBe(400);
    });

    it('limita los intentos por enlace y por dirección', async () => {
      const token = 'B'.repeat(43);
      const statuses: number[] = [];
      for (let i = 0; i < 14; i++) statuses.push((await inspect(token)).status);
      expect(statuses.slice(0, 10).every((s) => s === 404)).toBe(true);
      expect(statuses.at(-1)).toBe(429);
    });
  });

  describe('la tabla no se lee por ninguna otra vía', () => {
    let client: pg.Client;
    beforeAll(async () => {
      // Conexión con el MISMO usuario que usa la API, sin sesión ni contexto.
      client = new pg.Client({ connectionString: process.env.DATABASE_URL });
      await client.connect();
    });
    afterAll(async () => client?.end());

    it('sin contexto no ve filas ni puede escribir; con otro negocio tampoco', async () => {
      const b = await business('rls');
      await invite(b, b.invitee, uniqueEmail()).expect(201);

      expect((await client.query('SELECT * FROM "AccountInvitation"')).rowCount).toBe(0);
      await expect(
        client.query(`INSERT INTO "AccountInvitation" ("id","contextId","memberId","email","tokenHash","invitedByMemberId","expiresAt") VALUES (gen_random_uuid(),'x',gen_random_uuid(),'a@b.co',repeat('a',64),gen_random_uuid(), now() + interval '1 day')`),
      ).rejects.toThrow();

      await client.query('BEGIN');
      await client.query("SELECT set_config('app.context_id', 'otro-negocio', true)");
      expect((await client.query('SELECT * FROM "AccountInvitation"')).rowCount).toBe(0);
      expect((await client.query('UPDATE "AccountInvitation" SET "usedAt" = now()')).rowCount).toBe(0);
      expect((await client.query('DELETE FROM "AccountInvitation"')).rowCount).toBe(0);
      await client.query('ROLLBACK');

      await client.query('BEGIN');
      await client.query("SELECT set_config('app.context_id', $1, true)", [b.contextId]);
      expect((await client.query('SELECT * FROM "AccountInvitation"')).rowCount).toBe(1);
      await client.query('ROLLBACK');
    });

    it('las funciones públicas devuelven solo lo mínimo y dejan el contexto como estaba', async () => {
      const b = await business('fn');
      const email = uniqueEmail();
      await invite(b, b.invitee, email).expect(201);
      const hash = hashInvitationToken(lastToken());

      const found = await client.query('SELECT * FROM account_invitation_lookup($1)', [hash]);
      expect(found.fields.map((f) => f.name)).toEqual(['memberName', 'email', 'expiresAt']);
      expect(found.rows).toEqual([{ memberName: 'Beto', email, expiresAt: expect.any(Date) }]);
      expect((await client.query('SELECT * FROM account_invitation_lookup($1)', ['0'.repeat(64)])).rowCount).toBe(0);
      expect((await client.query('SELECT * FROM account_invitation_lookup($1)', ['no es un hash'])).rowCount).toBe(0);

      await client.query('BEGIN');
      await client.query('SELECT * FROM account_invitation_lookup($1)', [hash]);
      const after = await client.query("SELECT current_setting('app.context_id', true) AS ctx");
      expect(after.rows[0].ctx ?? '').toBe('');
      expect((await client.query('SELECT * FROM "AccountInvitation"')).rowCount).toBe(0);
      expect((await client.query('SELECT * FROM "Member"')).rowCount).toBe(0);
      await client.query('ROLLBACK');
    });

    it('la función fija su search_path y se ejecuta con los permisos del dueño', async () => {
      const meta = await client.query(
        `SELECT proname, prosecdef, proconfig FROM pg_proc WHERE proname IN ('account_invitation_lookup','account_invitation_accept') ORDER BY proname`,
      );
      expect(meta.rows).toEqual([
        { proname: 'account_invitation_accept', prosecdef: true, proconfig: ['search_path=pg_catalog, public'] },
        { proname: 'account_invitation_lookup', prosecdef: true, proconfig: ['search_path=pg_catalog, public'] },
      ]);
    });

    it('ninguna ruta de la API entrega el token ni su hash', async () => {
      const b = await business('leak');
      await invite(b, b.invitee, uniqueEmail()).expect(201);
      const token = lastToken();
      const hash = hashInvitationToken(token);
      const status = await asSocio(b, request(app.getHttpServer()).get('/api/v1/members/account-status')).expect(200);
      const members = await asSocio(b, request(app.getHttpServer()).get('/api/v1/members')).expect(200);
      for (const body of [status.body, members.body, (await inspect(token)).body])
        expect(JSON.stringify(body)).not.toMatch(new RegExp(`${token}|${hash}`));
    });
  });

  describe('el dispositivo que se registra al aceptar la invitación', () => {
    const accepted = async (label: string) => {
      const b = await business(label);
      const email = uniqueEmail();
      await invite(b, b.invitee, email).expect(201);
      const res = await accept(lastToken()).expect(200);
      const login = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ username: email, password: PASSWORD }).expect(200);
      return { b, email, device: res.body.device as { id: string; name: string; token: string; identifier: string }, jwt: login.body.accessToken as string };
    };
    const asNewAccount = (a: Awaited<ReturnType<typeof accepted>>, req: request.Test, o: { token?: string | null; deviceId?: string } = {}) => {
      req.auth(a.jwt, { type: 'bearer' }).set('x-member-id', a.b.invitee).set('x-device-id', o.deviceId ?? a.device.id);
      const token = o.token === undefined ? a.device.token : o.token;
      return token ? req.set('x-device-token', token) : req;
    };
    const devicesOf = (b: Biz) => withTestTenant(b.contextId, () => prisma.device.findMany({ where: { contextId: b.contextId } }));

    it('nace activo, con solo el hash de su token, y el nombre lleva el del socio', async () => {
      const a = await accepted('dev-created');
      const row = (await devicesOf(a.b)).find((d) => d.id === a.device.id)!;
      expect(row).toMatchObject({ name: 'Dispositivo de Beto', status: 'activo', authorized: true, identifier: a.device.identifier });
      expect(row.activatedAt).toBeInstanceOf(Date);
      expect(row.tokenHash).toBe(hashDeviceToken(a.device.token));
      expect(JSON.stringify(row)).not.toContain(a.device.token);
    });

    it('con la cuenta nueva y el token del dispositivo se entra; sin token, con otro token o con un dispositivo que no existe, no', async () => {
      const a = await accepted('dev-works');
      const rules = () => request(app.getHttpServer()).get('/api/v1/finance/rules');
      expect((await asNewAccount(a, rules())).status).toBe(200);
      expect((await asNewAccount(a, rules(), { token: null })).status).toBe(403);
      expect((await asNewAccount(a, rules(), { token: 'x'.repeat(43) })).status).toBe(403);
      expect((await asNewAccount(a, rules(), { deviceId: randomUUID() })).status).toBe(403);
    });

    it('aparece en la lista de dispositivos sin token ni hash, y no se puede volver a canjear con su identificador', async () => {
      const a = await accepted('dev-listed');
      const list = await asSocio(a.b, request(app.getHttpServer()).get('/api/v1/devices')).expect(200);
      const mine = list.body.find((d: { id: string }) => d.id === a.device.id);
      expect(mine).toMatchObject({ name: 'Dispositivo de Beto', status: 'activo', legacy: false });
      expect(JSON.stringify(mine)).not.toMatch(new RegExp(`${a.device.token}|tokenHash|identifier`));
      const again = await asNewAccount(a, request(app.getHttpServer()).post('/api/v1/devices/identify').send({ identifier: a.device.identifier, name: a.device.name }));
      expect(again.status).toBe(409);
    });

    it('un socio lo revoca como a cualquier otro y deja de servir en la siguiente petición', async () => {
      const a = await accepted('dev-revoke');
      const rules = () => request(app.getHttpServer()).get('/api/v1/finance/rules');
      expect((await asNewAccount(a, rules())).status).toBe(200);

      await asSocio(a.b, request(app.getHttpServer()).patch(`/api/v1/devices/${a.device.id}/revoke`)).expect(200);

      expect((await asNewAccount(a, rules())).status).toBe(403);
      const after = (await asSocio(a.b, request(app.getHttpServer()).get('/api/v1/devices')).expect(200)).body;
      expect(after.find((d: { id: string }) => d.id === a.device.id)).toMatchObject({ status: 'revocado' });
    });

    it('doble clic: tres envíos a la vez dejan una cuenta y un dispositivo, y solo uno recibe el token', async () => {
      const b = await business('dev-race');
      await invite(b, b.invitee, uniqueEmail()).expect(201);
      const token = lastToken();
      const before = (await devicesOf(b)).length;

      const results = await Promise.all([accept(token), accept(token), accept(token)]);

      expect(results.map((r) => r.status).sort((x, y) => x - y)).toEqual([200, 404, 404]);
      expect(results.filter((r) => r.body.device).length).toBe(1);
      expect((await devicesOf(b)).length).toBe(before + 1);
    });

    it('un enlace que no sirve no crea dispositivo', async () => {
      const b = await business('dev-none');
      const before = (await devicesOf(b)).length;
      await accept('A'.repeat(43)).expect(404);
      await invite(b, b.invitee, uniqueEmail()).expect(201);
      const token = lastToken();
      await accept(token, 'corta').expect(400);
      await withTestTenant(b.contextId, () => prisma.member.update({ where: { id: b.invitee }, data: { active: false } }));
      await accept(token).expect(404);
      expect((await devicesOf(b)).length).toBe(before);
    });

    it('si el correo se ocupó mientras tanto no se crea ni cuenta ni dispositivo', async () => {
      const b = await business('dev-taken');
      const email = uniqueEmail();
      await invite(b, b.invitee, email).expect(201);
      const token = lastToken();
      await prisma.account.create({ data: { username: email, passwordHash: 'x', contextId: 'otro-negocio-dev' } });
      const before = (await devicesOf(b)).length;
      await accept(token).expect(404);
      expect((await devicesOf(b)).length).toBe(before);
      await prisma.account.deleteMany({ where: { contextId: 'otro-negocio-dev' } });
    });

    it('un socio que ya tiene cuenta atada sigue sin poder ser invitado (409), sin crear dispositivo', async () => {
      const b = await business('dev-409');
      const before = (await devicesOf(b)).length;
      await invite(b, b.inviter.memberId, uniqueEmail()).expect(409);
      expect((await devicesOf(b)).length).toBe(before);
    });

    it('el token no aparece en ningún registro del servidor', async () => {
      const logged: string[] = [];
      const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map((level) =>
        vi.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => void logged.push(JSON.stringify(args))),
      );
      const a = await accepted('dev-logs');
      spies.forEach((s) => s.mockRestore());
      expect(logged.join('')).not.toContain(a.device.token);
    });
  });

  describe('acceso compartido (cuenta sin socio atado)', () => {
    const BLOCKED = 'Tu acceso es compartido y ya hay cuentas personales. Pídele a un socio con cuenta personal que te invite.';
    const SELF_ONLY = 'Con el acceso compartido solo puedes invitar al socio que elegiste en este momento.';
    interface Shared { contextId: string; deviceId: string; token: string; ana: string; beto: string }

    /** A business as every legacy one starts: one shared login, two socios, nobody with a personal login. */
    const sharedBusiness = async (label: string, socios = 2): Promise<Shared> => {
      const contextId = `inv-${label}-${randomUUID()}`;
      contexts.push(contextId);
      const account = await prisma.account.create({ data: { username: uniqueEmail('shared'), passwordHash: 'x', contextId } });
      const token = await app.get(JwtService).signAsync({ sub: account.id });
      return withTestTenant(contextId, async () => {
        const deviceId = (await prisma.device.create({ data: { contextId, name: 'Tablet', authorized: true } })).id;
        const ana = (await prisma.member.create({ data: { contextId, name: 'Ana', role: 'socio' } })).id;
        const beto = socios > 1 ? (await prisma.member.create({ data: { contextId, name: 'Beto', role: 'socio' } })).id : '';
        return { contextId, deviceId, token, ana, beto };
      });
    };
    const asShared = (s: Shared, as: string, req: request.Test) =>
      req.auth(s.token, { type: 'bearer' }).set('x-member-id', as).set('x-device-id', s.deviceId);
    const sharedInvite = (s: Shared, as: string, target: string, email: string) =>
      asShared(s, as, request(app.getHttpServer()).post(`/api/v1/members/${target}/invitation`).send({ email }));
    const sharedStatus = (s: Shared, as: string) =>
      asShared(s, as, request(app.getHttpServer()).get('/api/v1/members/account-status'));
    const login = async (email: string) =>
      (await request(app.getHttpServer()).post('/api/v1/auth/login').send({ username: email, password: PASSWORD }).expect(200)).body.accessToken as string;

    it('puede invitar al socio elegido si nadie tiene cuenta personal, y la invitación queda anotada', async () => {
      const s = await sharedBusiness('sh-self');
      const email = uniqueEmail();
      await sharedInvite(s, s.ana, s.ana, email).expect(201);
      const [row] = await withTestTenant(s.contextId, () => prisma.accountInvitation.findMany({ where: { contextId: s.contextId } }));
      expect(row).toMatchObject({ memberId: s.ana, invitedByMemberId: s.ana, invitedViaSharedLogin: true });
    });

    it('no puede invitar a otro socio, ni siquiera cuando todavía no hay cuentas personales', async () => {
      const s = await sharedBusiness('sh-other');
      const res = await sharedInvite(s, s.ana, s.beto, uniqueEmail()).expect(403);
      expect(res.body).toEqual({ code: 'INVITATION_SHARED_SELF_ONLY', message: SELF_ONLY });
      expect(sendInvitation).not.toHaveBeenCalled();
      expect(await withTestTenant(s.contextId, () => prisma.accountInvitation.count({ where: { contextId: s.contextId } }))).toBe(0);
    });

    it('en cuanto existe una cuenta personal, el acceso compartido no invita a nadie y se le explica qué hacer', async () => {
      const s = await sharedBusiness('sh-blocked');
      await sharedInvite(s, s.ana, s.ana, uniqueEmail()).expect(201);
      await accept(lastToken()).expect(200);
      sendInvitation.mockClear();

      for (const [as, target] of [[s.beto, s.beto], [s.ana, s.beto], [s.beto, s.ana]] as const) {
        const res = await sharedInvite(s, as, target, uniqueEmail()).expect(403);
        expect(res.body).toEqual({ code: 'INVITATION_SHARED_BLOCKED', message: BLOCKED });
      }
      expect(sendInvitation).not.toHaveBeenCalled();
    });

    it('la cuenta personal que se creó sí puede invitar a los demás socios, y esa invitación no se marca como compartida', async () => {
      const s = await sharedBusiness('sh-then-personal');
      const anaEmail = uniqueEmail();
      await sharedInvite(s, s.ana, s.ana, anaEmail).expect(201);
      await accept(lastToken()).expect(200);
      const personalToken = await login(anaEmail);

      const personal = (target: string, email: string) =>
        request(app.getHttpServer()).post(`/api/v1/members/${target}/invitation`).auth(personalToken, { type: 'bearer' })
          .set('x-member-id', s.ana).set('x-device-id', s.deviceId).send({ email });
      await personal(s.beto, uniqueEmail()).expect(201);
      const rows = await withTestTenant(s.contextId, () => prisma.accountInvitation.findMany({ where: { contextId: s.contextId, memberId: s.beto } }));
      expect(rows[0]!.invitedViaSharedLogin).toBe(false);
      // Quien ya tiene cuenta atada no se puede invitar.
      await personal(s.ana, uniqueEmail()).expect(409);
    });

    it('la lista del equipo dice por cada socio si el acceso compartido puede invitarlo y por qué no', async () => {
      const s = await sharedBusiness('sh-status');
      const before = (await sharedStatus(s, s.ana).expect(200)).body;
      expect(before.map((r: { memberId: string; invite: unknown }) => [r.memberId, r.invite])).toEqual([
        [s.ana, { allowed: true, reason: null }],
        [s.beto, { allowed: false, reason: SELF_ONLY }],
      ]);

      await sharedInvite(s, s.ana, s.ana, uniqueEmail()).expect(201);
      await accept(lastToken()).expect(200);
      const after = (await sharedStatus(s, s.beto).expect(200)).body;
      expect(after[0].invite).toEqual({ allowed: false, reason: null }); // ya tiene cuenta
      expect(after[1].invite).toEqual({ allowed: false, reason: BLOCKED });
    });

    it('una cuenta personal de un colaborador no bloquea al acceso compartido', async () => {
      const s = await sharedBusiness('sh-colab');
      await withTestTenant(s.contextId, async () => {
        const colab = await prisma.member.create({ data: { contextId: s.contextId, name: 'Colab', role: 'colaborador' } });
        await prisma.account.create({ data: { username: uniqueEmail('colab'), passwordHash: 'x', contextId: s.contextId, memberId: colab.id } });
      });
      await sharedInvite(s, s.ana, s.ana, uniqueEmail()).expect(201);
    });

    it('un negocio con un solo socio sigue igual que antes: el acceso compartido se invita a sí mismo', async () => {
      const s = await sharedBusiness('sh-solo', 1);
      await sharedInvite(s, s.ana, s.ana, uniqueEmail()).expect(201);
    });

  });

  describe('estado de las cuentas para el equipo', () => {
    it('solo socios lo ven y muestra quién ya tiene cuenta, quién tiene invitación y cuándo puede reenviarse', async () => {
      const b = await business('status');
      await asSocio(b, request(app.getHttpServer()).get('/api/v1/members/account-status'), b.colaborador).expect(403);

      const before = (await asSocio(b, request(app.getHttpServer()).get('/api/v1/members/account-status')).expect(200)).body;
      expect(before).toEqual([
        { memberId: b.inviter.memberId, name: 'Ana', hasPersonalAccount: true, invite: { allowed: false, reason: null }, invitation: null },
        { memberId: b.invitee, name: 'Beto', hasPersonalAccount: false, invite: { allowed: true, reason: null }, invitation: null },
      ]);

      const email = uniqueEmail();
      await invite(b, b.invitee, email).expect(201);
      const sent = (await asSocio(b, request(app.getHttpServer()).get('/api/v1/members/account-status')).expect(200)).body;
      expect(sent[1].invitation).toEqual({
        email, sentAt: expect.any(String), expiresAt: expect.any(String), canResendAt: expect.any(String), resendsLeftToday: 2,
      });
      expect(new Date(sent[1].invitation.canResendAt).getTime() - new Date(sent[1].invitation.sentAt).getTime()).toBe(60_000);

      await accept(lastToken()).expect(200);
      const after = (await asSocio(b, request(app.getHttpServer()).get('/api/v1/members/account-status')).expect(200)).body;
      expect(after[1]).toMatchObject({ hasPersonalAccount: true, invitation: null });
    });
  });
});

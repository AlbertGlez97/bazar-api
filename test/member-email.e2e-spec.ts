import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { Logger, type INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { hashPassword } from '../src/common/password.js';
import { hashSingleUseToken } from '../src/common/single-use-token.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { EmailService } from '../src/email/email.service.js';
import { purgeRuleData } from './rules-cleanup.js';
import { withTestTenant } from './tenant-scope.js';

const INVALID_LINK = 'Este enlace no sirve. Escribe tu correo de nuevo para recibir otro.';
const IN_USE = 'Ese correo ya está en uso. Usa otro correo.';
const DAY = 24 * 3600_000;

interface Who {
  memberId: string;
  token: string;
  name: string;
}
interface Biz {
  contextId: string;
  deviceId: string;
  socios: Who[];
  colaborador: Who;
}

describe('a socio writes their own address, and confirms it with a link', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const sendConfirmation = vi.fn().mockResolvedValue(undefined);
  const sendNotice = vi.fn().mockResolvedValue(undefined);
  const contexts: string[] = [];
  const addresses = new Set<string>();
  const unique = (label = 'u') => {
    const correo = `${label}-${randomUUID()}@example.test`;
    addresses.add(correo);
    return correo;
  };

  /** `count` socios without an address (unless `withCorreo` says so) and a colaborador. */
  const business = async (label: string, count = 2, withCorreo: number[] = []): Promise<Biz> => {
    const contextId = `memail-${label}-${randomUUID()}`;
    contexts.push(contextId);
    const jwt = app.get(JwtService);
    return withTestTenant(contextId, async () => {
      const deviceId = (await prisma.device.create({ data: { contextId, name: 'Tablet', authorized: true } })).id;
      const make = async (name: string, role: 'socio' | 'colaborador', correo: string | null): Promise<Who> => {
        const member = await prisma.member.create({ data: { contextId, name, role, correo } });
        const account = await prisma.account.create({
          data: { username: unique('login'), passwordHash: 'x', contextId, memberId: member.id },
        });
        return { memberId: member.id, token: await jwt.signAsync({ sub: account.id }), name };
      };
      const names = ['Ana', 'Beto', 'Carla'];
      const socios: Who[] = [];
      for (let i = 0; i < count; i++) socios.push(await make(names[i]!, 'socio', withCorreo.includes(i) ? unique(names[i]!.toLowerCase()) : null));
      return { contextId, deviceId, socios, colaborador: await make('Colaborador', 'colaborador', null) };
    });
  };

  const as = (b: Biz, who: Who, req: request.Test) =>
    req.auth(who.token, { type: 'bearer' }).set('x-member-id', who.memberId).set('x-device-id', b.deviceId);
  const status = (b: Biz, who: Who) => as(b, who, request(app.getHttpServer()).get('/api/v1/members/me/email'));
  const write = (b: Biz, who: Who, correo: string) =>
    as(b, who, request(app.getHttpServer()).put('/api/v1/members/me/email').send({ correo }));
  const inspect = (token: string) => request(app.getHttpServer()).post('/api/v1/member-emails/inspect').send({ token });
  const confirm = (token: string) => request(app.getHttpServer()).post('/api/v1/member-emails/confirm').send({ token });
  /** The token the (mocked) confirmation email carried. */
  const lastToken = () => (sendConfirmation.mock.calls.at(-1)![0] as { confirmUrl: string }).confirmUrl.split('/confirmar-correo/')[1]!;
  const correoOf = (b: Biz, who: Who) =>
    withTestTenant(b.contextId, async () => (await prisma.member.findUniqueOrThrow({ where: { id: who.memberId } })).correo);

  beforeAll(async () => {
    process.env.PUBLIC_SITE_URL = 'https://site.test';
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EmailService)
      .useValue({
        sendMemberEmailConfirmationEmail: sendConfirmation,
        sendMemberEmailRegisteredNoticeEmail: sendNotice,
      })
      .compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
    prisma = app.get(PrismaService);
  });
  afterAll(async () => {
    if (prisma) {
      await purgeRuleData(contexts);
      for (const contextId of contexts) {
        await prisma.account.deleteMany({ where: { contextId } });
        await withTestTenant(contextId, async () => {
          await prisma.device.deleteMany({ where: { contextId } });
          await prisma.member.deleteMany({ where: { contextId } });
        });
      }
      await prisma.account.deleteMany({ where: { username: { in: [...addresses] } } });
    }
    await app?.close();
  });
  beforeEach(() => {
    sendConfirmation.mockClear();
    sendNotice.mockClear();
  });

  describe('asking for the confirmation', () => {
    it('emails the link to the typed address only, changes nothing yet, and shows the pending address masked', async () => {
      const b = await business('ask');
      const ana = b.socios[0]!;
      const correo = unique('ana');
      expect((await status(b, ana).expect(200)).body).toEqual({ correo: null, pending: null });

      const res = await write(b, ana, `  ${correo.toUpperCase()} `).expect(200);
      expect(res.body).toEqual({ ok: true, correo: expect.stringMatching(/^a\*\*\*@e\*\*\*\.test$/), expiresAt: expect.any(String) });
      expect(sendConfirmation).toHaveBeenCalledTimes(1);
      expect(sendConfirmation.mock.calls[0]![0]).toMatchObject({
        to: correo,
        memberName: 'Ana',
        expiresInHours: 48,
        confirmUrl: expect.stringMatching(/^https:\/\/site\.test\/confirmar-correo\/[A-Za-z0-9_-]{43}$/),
      });
      expect(await correoOf(b, ana)).toBeNull();
      expect((await status(b, ana).expect(200)).body).toMatchObject({ correo: null, pending: { correo: expect.stringMatching(/^a\*\*\*@/) } });
    });

    it('stores only the hash of the token', async () => {
      const b = await business('hash');
      await write(b, b.socios[0]!, unique()).expect(200);
      const [row] = await withTestTenant(b.contextId, () => prisma.memberEmailConfirmation.findMany({ where: { contextId: b.contextId } }));
      expect(row!.tokenHash).toBe(hashSingleUseToken(lastToken()));
      expect(JSON.stringify(row)).not.toContain(lastToken());
      expect(row!.expiresAt.getTime() - row!.createdAt.getTime()).toBe(2 * DAY);
    });

    it('rejects what is not an address, in plain Spanish', async () => {
      const b = await business('invalid');
      for (const typed of ['ana', 'ana@', 'a b@c.co', 'Ana <a@b.co>', 'a@b.co, c@d.co']) {
        const res = await write(b, b.socios[0]!, typed).expect(400);
        expect(res.body).toMatchObject({ code: 'MEMBER_EMAIL_INVALID', message: 'Escribe un correo válido, por ejemplo nombre@dominio.com' });
      }
      expect(sendConfirmation).not.toHaveBeenCalled();
    });

    it('nobody can write someone else\'s address: there is no way to name another person', async () => {
      const b = await business('other');
      const [ana, beto] = b.socios as [Who, Who];
      const typed = unique('beto');
      await as(b, ana, request(app.getHttpServer()).put('/api/v1/members/me/email').send({ correo: typed, memberId: beto.memberId })).expect(400);
      await as(b, ana, request(app.getHttpServer()).put(`/api/v1/members/${beto.memberId}/email`).send({ correo: typed })).expect(404);
      await write(b, ana, typed).expect(200);
      await confirm(lastToken()).expect(200);
      expect(await correoOf(b, ana)).toBe(typed);
      expect(await correoOf(b, beto)).toBeNull();
    });

    it('a colaborador is refused', async () => {
      const b = await business('colab');
      await status(b, b.colaborador).expect(403);
      await write(b, b.colaborador, unique()).expect(403);
    });

    it('a socio who already has an address cannot write another one here', async () => {
      const b = await business('has', 1, [0]);
      const res = await write(b, b.socios[0]!, unique()).expect(409);
      expect(res.body).toMatchObject({ code: 'MEMBER_EMAIL_ALREADY_SET', message: 'Ya tienes un correo registrado.' });
      expect(sendConfirmation).not.toHaveBeenCalled();
    });

    it('a new request replaces the previous link', async () => {
      const b = await business('replace');
      await write(b, b.socios[0]!, unique('first')).expect(200);
      const old = lastToken();
      await write(b, b.socios[0]!, unique('second')).expect(200);
      expect((await inspect(old)).status).toBe(404);
      expect((await inspect(lastToken())).status).toBe(200);
    });

    it('when the email cannot be sent the link is retired and the socio is told', async () => {
      const b = await business('fail');
      sendConfirmation.mockRejectedValueOnce(new Error('boom'));
      const res = await write(b, b.socios[0]!, unique()).expect(422);
      expect(res.body).toMatchObject({ code: 'MEMBER_EMAIL_NOT_SENT' });
      expect((await inspect(lastToken())).status).toBe(404);
      expect((await status(b, b.socios[0]!).expect(200)).body.pending).toBeNull();
    });

    it('limits how many confirmation emails a socio can ask for in an hour', async () => {
      const b = await business('limit');
      const codes: number[] = [];
      for (let i = 0; i < 6; i++) codes.push((await write(b, b.socios[0]!, unique())).status);
      expect(codes).toEqual([200, 200, 200, 200, 200, 429]);
    });
  });

  describe('an address that is already in use', () => {
    it('is refused when a person of the same business has it', async () => {
      const b = await business('same', 2, [1]);
      const taken = await correoOf(b, b.socios[1]!);
      const res = await write(b, b.socios[0]!, taken!.toUpperCase()).expect(409);
      expect(res.body).toMatchObject({ code: 'MEMBER_EMAIL_IN_USE', message: IN_USE });
      expect(sendConfirmation).not.toHaveBeenCalled();
    });

    it('is refused when a person of ANOTHER business has it, and the answer does not say where', async () => {
      const a = await business('x-a');
      const other = await business('x-b', 1, [0]);
      const taken = await correoOf(other, other.socios[0]!);
      const res = await write(a, a.socios[0]!, taken!).expect(409);
      expect(res.body).toMatchObject({ code: 'MEMBER_EMAIL_IN_USE', message: IN_USE });
      expect(JSON.stringify(res.body)).not.toContain(other.contextId);
      expect(sendConfirmation).not.toHaveBeenCalled();
      // Asking did not give the address to anyone.
      expect(await correoOf(a, a.socios[0]!)).toBeNull();
      expect(await correoOf(other, other.socios[0]!)).toBe(taken);
    });

    it('is refused when it is the login of someone else, but allowed for the shared login of the SAME business or the socio\'s own login', async () => {
      const b = await business('login');
      const elsewhere = unique('elsewhere');
      await prisma.account.create({ data: { username: elsewhere, passwordHash: 'x', contextId: `memail-other-${randomUUID()}` } });
      contexts.push((await prisma.account.findUniqueOrThrow({ where: { username: elsewhere } })).contextId);
      expect((await write(b, b.socios[0]!, elsewhere).expect(409)).body.code).toBe('MEMBER_EMAIL_IN_USE');

      // The login of another member of this business.
      const beto = await prisma.account.findFirstOrThrow({ where: { memberId: b.socios[1]!.memberId } });
      expect((await write(b, b.socios[0]!, beto.username).expect(409)).body.code).toBe('MEMBER_EMAIL_IN_USE');

      // The shared login of this business (the founder's registration address).
      const shared = unique('shared');
      await prisma.account.create({ data: { username: shared, passwordHash: 'x', contextId: b.contextId } });
      await write(b, b.socios[0]!, shared).expect(200);

      // The socio's own login.
      const own = await prisma.account.findFirstOrThrow({ where: { memberId: b.socios[0]!.memberId } });
      await write(b, b.socios[0]!, own.username).expect(200);
    });

    it('two socios asking for the same address: the first to confirm gets it, the other link stops working', async () => {
      const a = await business('race-a', 1);
      const c = await business('race-b', 1);
      const shared = unique('shared');
      await write(a, a.socios[0]!, shared).expect(200);
      const first = lastToken();
      await write(c, c.socios[0]!, shared).expect(200);
      const second = lastToken();

      await confirm(first).expect(200);
      expect((await confirm(second)).status).toBe(404);
      expect(await correoOf(a, a.socios[0]!)).toBe(shared);
      expect(await correoOf(c, c.socios[0]!)).toBeNull();
      expect((await status(c, c.socios[0]!).expect(200)).body.correo).toBeNull();
    });

    it('two confirmations of the same link at the same moment give the address once', async () => {
      const b = await business('twice', 1);
      await write(b, b.socios[0]!, unique()).expect(200);
      const token = lastToken();
      const codes = (await Promise.all([confirm(token), confirm(token), confirm(token)])).map((r) => r.status);
      expect(codes.filter((code) => code === 200)).toHaveLength(1);
      expect(codes.filter((code) => code === 404)).toHaveLength(2);
    });
  });

  describe('the public page', () => {
    it('GET does not exist, and inspect shows whose address it is without consuming the link', async () => {
      const b = await business('page');
      const correo = unique('ana');
      await write(b, b.socios[0]!, correo).expect(200);
      const token = lastToken();
      await request(app.getHttpServer()).get('/api/v1/member-emails/confirm').expect(404);
      await request(app.getHttpServer()).get(`/api/v1/member-emails/inspect/${token}`).expect(404);

      const first = await inspect(token).expect(200);
      expect(first.headers['cache-control']).toBe('no-store');
      expect(first.headers['referrer-policy']).toBe('no-referrer');
      expect(first.body).toEqual({ memberName: 'Ana', correo: expect.stringMatching(/^a\*\*\*@/), expiresAt: expect.any(String) });
      expect(JSON.stringify(first.body)).not.toContain(correo);
      expect((await inspect(token).expect(200)).body).toEqual(first.body);
      expect(await correoOf(b, b.socios[0]!)).toBeNull();
    });

    it('confirming gives the address to the member, once; then the link is dead', async () => {
      const b = await business('confirm');
      const correo = unique('ana');
      await write(b, b.socios[0]!, correo).expect(200);
      const token = lastToken();
      const res = await confirm(token).expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toEqual({ ok: true, correo: expect.stringMatching(/^a\*\*\*@/) });
      expect(await correoOf(b, b.socios[0]!)).toBe(correo);
      expect((await confirm(token)).status).toBe(404);
      expect((await inspect(token)).status).toBe(404);
      expect((await status(b, b.socios[0]!).expect(200)).body).toMatchObject({ correo: expect.stringMatching(/^a\*\*\*@/), pending: null });
    });

    it('unknown, used, replaced, expired and left-business links all get the SAME answer', async () => {
      const b = await business('same');
      const answers: unknown[] = [];
      answers.push((await inspect('A'.repeat(43))).body);

      await write(b, b.socios[0]!, unique()).expect(200);
      const replaced = lastToken();
      await write(b, b.socios[0]!, unique()).expect(200);
      answers.push((await inspect(replaced)).body, (await confirm(replaced)).body);

      const expired = lastToken();
      await withTestTenant(b.contextId, () =>
        prisma.memberEmailConfirmation.updateMany({
          where: { tokenHash: hashSingleUseToken(expired) },
          data: { createdAt: new Date(Date.now() - 4 * DAY), expiresAt: new Date(Date.now() - DAY) },
        }),
      );
      answers.push((await inspect(expired)).body, (await confirm(expired)).body);

      await write(b, b.socios[1]!, unique()).expect(200);
      const left = lastToken();
      await withTestTenant(b.contextId, () => prisma.member.update({ where: { id: b.socios[1]!.memberId }, data: { active: false } }));
      answers.push((await inspect(left)).body, (await confirm(left)).body);

      for (const body of answers) expect(body).toMatchObject({ code: 'MEMBER_EMAIL_LINK_INVALID', message: INVALID_LINK });
      expect(answers).toHaveLength(7);
    });

    it('rejects shapes it does not understand, and limits the attempts per link', async () => {
      expect((await inspect('corto')).status).toBe(400);
      expect((await request(app.getHttpServer()).post('/api/v1/member-emails/confirm').send({})).status).toBe(400);
      expect((await request(app.getHttpServer()).post('/api/v1/member-emails/confirm').send({ token: 'A'.repeat(43), extra: 1 })).status).toBe(400);
      const statuses: number[] = [];
      for (let i = 0; i < 14; i++) statuses.push((await inspect('B'.repeat(43))).status);
      expect(statuses.slice(0, 10).every((code) => code === 404)).toBe(true);
      expect(statuses.at(-1)).toBe(429);
    });
  });

  describe('the other socios hear about it', () => {
    it('each other socio with an address gets a notice with the name and a masked address; the rest do not', async () => {
      const b = await business('notice', 3, [1]);
      const correo = unique('ana');
      await write(b, b.socios[0]!, correo).expect(200);
      await confirm(lastToken()).expect(200);

      expect(sendNotice).toHaveBeenCalledTimes(1);
      expect(sendNotice.mock.calls[0]![0]).toMatchObject({
        memberName: 'Beto',
        registeredName: 'Ana',
        maskedCorreo: expect.stringMatching(/^a\*\*\*@e\*\*\*\.test$/),
        businessName: 'tu negocio',
      });
      expect(JSON.stringify(sendNotice.mock.calls)).not.toContain(correo);
    });

    it('a failing notice never undoes the confirmation', async () => {
      const b = await business('notice-fail', 2, [1]);
      sendNotice.mockRejectedValueOnce(new Error('boom'));
      const correo = unique('ana');
      await write(b, b.socios[0]!, correo).expect(200);
      await confirm(lastToken()).expect(200);
      expect(await correoOf(b, b.socios[0]!)).toBe(correo);
    });
  });

  describe('what stays out of logs', () => {
    it('no token appears in any log line', async () => {
      const logged: string[] = [];
      const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map((level) =>
        vi.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => void logged.push(JSON.stringify(args))),
      );
      const out = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => (logged.push(String(chunk)), true)) as never);
      try {
        const b = await business('logs', 1);
        sendConfirmation.mockRejectedValueOnce(new Error('boom'));
        await write(b, b.socios[0]!, unique()).expect(422);
        const failed = lastToken();
        await write(b, b.socios[0]!, unique()).expect(200);
        const good = lastToken();
        await inspect(good).expect(200);
        await confirm(good).expect(200);
        await inspect(failed);
        for (const token of [failed, good]) expect(logged.join('\n')).not.toContain(token);
      } finally {
        spies.forEach((spy) => spy.mockRestore());
        out.mockRestore();
      }
    });
  });

  describe('signing in treats an address the same however it is typed', () => {
    const login = (username: string, password: string) =>
      request(app.getHttpServer()).post('/api/v1/auth/login').send({ username, password });

    it('upper-case and surrounding spaces still find the account; a wrong password still fails', async () => {
      const contextId = `memail-login-${randomUUID()}`;
      contexts.push(contextId);
      const username = unique('socio');
      await prisma.account.create({ data: { username, passwordHash: await hashPassword('una-clave-larga-1'), contextId } });

      expect((await login(username, 'una-clave-larga-1')).status).toBe(200);
      expect((await login(username.toUpperCase(), 'una-clave-larga-1')).status).toBe(200);
      expect((await login(`  ${username} `, 'una-clave-larga-1')).status).toBe(200);
      expect((await login(username.toUpperCase(), 'otra-clave-larga-1')).status).toBe(401);
      expect((await login(`otro-${username}`, 'una-clave-larga-1')).status).toBe(401);
    });

    it('an older account stored with capitals keeps working exactly as typed', async () => {
      const contextId = `memail-login-old-${randomUUID()}`;
      contexts.push(contextId);
      const username = `Antiguo-${randomUUID()}@Example.test`;
      addresses.add(username);
      await prisma.account.create({ data: { username, passwordHash: await hashPassword('una-clave-larga-1'), contextId } });

      expect((await login(username, 'una-clave-larga-1')).status).toBe(200);
      expect((await login(username.toLowerCase(), 'una-clave-larga-1')).status).toBe(401);
    });
  });
});

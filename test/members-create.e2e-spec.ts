import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { EmailService } from '../src/email/email.service.js';
import { withTestTenant } from './tenant-scope.js';
import { expectUuidV7 } from './uuid-v7.js';

/**
 * BE-12 (task T5): `POST /members`. A socio adds a socio or a colaborador
 * inside its own business. The endpoint creates the Member AND its own login
 * (Account bound to that Member through `Account.memberId`) in one
 * transaction, then emails the username and a temporary password. If the
 * email cannot be sent nothing is persisted (502). The `correo` is only used
 * to send the credentials: it is not stored.
 *
 * `POST /sales` with an empty body is the probe for "did ContextGuard let the
 * request through": 400 when the guard passes, 403 when it does not.
 */
describe('members: adding socios and colaboradores (BE-12)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const sendCredentials = vi.fn();

  const contextId = `be12-members-${randomUUID()}`;
  const otherContextId = `be12-members-other-${randomUUID()}`;

  let sharedToken: string; // unbound login (the shared business login)
  let boundColaboradorToken: string; // login bound to the colaborador
  let otherToken: string; // login of the other business
  let socioId: string;
  let colaboradorId: string;
  let otherSocioId: string;
  let actingDeviceId: string;
  let otherActingDeviceId: string;

  const http = () => request(app.getHttpServer());

  const asSocio = (req: request.Test) =>
    req
      .auth(sharedToken, { type: 'bearer' })
      .set('x-member-id', socioId)
      .set('x-device-id', actingDeviceId);

  const asSharedColaborador = (req: request.Test) =>
    req
      .auth(sharedToken, { type: 'bearer' })
      .set('x-member-id', colaboradorId)
      .set('x-device-id', actingDeviceId);

  const asBoundColaborador = (req: request.Test) =>
    req
      .auth(boundColaboradorToken, { type: 'bearer' })
      .set('x-member-id', colaboradorId)
      .set('x-device-id', actingDeviceId);

  const asOtherSocio = (req: request.Test) =>
    req
      .auth(otherToken, { type: 'bearer' })
      .set('x-member-id', otherSocioId)
      .set('x-device-id', otherActingDeviceId);

  const uniqueCorreo = () => `${randomUUID()}@example.test`;

  const valid = (overrides: Record<string, unknown> = {}) => ({
    nombre: 'Nueva',
    apellidos: 'Persona',
    correo: uniqueCorreo(),
    role: 'colaborador',
    ...overrides,
  });

  /** The last credentials email the mocked EmailService was asked to send. */
  const lastEmail = () =>
    sendCredentials.mock.calls.at(-1)?.[0] as {
      to: string;
      memberName: string;
      username: string;
      temporaryPassword: string;
      role: string;
    };

  const memberRow = (id: string, ctx = contextId) =>
    withTestTenant(ctx, () => prisma.member.findUnique({ where: { id } }));

  const probe = (token: string, memberId: string) =>
    http()
      .post('/sales')
      .auth(token, { type: 'bearer' })
      .set('x-member-id', memberId)
      .set('x-device-id', actingDeviceId)
      .send({});

  const login = (username: string, password: string) =>
    http().post('/auth/login').send({ username, password });

  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EmailService)
      .useValue({ sendMemberCredentialsEmail: sendCredentials })
      .compile();
    app = module.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    const jwt = app.get(JwtService);

    await withTestTenant(contextId, async () => {
      socioId = (
        await prisma.member.create({
          data: { name: 'Members Socio', role: 'socio', contextId },
        })
      ).id;
      colaboradorId = (
        await prisma.member.create({
          data: { name: 'Members Colaborador', role: 'colaborador', contextId },
        })
      ).id;
      actingDeviceId = (
        await prisma.device.create({
          data: {
            name: 'acting legacy',
            identifier: randomUUID(),
            contextId,
            authorized: true,
          },
        })
      ).id;
    });
    await withTestTenant(otherContextId, async () => {
      otherSocioId = (
        await prisma.member.create({
          data: { name: 'Other Socio', role: 'socio', contextId: otherContextId },
        })
      ).id;
      otherActingDeviceId = (
        await prisma.device.create({
          data: {
            name: 'other acting',
            identifier: randomUUID(),
            contextId: otherContextId,
            authorized: true,
          },
        })
      ).id;
    });

    const account = (ctx: string, memberId?: string) =>
      prisma.account
        .create({
          data: {
            username: randomUUID(),
            passwordHash: 'not-a-login-fixture',
            contextId: ctx,
            ...(memberId ? { memberId } : {}),
          },
        })
        .then((a) => jwt.signAsync({ sub: a.id }));
    sharedToken = await account(contextId);
    boundColaboradorToken = await account(contextId, colaboradorId);
    otherToken = await account(otherContextId);
  });

  beforeEach(() => {
    sendCredentials.mockReset();
    sendCredentials.mockResolvedValue({ deliveredTo: 'member' });
  });

  afterAll(async () => {
    if (prisma) {
      // Accounts first: Account.memberId is ON DELETE RESTRICT.
      await prisma.account.deleteMany({
        where: { contextId: { in: [contextId, otherContextId] } },
      });
      for (const ctx of [contextId, otherContextId]) {
        await withTestTenant(ctx, async () => {
          await prisma.device.deleteMany({ where: { contextId: ctx } });
          await prisma.member.deleteMany({ where: { contextId: ctx } });
        });
      }
    }
    await app?.close();
  });

  describe('a socio adds a person', () => {
    it('creates a colaborador with its own bound login and emails the credentials', async () => {
      const correo = `  ${uniqueCorreo().toUpperCase()}  `;
      const res = await asSocio(http().post('/members'))
        .send(valid({ correo, commissionRateBps: 1500 }))
        .expect(201);

      expect(res.body).toEqual({
        id: expect.any(String),
        name: 'Nueva Persona',
        role: 'colaborador',
        active: true,
        commissionRateBps: 1500,
        createdByMemberId: socioId,
        username: expect.any(String),
        credentialsEmail: 'member',
      });
      expectUuidV7(res.body.id);

      const member = await memberRow(res.body.id);
      expect(member).toMatchObject({
        name: 'Nueva Persona',
        role: 'colaborador',
        contextId,
        active: true,
        commissionRateBps: 1500,
        createdByMemberId: socioId,
      });

      const account = await prisma.account.findUniqueOrThrow({
        where: { username: res.body.username },
      });
      expect(account).toMatchObject({
        memberId: res.body.id,
        contextId,
        active: true,
      });
      expectUuidV7(account.id);
      expect(account.passwordHash).toMatch(/^\$argon2id\$/);

      expect(sendCredentials).toHaveBeenCalledTimes(1);
      const email = lastEmail();
      expect(email).toMatchObject({
        to: correo.trim().toLowerCase(),
        memberName: 'Nueva Persona',
        username: res.body.username,
        role: 'colaborador',
      });
      expect(email.temporaryPassword.length).toBeGreaterThanOrEqual(20);
    });

    it('never returns the password or its hash', async () => {
      const res = await asSocio(http().post('/members')).send(valid()).expect(201);

      const body = JSON.stringify(res.body);
      expect(body).not.toContain(lastEmail().temporaryPassword);
      expect(body).not.toMatch(/argon2/);
      expect(res.body).not.toHaveProperty('password');
      expect(res.body).not.toHaveProperty('passwordHash');
      expect(res.body).not.toHaveProperty('temporaryPassword');
    });

    it('does not store the correo anywhere', async () => {
      const correo = uniqueCorreo();
      const res = await asSocio(http().post('/members'))
        .send(valid({ correo }))
        .expect(201);

      const member = await memberRow(res.body.id);
      const account = await prisma.account.findUniqueOrThrow({
        where: { username: res.body.username },
      });
      const stored = JSON.stringify({ member, account: { ...account } });
      // The username is derived from the correo (most memorable choice), but
      // no column holds the address itself besides that.
      expect(
        Object.entries({ ...member, ...account })
          .filter(([key]) => key !== 'username')
          .map(([, value]) => String(value)),
      ).not.toContain(correo);
      expect(stored).not.toMatch(/correo/i);
    });

    it('creates another socio, without a commission rate', async () => {
      const res = await asSocio(http().post('/members'))
        .send(valid({ nombre: 'Otro', apellidos: 'Socio', role: 'socio' }))
        .expect(201);

      expect(res.body).toMatchObject({
        name: 'Otro Socio',
        role: 'socio',
        commissionRateBps: null,
        createdByMemberId: socioId,
      });
      expect((await memberRow(res.body.id))?.role).toBe('socio');
      expect(lastEmail().role).toBe('socio');
    });

    it('leaves the commission rate empty (global rate) when a colaborador omits it', async () => {
      const res = await asSocio(http().post('/members')).send(valid()).expect(201);

      expect(res.body.commissionRateBps).toBeNull();
      expect((await memberRow(res.body.id))?.commissionRateBps).toBeNull();
    });

    it('accepts a colaborador rate of exactly 0 and of 10000', async () => {
      const zero = await asSocio(http().post('/members'))
        .send(valid({ commissionRateBps: 0 }))
        .expect(201);
      const max = await asSocio(http().post('/members'))
        .send(valid({ commissionRateBps: 10000 }))
        .expect(201);

      expect(zero.body.commissionRateBps).toBe(0);
      expect(max.body.commissionRateBps).toBe(10000);
    });

    it('derives the username from the correo and gives a taken one a random suffix', async () => {
      const correo = uniqueCorreo();
      const first = await asSocio(http().post('/members'))
        .send(valid({ correo }))
        .expect(201);
      const second = await asSocio(http().post('/members'))
        .send(valid({ correo }))
        .expect(201);

      expect(first.body.username).toBe(correo);
      expect(second.body.username).not.toBe(first.body.username);
      expect(second.body.username).toMatch(/^[a-z0-9-]+-[0-9a-f]{6}$/);
      expect(second.body.id).not.toBe(first.body.id);
    });

    it('gives two people with the same name and different correos different logins', async () => {
      const a = await asSocio(http().post('/members')).send(valid()).expect(201);
      const b = await asSocio(http().post('/members')).send(valid()).expect(201);

      expect(a.body.name).toBe(b.body.name);
      expect(a.body.username).not.toBe(b.body.username);
      expect(a.body.id).not.toBe(b.body.id);
    });

    it('shows the new person in GET /members', async () => {
      const created = await asSocio(http().post('/members'))
        .send(valid({ nombre: 'Visible', apellidos: 'EnLista' }))
        .expect(201);

      const list = await http()
        .get('/members')
        .auth(sharedToken, { type: 'bearer' })
        .expect(200);

      expect(list.body).toContainEqual({
        id: created.body.id,
        name: 'Visible EnLista',
        role: 'colaborador',
        active: true,
      });
    });
  });

  describe('the credentials email', () => {
    it('reports a Resend test-mode fallback to the approver', async () => {
      sendCredentials.mockResolvedValue({ deliveredTo: 'approver-fallback' });

      const res = await asSocio(http().post('/members')).send(valid()).expect(201);

      expect(res.body.credentialsEmail).toBe('approver-fallback');
      expect(await memberRow(res.body.id)).not.toBeNull();
    });

    it('rolls everything back and answers 502 when the email cannot be sent', async () => {
      sendCredentials.mockRejectedValue(new Error('Resend rejected: down'));

      const res = await asSocio(http().post('/members'))
        .send(valid({ nombre: 'Sin', apellidos: 'Correo' }))
        .expect(502);

      expect(res.body.message).toEqual(expect.any(String));
      const attempted = lastEmail();
      expect(JSON.stringify(res.body)).not.toContain(attempted.temporaryPassword);
      expect(
        await prisma.account.findUnique({
          where: { username: attempted.username },
        }),
      ).toBeNull();
      const ghosts = await withTestTenant(contextId, () =>
        prisma.member.findMany({ where: { name: 'Sin Correo' } }),
      );
      expect(ghosts).toHaveLength(0);
    });

    it('does not let a later attempt reuse the rolled back username', async () => {
      const correo = uniqueCorreo();
      sendCredentials.mockRejectedValueOnce(new Error('Resend rejected: down'));
      await asSocio(http().post('/members'))
        .send(valid({ correo }))
        .expect(502);

      const retry = await asSocio(http().post('/members'))
        .send(valid({ correo }))
        .expect(201);

      // The failed attempt persisted nothing, so the correo is free again.
      expect(retry.body.username).toBe(correo);
    });
  });

  describe('who may add people', () => {
    it.each([
      ['a colaborador using the shared login', asSharedColaborador],
      ['a colaborador using its own bound login', asBoundColaborador],
    ])('answers 403 to %s and creates nothing', async (_label, as) => {
      const before = await withTestTenant(contextId, () => prisma.member.count());

      await as(http().post('/members')).send(valid()).expect(403);

      expect(sendCredentials).not.toHaveBeenCalled();
      expect(await withTestTenant(contextId, () => prisma.member.count())).toBe(
        before,
      );
    });

    it('answers 401 without a token', async () => {
      await http().post('/members').send(valid()).expect(401);
      expect(sendCredentials).not.toHaveBeenCalled();
    });

    it('answers 403 when a bound colaborador claims a socio member', async () => {
      await http()
        .post('/members')
        .auth(boundColaboradorToken, { type: 'bearer' })
        .set('x-member-id', socioId)
        .set('x-device-id', actingDeviceId)
        .send(valid())
        .expect(403);
      expect(sendCredentials).not.toHaveBeenCalled();
    });
  });

  describe('validation', () => {
    const rejects = (label: string, body: Record<string, unknown>) =>
      it(`rejects ${label} with 400 and creates nothing`, async () => {
        await asSocio(http().post('/members')).send(body).expect(400);
        expect(sendCredentials).not.toHaveBeenCalled();
      });

    rejects('a commission rate for a socio', valid({ role: 'socio', commissionRateBps: 500 }));
    rejects('a null commission rate for a socio', valid({ role: 'socio', commissionRateBps: null }));
    rejects('a commission rate above 10000', valid({ commissionRateBps: 10001 }));
    rejects('a negative commission rate', valid({ commissionRateBps: -1 }));
    rejects('a fractional commission rate', valid({ commissionRateBps: 12.5 }));
    rejects('a text commission rate', valid({ commissionRateBps: '15' }));
    rejects('a malformed correo', valid({ correo: 'not-an-email' }));
    rejects('a correo with a display name', valid({ correo: 'Ana <ana@example.test>' }));
    rejects('several correos', valid({ correo: 'a@example.test, b@example.test' }));
    rejects('a missing correo', { nombre: 'A', apellidos: 'B', role: 'colaborador' });
    rejects('a missing nombre', { apellidos: 'B', correo: uniqueCorreo(), role: 'colaborador' });
    rejects('a missing apellidos', { nombre: 'A', correo: uniqueCorreo(), role: 'colaborador' });
    rejects('a missing role', { nombre: 'A', apellidos: 'B', correo: uniqueCorreo() });
    rejects('a blank nombre', valid({ nombre: '   ' }));
    rejects('a nombre over 100 characters', valid({ nombre: 'x'.repeat(101) }));
    rejects('an invalid role', valid({ role: 'admin' }));
    rejects('an unknown field', valid({ isAdmin: true }));
    rejects('a client-chosen id', valid({ id: randomUUID() }));
    rejects('a client-chosen contextId', valid({ contextId: otherContextId }));
    rejects('a client-chosen username', valid({ username: 'chosen' }));
    rejects('a client-chosen password', valid({ password: 'chosen-password' }));
  });

  describe('end to end: the new login', () => {
    it('logs in with the emailed temporary password and can only act as its own member', async () => {
      const created = await asSocio(http().post('/members'))
        .send(valid({ nombre: 'Ana', apellidos: 'Nueva' }))
        .expect(201);
      const { username, temporaryPassword } = lastEmail();

      const session = await login(username, temporaryPassword).expect(200);
      const token = session.body.accessToken as string;

      // ContextGuard lets it through as its OWN member ...
      await probe(token, created.body.id).expect(400);
      // ... and refuses it as a socio (the Account.memberId binding).
      await probe(token, socioId).expect(403);
      await probe(token, colaboradorId).expect(403);

      // A colaborador cannot add people.
      await http()
        .post('/members')
        .auth(token, { type: 'bearer' })
        .set('x-member-id', created.body.id)
        .set('x-device-id', actingDeviceId)
        .send(valid())
        .expect(403);
    });

    it('rejects a wrong password for the new login', async () => {
      await asSocio(http().post('/members')).send(valid()).expect(201);
      const { username } = lastEmail();

      await login(username, 'definitely-not-the-password').expect(401);
    });

    it('lets a socio added through the API add people too, and records who added whom', async () => {
      const newSocio = await asSocio(http().post('/members'))
        .send(valid({ nombre: 'Segundo', apellidos: 'Socio', role: 'socio' }))
        .expect(201);
      const { username, temporaryPassword } = lastEmail();
      const token = (await login(username, temporaryPassword).expect(200)).body
        .accessToken as string;
      sendCredentials.mockClear();

      const child = await http()
        .post('/members')
        .auth(token, { type: 'bearer' })
        .set('x-member-id', newSocio.body.id)
        .set('x-device-id', actingDeviceId)
        .send(valid({ nombre: 'Hija', apellidos: 'DelSegundo' }))
        .expect(201);

      expect(child.body.createdByMemberId).toBe(newSocio.body.id);
      expect((await memberRow(child.body.id))?.createdByMemberId).toBe(
        newSocio.body.id,
      );
      // A bound socio cannot pretend to be the founding socio.
      await http()
        .post('/members')
        .auth(token, { type: 'bearer' })
        .set('x-member-id', socioId)
        .set('x-device-id', actingDeviceId)
        .send(valid())
        .expect(403);
    });
  });

  describe('tenant isolation', () => {
    it('creates the rows in the actor context, never in another one', async () => {
      const mine = await asSocio(http().post('/members')).send(valid()).expect(201);
      const theirs = await asOtherSocio(http().post('/members'))
        .send(valid())
        .expect(201);

      expect((await memberRow(mine.body.id))?.contextId).toBe(contextId);
      expect(await memberRow(mine.body.id, otherContextId)).toBeNull();
      expect((await memberRow(theirs.body.id, otherContextId))?.contextId).toBe(
        otherContextId,
      );
      expect(await memberRow(theirs.body.id, contextId)).toBeNull();

      const accounts = await prisma.account.findMany({
        where: { username: { in: [mine.body.username, theirs.body.username] } },
      });
      expect(
        Object.fromEntries(accounts.map((a) => [a.username, a.contextId])),
      ).toEqual({
        [mine.body.username]: contextId,
        [theirs.body.username]: otherContextId,
      });
      expect(theirs.body.createdByMemberId).toBe(otherSocioId);
    });

    it('does not list the other business in GET /members', async () => {
      const theirs = await asOtherSocio(http().post('/members'))
        .send(valid({ nombre: 'Solo', apellidos: 'OtroNegocio' }))
        .expect(201);

      const list = await http()
        .get('/members')
        .auth(sharedToken, { type: 'bearer' })
        .expect(200);

      expect(
        (list.body as { id: string }[]).map((m) => m.id),
      ).not.toContain(theirs.body.id);
    });
  });
});

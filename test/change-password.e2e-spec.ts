import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ConsoleLogger, Logger, type INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { hashPassword } from '../src/common/password.js';
import { withTestTenant } from './tenant-scope.js';

/**
 * BE-12 (task T6): `POST /auth/change-password`. Any logged-in person changes
 * the password of their own Account. Only `AuthGuard` protects it (a valid
 * bearer token for an active account): no member/device selection is needed,
 * so a person holding a temporary password can change it right after their
 * first login, and a colaborador can use it as much as a socio.
 *
 * A wrong current password answers 403 and NOT 401: the frontend treats 401 as
 * an expired session and logs the person out.
 */
describe('auth: change own password (BE-12)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;

  const contextId = `be12-chpw-${randomUUID()}`;
  const OLD = 'Old-Secret_0123456789';
  const NEW = 'New-Secret_9876543210';

  let socioId: string;
  const createdAccountIds: string[] = [];

  const http = () => request(app.getHttpServer());

  const login = (username: string, password: string) =>
    http().post('/auth/login').send({ username, password });

  const change = (token: string, body: unknown) =>
    http().post('/auth/change-password').auth(token, { type: 'bearer' }).send(body as object);

  /**
   * Account.memberId is UNIQUE (one login per Member), so every bound account
   * needs its own Member.
   */
  const makeMember = (role: 'socio' | 'colaborador') =>
    withTestTenant(contextId, () =>
      prisma.member.create({
        data: { name: `ChPw ${role} ${randomUUID()}`, role, contextId },
      }),
    ).then((member) => member.id);

  /** Creates an account with a REAL argon2id hash so that login works. */
  async function makeAccount(
    options: { memberId?: string; active?: boolean; passwordHash?: string } = {},
  ) {
    const username = `chpw-${randomUUID()}`;
    const account = await prisma.account.create({
      data: {
        username,
        passwordHash: options.passwordHash ?? (await hashPassword(OLD)),
        contextId,
        active: options.active ?? true,
        ...(options.memberId ? { memberId: options.memberId } : {}),
      },
    });
    createdAccountIds.push(account.id);
    const token = await jwt.signAsync({ sub: account.id });
    return { id: account.id, username, token };
  }

  const storedHash = async (id: string) =>
    (await prisma.account.findUniqueOrThrow({ where: { id } })).passwordHash;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    jwt = app.get(JwtService);

    // A socio that is never bound to a login: the endpoint must ignore it even
    // when a bound colaborador names it in x-member-id.
    socioId = await makeMember('socio');
  });

  afterAll(async () => {
    if (prisma) {
      // Accounts first: Account.memberId is ON DELETE RESTRICT.
      await prisma.account.deleteMany({ where: { contextId } });
      await withTestTenant(contextId, () =>
        prisma.member.deleteMany({ where: { contextId } }),
      );
    }
    await app?.close();
  });

  describe('a successful change', () => {
    it('answers 204 with an empty body, then only the NEW password logs in', async () => {
      const account = await makeAccount();

      const res = await change(account.token, {
        currentPassword: OLD,
        newPassword: NEW,
      }).expect(204);

      expect(res.text).toBe('');
      expect(res.body).toEqual({});
      await login(account.username, OLD).expect(401);
      const relogin = await login(account.username, NEW).expect(200);
      expect(relogin.body.accessToken).toEqual(expect.any(String));
    });

    it('replaces the stored hash with a new argon2id hash (never the plain password)', async () => {
      const account = await makeAccount();
      const before = await storedHash(account.id);

      await change(account.token, {
        currentPassword: OLD,
        newPassword: NEW,
      }).expect(204);

      const after = await storedHash(account.id);
      expect(after).not.toBe(before);
      expect(after).toMatch(/^\$argon2id\$/);
      expect(after).not.toContain(NEW);
    });

    it('works for the shared (unbound) login, a bound colaborador and a bound socio', async () => {
      const shared = await makeAccount();
      const colaborador = await makeAccount({
        memberId: await makeMember('colaborador'),
      });
      const socio = await makeAccount({ memberId: await makeMember('socio') });

      for (const account of [shared, colaborador, socio]) {
        await change(account.token, {
          currentPassword: OLD,
          newPassword: NEW,
        }).expect(204);
        await login(account.username, NEW).expect(200);
        await login(account.username, OLD).expect(401);
      }
    });

    it('needs no member or device selection (only the bearer token)', async () => {
      const account = await makeAccount({
        memberId: await makeMember('colaborador'),
      });

      await http()
        .post('/auth/change-password')
        .auth(account.token, { type: 'bearer' })
        // A bound colaborador naming a socio must not matter here: the endpoint
        // never reads the selection headers.
        .set('x-member-id', socioId)
        .set('x-device-id', randomUUID())
        .send({ currentPassword: OLD, newPassword: NEW })
        .expect(204);

      await login(account.username, NEW).expect(200);
    });

    it('changes only the password of the account in the token', async () => {
      const mine = await makeAccount();
      const other = await makeAccount();

      await change(mine.token, {
        currentPassword: OLD,
        newPassword: NEW,
      }).expect(204);

      await login(other.username, OLD).expect(200);
    });

    it('leaves the existing token valid until it expires (documented limitation)', async () => {
      // JWTs are stateless (12 h). A `passwordChangedAt` claim check would be
      // the fix; it is a known follow-up, not part of this task. Pinned so that
      // the behavior is a decision, not an accident.
      const account = await makeAccount();

      await change(account.token, {
        currentPassword: OLD,
        newPassword: NEW,
      }).expect(204);

      await change(account.token, {
        currentPassword: NEW,
        newPassword: 'Third-Secret_0011223344',
      }).expect(204);
      await login(account.username, 'Third-Secret_0011223344').expect(200);
    });
  });

  describe('a wrong current password', () => {
    it('answers 403 (not 401) with a clear message and changes nothing', async () => {
      const account = await makeAccount();
      const before = await storedHash(account.id);

      const res = await change(account.token, {
        currentPassword: 'not-the-password',
        newPassword: NEW,
      }).expect(403);

      expect(res.body).toMatchObject({
        message: 'Current password is incorrect',
        statusCode: 403,
      });
      expect(JSON.stringify(res.body)).not.toContain('not-the-password');
      expect(JSON.stringify(res.body)).not.toContain(NEW);
      expect(await storedHash(account.id)).toBe(before);
      await login(account.username, OLD).expect(200);
      await login(account.username, NEW).expect(401);
    });

    it('treats a malformed stored hash like a wrong current password (403, not 500)', async () => {
      const account = await makeAccount({ passwordHash: 'not-an-argon2-hash' });

      await change(account.token, {
        currentPassword: OLD,
        newPassword: NEW,
      }).expect(403);

      expect(await storedHash(account.id)).toBe('not-an-argon2-hash');
    });
  });

  describe('authentication', () => {
    it('answers 401 without a token and with an invalid one', async () => {
      await http()
        .post('/auth/change-password')
        .send({ currentPassword: OLD, newPassword: NEW })
        .expect(401);
      await http()
        .post('/auth/change-password')
        .auth('not.a.jwt', { type: 'bearer' })
        .send({ currentPassword: OLD, newPassword: NEW })
        .expect(401);
    });

    it('answers 401 for a token of a deactivated account, changing nothing', async () => {
      const account = await makeAccount({ active: false });
      const before = await storedHash(account.id);

      await change(account.token, {
        currentPassword: OLD,
        newPassword: NEW,
      }).expect(401);

      expect(await storedHash(account.id)).toBe(before);
    });
  });

  describe('validation (400, and nothing changes)', () => {
    it.each([
      ['no fields', {}],
      ['no currentPassword', { newPassword: NEW }],
      ['no newPassword', { currentPassword: OLD }],
      ['a numeric newPassword', { currentPassword: OLD, newPassword: 1234567890 }],
      ['a numeric currentPassword', { currentPassword: 12345, newPassword: NEW }],
      ['a null newPassword', { currentPassword: OLD, newPassword: null }],
      ['an empty currentPassword', { currentPassword: '', newPassword: NEW }],
      ['a newPassword shorter than 10', { currentPassword: OLD, newPassword: 'x'.repeat(9) }],
      ['a newPassword longer than 128', { currentPassword: OLD, newPassword: 'x'.repeat(129) }],
      ['a currentPassword longer than 128', { currentPassword: 'x'.repeat(129), newPassword: NEW }],
      ['a newPassword equal to the currentPassword', { currentPassword: OLD, newPassword: OLD }],
      ['an unknown field', { currentPassword: OLD, newPassword: NEW, username: 'x' }],
      ['an attempt to name the account', { currentPassword: OLD, newPassword: NEW, accountId: randomUUID() }],
    ])('rejects %s', async (_label, body) => {
      const account = await makeAccount();
      const before = await storedHash(account.id);

      await change(account.token, body).expect(400);

      expect(await storedHash(account.id)).toBe(before);
      await login(account.username, OLD).expect(200);
    });

    it('accepts the boundaries: 10 and 128 characters', async () => {
      const short = await makeAccount();
      const long = await makeAccount();

      await change(short.token, {
        currentPassword: OLD,
        newPassword: 'x'.repeat(10),
      }).expect(204);
      await change(long.token, {
        currentPassword: OLD,
        newPassword: 'y'.repeat(128),
      }).expect(204);

      await login(short.username, 'x'.repeat(10)).expect(200);
      await login(long.username, 'y'.repeat(128)).expect(200);
    });

    it('does not trim: surrounding spaces are part of the password', async () => {
      const account = await makeAccount();
      const spaced = '  spaced secret 123  ';

      await change(account.token, {
        currentPassword: OLD,
        newPassword: spaced,
      }).expect(204);

      await login(account.username, spaced).expect(200);
      await login(account.username, spaced.trim()).expect(401);
    });
  });

  describe('concurrency', () => {
    it('two simultaneous changes: exactly one wins (204), the other gets 409, and the account stays consistent', async () => {
      const account = await makeAccount();
      const A = 'Concurrent-A_0123456789';
      const B = 'Concurrent-B_9876543210';

      const [first, second] = await Promise.all([
        change(account.token, { currentPassword: OLD, newPassword: A }),
        change(account.token, { currentPassword: OLD, newPassword: B }),
      ]);

      expect([first.status, second.status].sort((a, b) => a - b)).toEqual([
        204, 409,
      ]);
      const loser = first.status === 409 ? first : second;
      expect(loser.body.message).toMatch(/changed by another request/i);
      const [winnerPassword, loserPassword] =
        first.status === 204 ? [A, B] : [B, A];
      await login(account.username, winnerPassword).expect(200);
      await login(account.username, loserPassword).expect(401);
      await login(account.username, OLD).expect(401);
    });
  });

  describe('secrets never leak', () => {
    it('logs neither the current password, the new one nor a hash', async () => {
      const levels = ['log', 'warn', 'error', 'debug', 'verbose'] as const;
      const spies = [
        ...levels.map((level) =>
          vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
        ),
        ...levels.map((level) =>
          vi.spyOn(ConsoleLogger.prototype, level).mockImplementation(() => undefined),
        ),
      ];
      const account = await makeAccount();
      const hashBefore = await storedHash(account.id);
      const WRONG = 'Definitely-Wrong_555555';

      await change(account.token, { currentPassword: WRONG, newPassword: NEW }).expect(403);
      await change(account.token, { currentPassword: OLD, newPassword: NEW }).expect(204);
      const hashAfter = await storedHash(account.id);

      const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
      spies.forEach((spy) => spy.mockRestore());
      for (const secret of [OLD, NEW, WRONG, hashBefore, hashAfter])
        expect(logged).not.toContain(secret);
    });
  });
});

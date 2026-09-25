import { Test } from '@nestjs/testing';
import { NestFactory } from '@nestjs/core';
import { Logger, type INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { EmailService } from '../src/email/email.service.js';
import { withTestTenant } from './tenant-scope.js';

/**
 * BE-11 Part 2: business registration + email approval flow. Resend is
 * never actually called — `EmailService` is swapped for a spy via Nest's
 * DI override, matching this project's established e2e mocking pattern
 * (see e.g. test/products.e2e-spec.ts's `vi.spyOn` usage), so these
 * tests need neither `RESEND_API_KEY` nor network access, and can
 * recover the token (only ever emailed, never returned by the API) from
 * the approve/reject URLs the mock was called with.
 */
describe('business registration (BE-11)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sendApprovalEmail: ReturnType<typeof vi.fn>;
  let sendCredentialsEmail: ReturnType<typeof vi.fn>;
  let uploadRoot: string;
  // Nest warnings emitted while the production bootstrap runs.
  let bootWarnings: string[];

  // BE-11 tenant-scope fixtures (one context per tenant, unique per run).
  const contextIdA = `prefix-a-${randomUUID()}`;
  const contextIdB = `prefix-b-${randomUUID()}`;
  const productNameA = `Producto A ${randomUUID()}`;
  const productNameB = `Producto B ${randomUUID()}`;
  let tokenA: string;
  let memberIdA: string;
  let deviceIdA: string;

  // Business names are unique per run: the test database persists between
  // runs and these specs look requests up by name, so a fixed name would
  // also match rows left behind by an earlier (or crashed) run.
  const run = randomUUID();
  const name = (label: string) => `${label} ${run}`;
  // Accounts created directly by these specs (not through an approval).
  const extraUsernames: string[] = [];

  // What the real EmailService reports when nothing goes wrong: to the socio
  // when there is an address, otherwise to the approver (relay note).
  const deliveredNormally = (input: { socioEmail?: string }) =>
    Promise.resolve({
      deliveredTo: input.socioEmail ? 'socio' : 'approver-non-email-contact',
    });

  const emailPath = (url: string) => {
    const parsed = new URL(url);
    expect(parsed.origin).toBe('https://api.example.test');
    expect(parsed.pathname).toMatch(
      /^\/api\/v1\/business-registration\/(approve|reject)$/,
    );
    return parsed.pathname + parsed.search;
  };

  beforeAll(async () => {
    uploadRoot = await mkdtemp(join(tmpdir(), 'bazar-prefix-'));
    vi.stubEnv('PRODUCT_UPLOAD_DIR', uploadRoot);
    await writeFile(join(uploadRoot, 'prefix-test.txt'), 'static route fixture');
    sendApprovalEmail = vi.fn().mockResolvedValue(undefined);
    sendCredentialsEmail = vi.fn().mockImplementation(deliveredNormally);
    const module = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(EmailService)
      .useValue({
        sendBusinessRegistrationApprovalEmail: sendApprovalEmail,
        sendBusinessCredentialsEmail: sendCredentialsEmail,
      })
      .compile();
    app = module.createNestApplication();
    vi.stubEnv('PORT', '0');
    vi.stubEnv('APP_BASE_URL', 'https://api.example.test/');
    vi.stubEnv('ENABLE_API_DOCS', 'true');
    vi.stubEnv('DOCS_USER', 'prefix-test');
    vi.stubEnv('DOCS_PASSWORD', randomUUID());
    // Execute production bootstrap with the test module and mocked email.
    const create = vi.spyOn(NestFactory, 'create').mockResolvedValue(app);
    // Framework warnings (e.g. LegacyRouteConverter) go through
    // Logger#warn, so record its calls while main.ts boots the app.
    const warn = vi.spyOn(Logger.prototype, 'warn');
    try {
      await import('../src/main.js');
      // The import only resolves after main.ts finished `await bootstrap()`
      // (prefix, static/docs setup and app.listen). If that top-level await
      // were removed, the spies below would be restored before the
      // middleware is registered and the warning test would pass vacuously,
      // so fail loudly instead of trusting microtask timing.
      expect(app.getHttpServer().listening).toBe(true);
    } finally {
      bootWarnings = warn.mock.calls.map((args, i) => {
        const context = (warn.mock.contexts[i] as { context?: string })
          .context;
        return `[${context ?? ''}] ${String(args[0])}`;
      });
      warn.mockRestore();
      create.mockRestore();
    }
    prisma = app.get(PrismaService);

    // Two tenants: A owns the caller (account, socio, device) and one
    // product; B owns a different product that must never be visible to A.
    const account = await prisma.account.create({
      data: {
        username: randomUUID(),
        passwordHash: 'not-a-login-fixture',
        contextId: contextIdA,
      },
    });
    tokenA = await app.get(JwtService).signAsync({ sub: account.id });
    await withTestTenant(contextIdA, async () => {
      memberIdA = (
        await prisma.member.create({
          data: { name: 'Socio A', role: 'socio', contextId: contextIdA },
        })
      ).id;
      deviceIdA = (
        await prisma.device.create({
          data: {
            name: 'Tablet A',
            identifier: randomUUID(),
            contextId: contextIdA,
            authorized: true,
          },
        })
      ).id;
      await prisma.product.create({
        data: {
          name: productNameA,
          tipo: 'cantidad',
          unitPriceMinor: 1000,
          initialStock: 5,
          stock: 5,
          contextId: contextIdA,
        },
      });
    });
    await withTestTenant(contextIdB, () =>
      prisma.product.create({
        data: {
          name: productNameB,
          tipo: 'cantidad',
          unitPriceMinor: 2000,
          initialStock: 5,
          stock: 5,
          contextId: contextIdB,
        },
      }),
    );
  });

  afterAll(async () => {
    for (const contextId of [contextIdA, contextIdB]) {
      await withTestTenant(contextId, async () => {
        await prisma.product.deleteMany({ where: { contextId } });
        await prisma.device.deleteMany({ where: { contextId } });
        await prisma.member.deleteMany({ where: { contextId } });
      });
    }
    await prisma.account.deleteMany({
      where: { contextId: { in: [contextIdA, contextIdB] } },
    });
    const requests = await prisma.businessRegistrationRequest.findMany({
      where: { nombreNegocio: { endsWith: run } },
    });
    const createdContextIds: string[] = [];
    for (const { createdContextId } of requests) {
      if (!createdContextId) continue;
      createdContextIds.push(createdContextId);
      // Approval creates a Device and a Member per new context (both RLS
      // tables, so the delete needs the tenant scope) plus an Account.
      await withTestTenant(createdContextId, async () => {
        await prisma.device.deleteMany({ where: { contextId: createdContextId } });
        await prisma.member.deleteMany({ where: { contextId: createdContextId } });
      });
    }
    // Account has no RLS: it is removed by context, plus the fixture
    // accounts these specs create by username.
    await prisma.account.deleteMany({
      where: {
        OR: [
          { contextId: { in: createdContextIds } },
          { username: { in: extraUsernames } },
        ],
      },
    });
    await prisma.businessRegistrationRequest.deleteMany({
      where: { nombreNegocio: { endsWith: run } },
    });
    await app.close();
    await rm(uploadRoot, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    sendApprovalEmail.mockClear();
    // reset (not just clear): a test may queue a rejection for the
    // credentials email, which must never leak into the next test.
    sendCredentialsEmail.mockReset().mockImplementation(deliveredNormally);
  });

  it('prefixes production routes and OpenAPI without moving explicit docs mounts', async () => {
    const server = app.getHttpServer();
    await request(server).get('/api/v1').expect(200).expect('Hello World!');
    await request(server).get('/').expect(404);
    await request(server).post('/auth/login').send({}).expect(404);
    await request(server).get('/products').expect(404);
    await request(server).post('/business-registration').send({}).expect(404);
    await request(server).get('/business-registration/approve').expect(404);
    await request(server).get('/business-registration/reject').expect(404);
    await request(server).get('/api/v1/products').expect(401);
    await request(server).post('/api/v1/auth/login').send({}).expect(400);
    await request(server).get('/docs-json').expect(401);
    const schema = await request(server)
      .get('/docs-json')
      .auth(process.env.DOCS_USER!, process.env.DOCS_PASSWORD!)
      .expect(200);
    expect(schema.body.paths).toHaveProperty('/api/v1/auth/login');
    expect(schema.body.paths).toHaveProperty(
      '/api/v1/business-registration/approve',
    );
    expect(
      Object.keys(schema.body.paths).every((path) =>
        path.startsWith('/api/v1'),
      ),
    ).toBe(true);
    await request(server).get('/api/v1/docs-json').expect(404);
    await request(server).get('/uploads/products/prefix-test.txt').expect(200).expect('static route fixture');
    await request(server).get('/api/v1/uploads/products/prefix-test.txt').expect(404);
  });

  it('boots through main.ts without route-conversion warnings', () => {
    expect(
      bootWarnings.filter((warning) => /LegacyRouteConverter/.test(warning)),
    ).toEqual([]);
  });

  it('keeps the tenant scope behind the prefix: authenticated request sees only its own context', async () => {
    const server = app.getHttpServer();
    const asA = (req: request.Test) =>
      req
        .auth(tokenA, { type: 'bearer' })
        .set('x-member-id', memberIdA)
        .set('x-device-id', deviceIdA);

    const res = await asA(request(server).get('/api/v1/products')).expect(200);
    const names = (res.body.items as { name: string }[]).map((p) => p.name);
    expect(names).toContain(productNameA);
    expect(names).not.toContain(productNameB);
    expect(names).toHaveLength(1);

    await asA(request(server).get('/products')).expect(404);
  });

  it('creates the request as pendiente and "sends" the approval email without calling Resend', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/business-registration')
      .send({
        nombreNegocio: name('Bonsáis del Alberto'),
        nombreSocio: 'Alberto',
        contactoSocio: 'alberto@example.com',
      })
      .expect(201);

    expect(res.body.status).toBe('pendiente');
    expect(sendApprovalEmail).toHaveBeenCalledTimes(1);
    const call = sendApprovalEmail.mock.calls[0][0];
    expect(call.nombreNegocio).toBe(name('Bonsáis del Alberto'));
    expect(typeof call.approveUrl).toBe('string');
    expect(typeof call.rejectUrl).toBe('string');
  });

  it('approves with a valid token: creates a contextId and a founding socio Member', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/business-registration')
      .send({
        nombreNegocio: name('Bolsas de Adid'),
        nombreSocio: 'Adid',
        contactoSocio: 'adid@example.com',
      })
      .expect(201);
    const { approveUrl } = sendApprovalEmail.mock.calls[0][0];

    const res = await request(app.getHttpServer())
      .get(emailPath(approveUrl))
      .expect(200);
    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.text).toMatch(/aprobado/i);

    const stored = await prisma.businessRegistrationRequest.findFirst({
      where: { nombreNegocio: name('Bolsas de Adid') },
    });
    expect(stored?.status).toBe('aprobado');
    expect(stored?.createdContextId).toBeTruthy();

    const founder = await withTestTenant(stored!.createdContextId!, () =>
      prisma.member.findFirst({
        where: { contextId: stored!.createdContextId!, role: 'socio' },
      }),
    );
    expect(founder?.name).toBe('Adid');
    expect(founder?.active).toBe(true);
  });

  it('rejects with a valid token: marks rechazado and creates nothing operative', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/business-registration')
      .send({
        nombreNegocio: name('Lucha Libre Negocio'),
        nombreSocio: 'Rudo Anonimo',
        contactoSocio: '555-0000',
      })
      .expect(201);
    const { rejectUrl } = sendApprovalEmail.mock.calls[0][0];

    const res = await request(app.getHttpServer())
      .get(emailPath(rejectUrl))
      .expect(200);
    expect(res.text).toMatch(/rechazad/i);

    const stored = await prisma.businessRegistrationRequest.findFirst({
      where: { nombreNegocio: name('Lucha Libre Negocio') },
    });
    expect(stored?.status).toBe('rechazado');
    expect(stored?.createdContextId).toBeNull();
  });

  it('does not duplicate anything when the same approve token is used twice', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/business-registration')
      .send({
        nombreNegocio: name('Artículos Varios'),
        nombreSocio: 'Socia Fundadora',
        contactoSocio: 'socia@example.com',
      })
      .expect(201);
    const { approveUrl } = sendApprovalEmail.mock.calls[0][0];

    await request(app.getHttpServer()).get(emailPath(approveUrl)).expect(200);
    const second = await request(app.getHttpServer())
      .get(emailPath(approveUrl))
      .expect(200);
    expect(second.text).toMatch(/ya fue procesado/i);

    const stored = await prisma.businessRegistrationRequest.findFirst({
      where: { nombreNegocio: name('Artículos Varios') },
    });
    const founders = await withTestTenant(stored!.createdContextId!, () =>
      prisma.member.findMany({
        where: { contextId: stored!.createdContextId!, role: 'socio' },
      }),
    );
    expect(founders).toHaveLength(1);
  });

  it('shows an expired-link page for a token whose expiration has already passed', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/business-registration')
      .send({
        nombreNegocio: name('Negocio Expirado'),
        nombreSocio: 'Fundador Tardío',
        contactoSocio: 'tarde@example.com',
      })
      .expect(201);
    const { approveUrl } = sendApprovalEmail.mock.calls[0][0];

    await prisma.businessRegistrationRequest.updateMany({
      where: { nombreNegocio: name('Negocio Expirado') },
      data: { tokenExpiresAt: new Date(Date.now() - 1000) },
    });

    const res = await request(app.getHttpServer())
      .get(emailPath(approveUrl))
      .expect(200);
    expect(res.text).toMatch(/expiró/i);

    const stored = await prisma.businessRegistrationRequest.findFirst({
      where: { nombreNegocio: name('Negocio Expirado') },
    });
    expect(stored?.status).toBe('pendiente');
    expect(stored?.createdContextId).toBeNull();
  });

  describe('approval creates the initial Account and Device', () => {
    interface CredentialsCall {
      nombreNegocio: string;
      nombreSocio: string;
      contactoSocio: string;
      socioEmail?: string;
      username: string;
      temporaryPassword: string;
      deviceName: string;
      deviceIdentifier: string;
    }
    const server = () => app.getHttpServer();
    const register = async (
      nombreNegocio: string,
      nombreSocio: string,
      contactoSocio: string,
    ) => {
      await request(server())
        .post('/api/v1/business-registration')
        .send({ nombreNegocio, nombreSocio, contactoSocio })
        .expect(201);
      const { approveUrl } = sendApprovalEmail.mock.calls.at(-1)![0];
      return emailPath(approveUrl);
    };
    const lastCredentials = () =>
      sendCredentialsEmail.mock.calls.at(-1)![0] as CredentialsCall;
    const login = (username: string, password: string) =>
      request(server()).post('/api/v1/auth/login').send({ username, password });
    const stored = (nombreNegocio: string) =>
      prisma.businessRegistrationRequest.findFirst({ where: { nombreNegocio } });

    it('lets the socio log in and identify the device with the emailed credentials', async () => {
      const email = `adid.${run}@example.com`;
      const path = await register(
        name('Credenciales Felices'),
        'Adid',
        `  Adid.${run}@Example.COM  `,
      );

      const page = await request(server()).get(path).expect(200);

      expect(sendCredentialsEmail).toHaveBeenCalledTimes(1);
      const creds = lastCredentials();
      expect(creds.socioEmail).toBe(email);
      expect(creds.username).toBe(email);
      expect(creds.temporaryPassword.length).toBeGreaterThanOrEqual(22);
      expect(creds.deviceName).toBe('Dispositivo principal');
      expect(page.text).toMatch(/correo/i);
      expect(page.text).not.toContain(creds.temporaryPassword);

      const registration = await stored(name('Credenciales Felices'));
      const contextId = registration!.createdContextId!;

      const account = await prisma.account.findUnique({
        where: { username: creds.username },
      });
      expect(account?.contextId).toBe(contextId);
      expect(account?.active).toBe(true);
      expect(account?.passwordHash).toMatch(/^\$argon2id\$/);
      expect(account?.passwordHash).not.toContain(creds.temporaryPassword);

      await login(creds.username, `${creds.temporaryPassword}x`).expect(401);
      const session = await login(creds.username, creds.temporaryPassword).expect(200);
      expect(session.body.accessToken).toEqual(expect.any(String));

      const device = await withTestTenant(contextId, () =>
        prisma.device.findFirst({
          where: { contextId, identifier: creds.deviceIdentifier },
        }),
      );
      expect(device).toMatchObject({
        name: 'Dispositivo principal',
        authorized: true,
        contextId,
      });
      const founders = await withTestTenant(contextId, () =>
        prisma.member.findMany({ where: { contextId, role: 'socio' } }),
      );
      expect(founders).toHaveLength(1);

      const identified = await request(server())
        .post('/api/v1/devices/identify')
        .auth(session.body.accessToken, { type: 'bearer' })
        .send({
          identifier: creds.deviceIdentifier,
          name: creds.deviceName,
        })
        .expect(200);
      expect(identified.body).toEqual({ deviceId: device!.id });
    });

    it('answers 502, keeps the request pendiente and creates nothing when the credentials email fails, then succeeds on retry with the same link', async () => {
      const email = `retry.${run}@example.com`;
      const path = await register(name('Correo Caido'), 'Reintento', email);
      sendCredentialsEmail.mockRejectedValueOnce(
        new Error('Resend rejected the credentials email: boom'),
      );

      const failed = await request(server()).get(path).expect(502);

      expect(failed.headers['content-type']).toMatch(/html/);
      expect(failed.text).toMatch(/no se pudo enviar/i);
      expect(failed.text).toMatch(/mismo enlace/i);
      const firstAttempt = lastCredentials();
      expect(failed.text).not.toContain(firstAttempt.temporaryPassword);
      const pending = await stored(name('Correo Caido'));
      expect(pending?.status).toBe('pendiente');
      expect(pending?.createdContextId).toBeNull();
      expect(pending?.resolvedAt).toBeNull();
      // Account has no RLS, so its absence proves the whole transaction
      // (Account + Device + Member + status) rolled back together.
      await expect(
        prisma.account.findUnique({ where: { username: email } }),
      ).resolves.toBeNull();
      await login(email, firstAttempt.temporaryPassword).expect(401);

      await request(server()).get(path).expect(200);

      expect(sendCredentialsEmail).toHaveBeenCalledTimes(2);
      const retry = lastCredentials();
      expect(retry.temporaryPassword).not.toBe(firstAttempt.temporaryPassword);
      expect((await stored(name('Correo Caido')))?.status).toBe('aprobado');
      await login(email, firstAttempt.temporaryPassword).expect(401);
      await login(email, retry.temporaryPassword).expect(200);
    });

    // The status carries the body in its failure message, so a wrong answer
    // (e.g. Nest's JSON 500) is visible in the assertion output.
    const expectRetryPage = (res: request.Response, reason: RegExp) => {
      expect(res.status, `status ${res.status}, body ${res.text}`).toBe(502);
      expect(res.headers['content-type']).toMatch(/html/);
      expect(res.text).toMatch(reason);
      expect(res.text).toMatch(/no se completó/i);
      expect(res.text).toMatch(/sigue pendiente/i);
      expect(res.text).toMatch(/mismo enlace/i);
    };
    const expectStillPending = async (nombreNegocio: string) => {
      const pending = await stored(nombreNegocio);
      expect(pending?.status).toBe('pendiente');
      expect(pending?.createdContextId).toBeNull();
      expect(pending?.resolvedAt).toBeNull();
    };

    it('answers 502, keeps the request pendiente and creates nothing when the transaction expires under a slow credentials email, then succeeds on retry', async () => {
      const email = `lento.${run}@example.com`;
      const path = await register(name('Correo Lento'), 'Socio Lento', email);
      // Seam: the production timeout is 15 s; waiting that long would make
      // the suite slow, so for this one request the spy forwards every
      // $transaction call to the real implementation with a 1 s timeout
      // (production options are untouched otherwise). The mocked email then
      // outlives it, exactly like a Resend call that never answers.
      const realTransaction = prisma.$transaction.bind(prisma);
      const shortTimeout = vi.spyOn(prisma, '$transaction').mockImplementation(((
        callback: never,
        options?: object,
      ) =>
        realTransaction(callback, { ...options, timeout: 1_000 })) as never);
      sendCredentialsEmail.mockImplementationOnce(
        () =>
          new Promise((resolve) =>
            setTimeout(() => resolve({ deliveredTo: 'socio' }), 1_500),
          ),
      );

      let failed: request.Response;
      try {
        failed = await request(server()).get(path);
      } finally {
        shortTimeout.mockRestore();
      }

      expectRetryPage(failed, /se agotó el tiempo/i);
      await expectStillPending(name('Correo Lento'));
      await expect(
        prisma.account.findUnique({ where: { username: email } }),
      ).resolves.toBeNull();

      await request(server()).get(path).expect(200);

      expect((await stored(name('Correo Lento')))?.status).toBe('aprobado');
      const creds = lastCredentials();
      expect(creds.username).toBe(email);
      await login(email, creds.temporaryPassword).expect(200);
    });

    it('answers 502 and keeps the request pendiente when a concurrent approval wins the username, and the retry derives a fresh one', async () => {
      const email = `choque.${run}@example.com`;
      const pathA = await register(name('Choque Uno'), 'Socio Uno', email);
      const pathB = await register(name('Choque Dos'), 'Socio Dos', email);
      // A real race, made deterministic: approval A inserts its Account and
      // then holds its (still uncommitted) transaction open inside the
      // credentials email. Approval B pre-checks the username under READ
      // COMMITTED, sees nothing committed, picks the same address and blocks
      // on the unique index of A's uncommitted row. Once B is observed
      // waiting on a lock, A is released and commits, so B's insert fails
      // with the unique violation the pre-check could not see.
      //
      // "B is waiting" must be about B's own connection and about A, not
      // about any Account insert some other session happens to be blocked on.
      // Seam (test only, production untouched): while this test runs, every
      // $transaction opened by the app tags its Postgres session with a
      // per-run application_name as its first statement (set_config with
      // is_local = true, so it dies with the transaction). A's transaction is
      // tagged before B is even requested, B's right after, so the tags are
      // deterministic and unique to this run. The probe then requires ONE
      // session that (1) carries B's tag, (2) waits on a lock in an Account
      // insert and (3) is blocked by (pg_blocking_pids) the session carrying
      // A's tag. Anything else keeps polling and, after the bound, fails the
      // test with a dump of both sessions instead of releasing A blindly.
      const tagA = `race-A-${run}`;
      const tagB = `race-B-${run}`;
      let sessionTag = tagA;
      const realTransaction = prisma.$transaction.bind(prisma);
      const tagSessions = vi.spyOn(prisma, '$transaction').mockImplementation(((
        callback: (tx: {
          $executeRaw: (
            q: TemplateStringsArray,
            ...v: unknown[]
          ) => Promise<unknown>;
        }) => Promise<unknown>,
        options?: object,
      ) => {
        const tag = sessionTag;
        return realTransaction(async (tx: never) => {
          await (tx as Parameters<typeof callback>[0])
            .$executeRaw`SELECT set_config('application_name', ${tag}, true)`;
          return callback(tx);
        }, options);
      }) as never);
      let reachedEmailA!: () => void;
      const emailAReached = new Promise<void>((resolve) => {
        reachedEmailA = resolve;
      });
      let releaseA!: () => void;
      const heldByA = new Promise<void>((resolve) => {
        releaseA = resolve;
      });
      sendCredentialsEmail.mockImplementationOnce(async () => {
        reachedEmailA();
        await heldByA;
        return { deliveredTo: 'socio' };
      });
      const isBBlockedByA = async () => {
        const rows = await prisma.$queryRaw<{ n: bigint }[]>`
          SELECT count(*) AS n FROM pg_stat_activity b
          WHERE b.datname = current_database()
            AND b.application_name = ${tagB}
            AND b.wait_event_type = 'Lock'
            AND b.query ILIKE '%INSERT INTO%Account%'
            AND EXISTS (
              SELECT 1 FROM pg_stat_activity a
              WHERE a.datname = current_database()
                AND a.application_name = ${tagA}
                AND a.pid = ANY (pg_blocking_pids(b.pid)))`;
        return Number(rows[0].n) === 1;
      };
      const describeSessions = async () => {
        const rows = await prisma.$queryRaw<object[]>`
          SELECT application_name, state, wait_event_type, wait_event,
                 pg_blocking_pids(pid) AS blocked_by, left(query, 80) AS query
          FROM pg_stat_activity
          WHERE datname = current_database()
            AND application_name IN (${tagA}, ${tagB})`;
        return JSON.stringify(rows);
      };

      let pageA!: request.Response;
      let pageB!: request.Response;
      try {
        const approvalA = request(server())
          .get(pathA)
          .then((res) => res);
        await emailAReached;
        sessionTag = tagB;
        const approvalB = request(server())
          .get(pathB)
          .then((res) => res);
        let observed = false;
        for (let waited = 0; waited <= 10_000; waited += 25) {
          if (await isBBlockedByA()) {
            observed = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        if (!observed) {
          // Fail closed: never release A on a guess. Let both requests drain
          // (A is released only so the app can shut down) and report.
          const sessions = await describeSessions();
          releaseA();
          await Promise.allSettled([approvalA, approvalB]);
          throw new Error(
            `approval B was never observed blocked by approval A on the Account insert; tagged sessions: ${sessions}`,
          );
        }
        releaseA();
        [pageA, pageB] = await Promise.all([approvalA, approvalB]);
      } finally {
        tagSessions.mockRestore();
      }

      expect(pageA.status, pageA.text).toBe(200);
      expect(pageA.text).toMatch(/aprobado/i);
      expectRetryPage(pageB, /nombre de usuario/i);
      await expectStillPending(name('Choque Dos'));
      const contextA = (await stored(name('Choque Uno')))!.createdContextId!;
      await expect(
        prisma.account.findMany({ where: { username: email } }),
      ).resolves.toMatchObject([{ contextId: contextA }]);
      expect(sendCredentialsEmail).toHaveBeenCalledTimes(1);
      const credsA = lastCredentials();

      await request(server()).get(pathB).expect(200);

      expect(sendCredentialsEmail).toHaveBeenCalledTimes(2);
      const credsB = lastCredentials();
      expect(credsB.username).not.toBe(email);
      expect(credsB.username).toMatch(/^choque-dos-.*[0-9a-f]{6}$/);
      expect((await stored(name('Choque Dos')))?.status).toBe('aprobado');
      await login(credsB.username, credsB.temporaryPassword).expect(200);
      await login(email, credsA.temporaryPassword).expect(200);
      // The 15 s budget leaves room for the 10 s probe bound, so a probe that
      // never matches fails with its own diagnostic, not a generic timeout.
    }, 15_000);

    it('sends the credentials to the approver when the contact is not an email', async () => {
      const path = await register(
        name('Solo Telefono'),
        'Socia Sin Correo',
        '<i>555-0100</i>',
      );

      const page = await request(server()).get(path).expect(200);

      expect(sendCredentialsEmail).toHaveBeenCalledTimes(1);
      const creds = lastCredentials();
      // No socio address: EmailService routes it to APPROVAL_NOTIFICATION_EMAIL
      // with a relay note (covered in email.service.spec.ts).
      expect(creds.socioEmail).toBeUndefined();
      expect(creds.contactoSocio).toBe('<i>555-0100</i>');
      expect(creds.username).toMatch(/^solo-telefono-[a-z0-9-]*[0-9a-f]{6}$/);
      expect(page.text).toMatch(/aprobador/i);
      expect(page.text).toContain('&lt;i&gt;555-0100&lt;/i&gt;');
      expect(page.text).not.toContain('<i>');
      expect(page.text).not.toContain(creds.temporaryPassword);
      await login(creds.username, creds.temporaryPassword).expect(200);
    });

    it('answers 200 with a truthful page when the credentials were forwarded to the approver because Resend test mode rejected the socio', async () => {
      const email = `respaldo.${run}@example.com`;
      const path = await register(
        name('Resend Modo Prueba'),
        'Socio Respaldo',
        email,
      );
      sendCredentialsEmail.mockResolvedValueOnce({
        deliveredTo: 'approver-fallback',
      });

      const page = await request(server()).get(path).expect(200);

      expect(page.headers['content-type']).toMatch(/html/);
      expect(page.text).toMatch(/aprobado/i);
      expect(page.text).toMatch(/aprobador/i);
      expect(page.text).toMatch(/modo de prueba/i);
      expect(page.text).toMatch(/hazlas llegar/i);
      expect(page.text).toContain(email);
      // Truthful: it must not claim they went to the socio.
      expect(page.text).not.toMatch(/se enviaron por correo a/i);
      const creds = lastCredentials();
      expect(page.text).not.toContain(creds.temporaryPassword);

      const registration = await stored(name('Resend Modo Prueba'));
      expect(registration?.status).toBe('aprobado');
      const contextId = registration!.createdContextId!;
      const account = await prisma.account.findUnique({
        where: { username: creds.username },
      });
      expect(account?.contextId).toBe(contextId);
      const device = await withTestTenant(contextId, () =>
        prisma.device.findFirst({ where: { contextId } }),
      );
      expect(device?.identifier).toBe(creds.deviceIdentifier);
      const members = await withTestTenant(contextId, () =>
        prisma.member.count({ where: { contextId, role: 'socio' } }),
      );
      expect(members).toBe(1);
      await login(creds.username, creds.temporaryPassword).expect(200);
    });

    it('still answers 502 and rolls everything back when the fallback to the approver also fails', async () => {
      const email = `respaldo.falla.${run}@example.com`;
      const path = await register(name('Respaldo Falla'), 'Socio Falla', email);
      sendCredentialsEmail.mockRejectedValueOnce(
        new Error(
          'Resend rejected the credentials email (validation_error) and the fallback to the approver also failed: Resend rejected the credentials email: rate_limit_exceeded: Too many requests',
        ),
      );

      const failed = await request(server()).get(path);

      expectRetryPage(failed, /no se pudo enviar/i);
      const attempt = lastCredentials();
      expect(failed.text).not.toContain(attempt.temporaryPassword);
      await expectStillPending(name('Respaldo Falla'));
      await expect(
        prisma.account.findUnique({ where: { username: email } }),
      ).resolves.toBeNull();
    });

    it('never reuses a taken username: falls back to a unique one and leaves the other account alone', async () => {
      const email = `colision.${run}@example.com`;
      const existing = await prisma.account.create({
        data: {
          username: email,
          passwordHash: 'not-a-login-fixture',
          contextId: contextIdA,
        },
      });
      extraUsernames.push(email);
      const path = await register(
        name('Colision'),
        'Otra Socia',
        `Colision.${run}@EXAMPLE.com`,
      );

      await request(server()).get(path).expect(200);

      const creds = lastCredentials();
      expect(creds.socioEmail).toBe(email);
      expect(creds.username).not.toBe(email);
      expect(creds.username).toMatch(/^colision-.*[0-9a-f]{6}$/);
      const untouched = await prisma.account.findUnique({
        where: { id: existing.id },
      });
      expect(untouched).toMatchObject({
        username: email,
        passwordHash: 'not-a-login-fixture',
        contextId: contextIdA,
      });
      await login(creds.username, creds.temporaryPassword).expect(200);
    });

    it('creates nothing extra when the same link is used twice', async () => {
      const path = await register(
        name('Dos Clicks'),
        'Socio Doble',
        `dos.${run}@example.com`,
      );

      await request(server()).get(path).expect(200);
      const second = await request(server()).get(path).expect(200);

      expect(second.text).toMatch(/ya fue procesado/i);
      expect(sendCredentialsEmail).toHaveBeenCalledTimes(1);
      const contextId = (await stored(name('Dos Clicks')))!.createdContextId!;
      await expect(
        prisma.account.count({ where: { contextId } }),
      ).resolves.toBe(1);
      const devices = await withTestTenant(contextId, () =>
        prisma.device.count({ where: { contextId } }),
      );
      expect(devices).toBe(1);
    });

    it('creates a single account and sends a single email when the link is opened concurrently', async () => {
      const path = await register(
        name('Carrera'),
        'Socio Veloz',
        `carrera.${run}@example.com`,
      );

      const pages = await Promise.all([
        request(server()).get(path),
        request(server()).get(path),
      ]);

      expect(pages.map((p) => p.status)).toEqual([200, 200]);
      expect(
        pages.filter((p) => /ya fue procesado/i.test(p.text)),
      ).toHaveLength(1);
      expect(sendCredentialsEmail).toHaveBeenCalledTimes(1);
      const contextId = (await stored(name('Carrera')))!.createdContextId!;
      await expect(
        prisma.account.count({ where: { contextId } }),
      ).resolves.toBe(1);
      const founders = await withTestTenant(contextId, () =>
        prisma.member.count({ where: { contextId, role: 'socio' } }),
      );
      expect(founders).toBe(1);
    });

    it('does not create an account when the request is rejected', async () => {
      await request(server())
        .post('/api/v1/business-registration')
        .send({
          nombreNegocio: name('Rechazo Sin Cuenta'),
          nombreSocio: 'Nadie',
          contactoSocio: `nadie.${run}@example.com`,
        })
        .expect(201);
      const { rejectUrl } = sendApprovalEmail.mock.calls.at(-1)![0];

      await request(server()).get(emailPath(rejectUrl)).expect(200);

      expect(sendCredentialsEmail).not.toHaveBeenCalled();
      await expect(
        prisma.account.findUnique({ where: { username: `nadie.${run}@example.com` } }),
      ).resolves.toBeNull();
    });
  });

  describe('stored XSS in the status pages', () => {
    // Public form input reaches an HTML page opened in the approver's
    // browser: it must be rendered as text, never as markup.
    const registerHostile = async (nombreNegocio: string) => {
      await request(app.getHttpServer())
        .post('/api/v1/business-registration')
        .send({
          nombreNegocio,
          nombreSocio: 'Socio Hostil',
          contactoSocio: 'hostil@example.com',
        })
        .expect(201);
      return sendApprovalEmail.mock.calls[0][0] as {
        approveUrl: string;
        rejectUrl: string;
      };
    };

    it('escapes the business name on the approve page', async () => {
      const { approveUrl } = await registerHostile(
        name('<script>alert(1)</script>'),
      );

      const res = await request(app.getHttpServer())
        .get(emailPath(approveUrl))
        .expect(200);

      expect(res.text).not.toContain('<script>');
      expect(res.text).toContain(
        `&lt;script&gt;alert(1)&lt;/script&gt; ${run}`,
      );
    });

    it('escapes the business name on the reject page', async () => {
      const { rejectUrl } = await registerHostile(
        name('<script>alert(1)</script>'),
      );

      const res = await request(app.getHttpServer())
        .get(emailPath(rejectUrl))
        .expect(200);

      expect(res.text).not.toContain('<script>');
      expect(res.text).toContain(
        `&lt;script&gt;alert(1)&lt;/script&gt; ${run}`,
      );
    });

    it('escapes quotes and ampersands too (attribute-breaking payloads)', async () => {
      const hostile = name(`"><img src=x onerror='a&b'>`);
      const { rejectUrl } = await registerHostile(hostile);

      const res = await request(app.getHttpServer())
        .get(emailPath(rejectUrl))
        .expect(200);

      expect(res.text).not.toContain('<img');
      expect(res.text).toContain(
        `&quot;&gt;&lt;img src=x onerror=&#39;a&amp;b&#39;&gt; ${run}`,
      );
    });
  });

  it('returns an invalid-link page for a token that does not match any request', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/business-registration/approve')
      .query({ token: 'not-a-real-token' })
      .expect(404);
    expect(res.text).toMatch(/inválido/i);
  });
});

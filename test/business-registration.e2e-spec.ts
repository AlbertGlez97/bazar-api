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
    const module = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(EmailService)
      .useValue({ sendBusinessRegistrationApprovalEmail: sendApprovalEmail })
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
    for (const { createdContextId } of requests) {
      if (createdContextId)
        await withTestTenant(createdContextId, () =>
          prisma.member.deleteMany({ where: { contextId: createdContextId } }),
        );
    }
    await prisma.businessRegistrationRequest.deleteMany({
      where: { nombreNegocio: { endsWith: run } },
    });
    await app.close();
    await rm(uploadRoot, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    sendApprovalEmail.mockClear();
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

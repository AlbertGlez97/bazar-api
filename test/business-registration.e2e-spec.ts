import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
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

  // Business names are unique per run: the test database persists between
  // runs and these specs look requests up by name, so a fixed name would
  // also match rows left behind by an earlier (or crashed) run.
  const run = randomUUID();
  const name = (label: string) => `${label} ${run}`;

  const extractToken = (url: string) => new URL(url).searchParams.get('token')!;

  beforeAll(async () => {
    sendApprovalEmail = vi.fn().mockResolvedValue(undefined);
    const module = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(EmailService)
      .useValue({ sendBusinessRegistrationApprovalEmail: sendApprovalEmail })
      .compile();
    app = module.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
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
  });

  beforeEach(() => {
    sendApprovalEmail.mockClear();
  });

  it('creates the request as pendiente and "sends" the approval email without calling Resend', async () => {
    const res = await request(app.getHttpServer())
      .post('/business-registration')
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
      .post('/business-registration')
      .send({
        nombreNegocio: name('Bolsas de Adid'),
        nombreSocio: 'Adid',
        contactoSocio: 'adid@example.com',
      })
      .expect(201);
    const { approveUrl } = sendApprovalEmail.mock.calls[0][0];
    const token = extractToken(approveUrl);

    const res = await request(app.getHttpServer())
      .get('/business-registration/approve')
      .query({ token })
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
      .post('/business-registration')
      .send({
        nombreNegocio: name('Lucha Libre Negocio'),
        nombreSocio: 'Rudo Anonimo',
        contactoSocio: '555-0000',
      })
      .expect(201);
    const { rejectUrl } = sendApprovalEmail.mock.calls[0][0];
    const token = extractToken(rejectUrl);

    const res = await request(app.getHttpServer())
      .get('/business-registration/reject')
      .query({ token })
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
      .post('/business-registration')
      .send({
        nombreNegocio: name('Artículos Varios'),
        nombreSocio: 'Socia Fundadora',
        contactoSocio: 'socia@example.com',
      })
      .expect(201);
    const { approveUrl } = sendApprovalEmail.mock.calls[0][0];
    const token = extractToken(approveUrl);

    await request(app.getHttpServer())
      .get('/business-registration/approve')
      .query({ token })
      .expect(200);
    const second = await request(app.getHttpServer())
      .get('/business-registration/approve')
      .query({ token })
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
      .post('/business-registration')
      .send({
        nombreNegocio: name('Negocio Expirado'),
        nombreSocio: 'Fundador Tardío',
        contactoSocio: 'tarde@example.com',
      })
      .expect(201);
    const { approveUrl } = sendApprovalEmail.mock.calls[0][0];
    const token = extractToken(approveUrl);

    await prisma.businessRegistrationRequest.updateMany({
      where: { nombreNegocio: name('Negocio Expirado') },
      data: { tokenExpiresAt: new Date(Date.now() - 1000) },
    });

    const res = await request(app.getHttpServer())
      .get('/business-registration/approve')
      .query({ token })
      .expect(200);
    expect(res.text).toMatch(/expiró/i);

    const stored = await prisma.businessRegistrationRequest.findFirst({
      where: { nombreNegocio: name('Negocio Expirado') },
    });
    expect(stored?.status).toBe('pendiente');
    expect(stored?.createdContextId).toBeNull();
  });

  it('returns an invalid-link page for a token that does not match any request', async () => {
    const res = await request(app.getHttpServer())
      .get('/business-registration/approve')
      .query({ token: 'not-a-real-token' })
      .expect(404);
    expect(res.text).toMatch(/inválido/i);
  });
});

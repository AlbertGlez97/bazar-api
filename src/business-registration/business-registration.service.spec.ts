import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import {
  APPROVE_TRANSACTION_OPTIONS,
  BusinessRegistrationService,
} from './business-registration.service.js';
import { Prisma } from '../generated/prisma/client.js';
import type { PrismaService } from '../database/prisma.service.js';
import { CREDENTIALS_EMAIL_TIMEOUT_MS } from '../email/email.service.js';
import type { EmailService } from '../email/email.service.js';

afterEach(() => vi.unstubAllEnvs());

describe('approval email API URLs', () => {
  it.each([
    ['https://api.example.test', 'https://api.example.test'],
    ['https://api.example.test/', 'https://api.example.test'],
    ['https://api.example.test/api/v1', 'https://api.example.test'],
    ['https://api.example.test/api/v1/', 'https://api.example.test'],
    ['  https://api.example.test/api/v1  ', 'https://api.example.test'],
    ['https://api.example.test/API/v1', 'https://api.example.test'],
    ['https://api.example.test/Api/V1/', 'https://api.example.test'],
    ['https://api.example.test/api/v1?x=1', 'https://api.example.test'],
    ['https://api.example.test/?x=1', 'https://api.example.test'],
    ['https://api.example.test/api/v1#frag', 'https://api.example.test'],
    ['', 'http://localhost:3100'],
    [undefined, 'http://localhost:3100'],
  ])(
    'uses the configured origin %s without duplicating slashes',
    async (base, origin) => {
      vi.stubEnv('APP_BASE_URL', base);
      vi.stubEnv('PORT', '3100');
      const create = vi
        .fn()
        .mockResolvedValue({ id: 'test', status: 'pendiente' });
      const send = vi.fn().mockResolvedValue(undefined);
      const service = new BusinessRegistrationService(
        { businessRegistrationRequest: { create } } as unknown as PrismaService,
        {
          sendBusinessRegistrationApprovalEmail: send,
        } as unknown as EmailService,
      );
      await service.create({
        nombreNegocio: 'Test',
        nombre: 'Test',
        apellidos: 'Socio',
        correo: 'test@example.test',
      });
      const links = send.mock.calls[0][0];
      const approve = new URL(links.approveUrl);
      const reject = new URL(links.rejectUrl);
      expect(approve.origin).toBe(origin);
      expect(reject.origin).toBe(origin);
      expect(approve.pathname).toBe('/api/v1/business-registration/approve');
      expect(reject.pathname).toBe('/api/v1/business-registration/reject');
      expect(approve.searchParams.get('token')).toBeTruthy();
      expect(reject.search).toBe(approve.search);
    },
  );
});

describe('create', () => {
  const build = () => {
    const create = vi.fn().mockResolvedValue({
      id: 'test',
      status: 'pendiente',
      createdAt: new Date(),
    });
    const send = vi.fn().mockResolvedValue(undefined);
    const service = new BusinessRegistrationService(
      { businessRegistrationRequest: { create } } as unknown as PrismaService,
      {
        sendBusinessRegistrationApprovalEmail: send,
      } as unknown as EmailService,
    );
    return { service, create, send };
  };
  const dto = {
    nombreNegocio: 'Bonsáis',
    nombre: 'Alberto',
    apellidos: 'Gómez',
    correo: ' Alberto@Example.COM ',
  };

  it('stores nombre, apellidos, the trimmed lower-cased correo and a null telefono when it is absent', async () => {
    const { service, create } = build();

    await service.create(dto);

    const { data } = create.mock.calls[0][0];
    expect(data).toMatchObject({
      nombreNegocio: 'Bonsáis',
      nombre: 'Alberto',
      apellidos: 'Gómez',
      correo: 'alberto@example.com',
      telefono: null,
    });
    expect(data).not.toHaveProperty('nombreSocio');
    expect(data).not.toHaveProperty('contactoSocio');
  });

  it('stores the telefono and forwards every field to the approval email', async () => {
    const { service, create, send } = build();

    await service.create({ ...dto, telefono: '555-123-4567' });

    expect(create.mock.calls[0][0].data.telefono).toBe('555-123-4567');
    expect(send.mock.calls[0][0]).toMatchObject({
      nombreNegocio: 'Bonsáis',
      nombre: 'Alberto',
      apellidos: 'Gómez',
      correo: 'alberto@example.com',
      telefono: '555-123-4567',
    });
  });
});

describe('approve transaction options', () => {
  // The credentials email is sent from inside the approve transaction, so
  // Prisma's default 5s interactive-transaction timeout (a slow Resend call
  // would roll the approval back) must be raised explicitly.
  it('opens the approve transaction with a timeout sized for a Resend call', async () => {
    const findFirst = vi.fn().mockResolvedValue({
      id: 'req',
      status: 'pendiente',
      tokenExpiresAt: new Date(Date.now() + 60_000),
      nombreNegocio: 'Test',
      nombre: 'Test',
      apellidos: 'Socio',
      correo: 'test@example.test',
      telefono: null,
    });
    const $transaction = vi.fn().mockResolvedValue('<html></html>');
    const service = new BusinessRegistrationService(
      {
        businessRegistrationRequest: { findFirst },
        $transaction,
      } as unknown as PrismaService,
      {} as unknown as EmailService,
    );

    await service.approve('token');

    const options = $transaction.mock.calls[0][1] as {
      timeout: number;
      maxWait: number;
    };
    expect(options.timeout).toBeGreaterThanOrEqual(10_000);
    expect(options.maxWait).toBeGreaterThan(0);
  });

  // The Resend calls run inside that transaction and have no abort signal in
  // the installed SDK, so EmailService bounds them with its own timer. That
  // timer is the TOTAL deadline of the direct send plus the approver
  // fallback (they share it; two per-send timeouts would add up past the
  // transaction). It must fire first, in a controlled way
  // (-> CredentialsEmailError, clean rollback, 502), instead of the
  // transaction expiring under a pending call. The margin covers the queries
  // and the Argon2 hash that run before the email is sent.
  it('keeps the credentials email total deadline (direct send + fallback) below the transaction timeout', () => {
    expect(CREDENTIALS_EMAIL_TIMEOUT_MS).toBeLessThan(
      APPROVE_TRANSACTION_OPTIONS.timeout,
    );
    expect(
      APPROVE_TRANSACTION_OPTIONS.timeout - CREDENTIALS_EMAIL_TIMEOUT_MS,
    ).toBeGreaterThanOrEqual(5_000);
  });
});

describe('approve failures that keep the request pending', () => {
  const pendingRequest = {
    id: 'req',
    status: 'pendiente',
    tokenExpiresAt: new Date(Date.now() + 60_000),
    nombreNegocio: 'Test',
    nombre: 'Test',
    apellidos: 'Socio',
    correo: 'test@example.test',
    telefono: null,
  };
  const clientVersion = '7.10.0';
  const serviceFailingWith = (error: unknown) =>
    new BusinessRegistrationService(
      {
        businessRegistrationRequest: {
          findFirst: vi.fn().mockResolvedValue(pendingRequest),
        },
        $transaction: vi.fn().mockRejectedValue(error),
      } as unknown as PrismaService,
      {} as unknown as EmailService,
    );
  const silenceLogger = () =>
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

  afterEach(() => vi.restoreAllMocks());

  it('answers the 502 retry page when the transaction expired', async () => {
    const log = silenceLogger();
    const expired = new Prisma.PrismaClientKnownRequestError(
      'Transaction API error: A commit cannot be executed on an expired transaction.',
      {
        code: 'P2028',
        clientVersion,
        meta: { operation: 'commit', timeout: 15_000, timeTaken: 15_600 },
      },
    );

    const result = await serviceFailingWith(expired).approve('token');

    expect(result.statusCode).toBe(502);
    expect(result.html).toMatch(/no se completó/i);
    expect(result.html).toMatch(/sigue pendiente/i);
    expect(result.html).toMatch(/mismo enlace/i);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('answers the 502 retry page on a username collision, without logging the raw Prisma message', async () => {
    const log = silenceLogger();
    const collision = new Prisma.PrismaClientKnownRequestError(
      'Unique constraint failed on the constraint: `Account_username_key`',
      {
        code: 'P2002',
        clientVersion,
        meta: {
          modelName: 'Account',
          driverAdapterError: {
            cause: {
              originalCode: '23505',
              constraint: { index: 'Account_username_key' },
              table: 'Account',
            },
          },
        },
      },
    );

    const result = await serviceFailingWith(collision).approve('token');

    expect(result.statusCode).toBe(502);
    expect(result.html).toMatch(/no se completó/i);
    expect(result.html).toMatch(/sigue pendiente/i);
    expect(result.html).toMatch(/mismo enlace/i);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('Unique'));
  });

  it.each([
    [
      'a unique violation on another constraint',
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion,
        meta: { modelName: 'Device', target: ['identifier'] },
      }),
    ],
    [
      'the P2028 for a transaction that could not start',
      new Prisma.PrismaClientKnownRequestError('Unable to start', {
        code: 'P2028',
        clientVersion,
        meta: { maxWait: 5_000 },
      }),
    ],
    ['an unrelated error', new Error('database is down')],
  ])('still rethrows %s untouched', async (_label, error) => {
    silenceLogger();

    await expect(serviceFailingWith(error).approve('token')).rejects.toBe(
      error,
    );
  });
});

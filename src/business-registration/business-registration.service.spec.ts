import { afterEach, describe, expect, it, vi } from 'vitest';
import { BusinessRegistrationService } from './business-registration.service.js';
import type { PrismaService } from '../database/prisma.service.js';
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
        nombreSocio: 'Test',
        contactoSocio: 'test@example.test',
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
      nombreSocio: 'Test',
      contactoSocio: 'test@example.test',
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
});

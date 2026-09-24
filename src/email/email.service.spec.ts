import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { EmailService } from './email.service.js';

// The Resend SDK does not throw on API errors: emails.send resolves to
// `{ data, error }`. These tests pin that behavior so a rejected email can
// never again look like a successful one.
const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('resend', () => ({
  Resend: class {
    emails = { send };
  },
}));

const input = {
  nombreNegocio: 'Bolsas de prueba',
  nombreSocio: 'Socio',
  contactoSocio: '555-000-0000',
  approveUrl: 'http://localhost:3000/api/v1/business-registration/approve?t=x',
  rejectUrl: 'http://localhost:3000/api/v1/business-registration/reject?t=x',
};
const API_KEY = 're_test_secret_key_do_not_leak';

describe('EmailService.sendBusinessRegistrationApprovalEmail', () => {
  let log: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubEnv('RESEND_API_KEY', API_KEY);
    vi.stubEnv('APPROVAL_NOTIFICATION_EMAIL', 'approver@example.test');
    send.mockReset();
    log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('rejects when Resend answers with an error instead of reporting success', async () => {
    send.mockResolvedValue({
      data: null,
      error: {
        name: 'validation_error',
        message: 'You can only send testing emails to your own email address',
      },
    });

    await expect(
      new EmailService().sendBusinessRegistrationApprovalEmail(input),
    ).rejects.toThrow(/validation_error.*testing emails/);
  });

  it('never leaks the API key in the error it throws', async () => {
    send.mockResolvedValue({
      data: null,
      error: { name: 'invalid_api_key', message: 'API key is invalid' },
    });

    const failure = await new EmailService()
      .sendBusinessRegistrationApprovalEmail(input)
      .catch((e: Error) => e);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('invalid_api_key');
    expect((failure as Error).message).not.toContain(API_KEY);
  });

  it('logs the Resend message id when the email is accepted', async () => {
    send.mockResolvedValue({ data: { id: 'msg_123' }, error: null });

    await expect(
      new EmailService().sendBusinessRegistrationApprovalEmail(input),
    ).resolves.toBeUndefined();

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'onboarding@resend.dev',
        to: 'approver@example.test',
      }),
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining('msg_123'));
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining(API_KEY));
  });

  it('escapes user-supplied text in the approval email HTML', async () => {
    send.mockResolvedValue({ data: { id: 'msg_xss' }, error: null });

    await new EmailService().sendBusinessRegistrationApprovalEmail({
      ...input,
      nombreNegocio: '<script>alert(1)</script>',
      nombreSocio: `"><img src=x onerror='a&b'>`,
      contactoSocio: '<b>555</b>',
    });

    const { html } = send.mock.calls[0][0] as { html: string };
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain(
      '&quot;&gt;&lt;img src=x onerror=&#39;a&amp;b&#39;&gt;',
    );
    expect(html).toContain('&lt;b&gt;555&lt;/b&gt;');
  });

  it('still fails fast when the approver address is not configured', async () => {
    vi.stubEnv('APPROVAL_NOTIFICATION_EMAIL', '');

    await expect(
      new EmailService().sendBusinessRegistrationApprovalEmail(input),
    ).rejects.toThrow(/APPROVAL_NOTIFICATION_EMAIL/);
    expect(send).not.toHaveBeenCalled();
  });
});

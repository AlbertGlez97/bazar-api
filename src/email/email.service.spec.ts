import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import {
  CREDENTIALS_EMAIL_TIMEOUT_MS,
  EmailService,
} from './email.service.js';

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

describe('EmailService.sendBusinessCredentialsEmail', () => {
  const credentials = {
    nombreNegocio: 'Bolsas de prueba',
    nombreSocio: 'Socio',
    contactoSocio: 'socio@example.test',
    username: 'socio@example.test',
    temporaryPassword: 'Tmp-Pass_0123456789abcd',
    deviceName: 'Dispositivo principal',
    deviceIdentifier: '0b6f1c2e-4d5a-4c7b-9e1f-123456789abc',
  };

  beforeEach(() => {
    vi.stubEnv('RESEND_API_KEY', API_KEY);
    vi.stubEnv('APPROVAL_NOTIFICATION_EMAIL', 'approver@example.test');
    send.mockReset();
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const sentPayload = () =>
    send.mock.calls[0][0] as { to: string; subject: string; html: string };

  it('sends the credentials to the socio with everything needed to sign in', async () => {
    send.mockResolvedValue({ data: { id: 'msg_cred' }, error: null });

    await new EmailService().sendBusinessCredentialsEmail({
      ...credentials,
      socioEmail: 'socio@example.test',
    });

    const { to, html } = sentPayload();
    expect(to).toBe('socio@example.test');
    expect(html).toContain('socio@example.test');
    expect(html).toContain(credentials.temporaryPassword);
    expect(html).toContain(credentials.deviceIdentifier);
    expect(html).toContain(credentials.deviceName);
    expect(html).toMatch(/contraseña temporal/i);
    expect(html).not.toMatch(/reenv|hacer llegar/i);
  });

  it('sends to the approver with a relay note when the socio has no email', async () => {
    send.mockResolvedValue({ data: { id: 'msg_cred' }, error: null });

    await new EmailService().sendBusinessCredentialsEmail({
      ...credentials,
      contactoSocio: '555-000-0000',
    });

    const { to, subject, html } = sentPayload();
    expect(to).toBe('approver@example.test');
    expect(subject).toMatch(/reenviar|socio/i);
    expect(html).toContain('555-000-0000');
    expect(html).toMatch(/hacer llegar al socio/i);
    expect(html).toContain(credentials.temporaryPassword);
  });

  it('escapes every interpolated value', async () => {
    send.mockResolvedValue({ data: { id: 'msg_cred' }, error: null });

    await new EmailService().sendBusinessCredentialsEmail({
      nombreNegocio: '<script>alert(1)</script>',
      nombreSocio: `"><img src=x onerror='a&b'>`,
      contactoSocio: '<b>555</b>',
      username: '<u>user</u>',
      temporaryPassword: 'p<i>ss</i>&"\'',
      deviceName: '<em>dev</em>',
      deviceIdentifier: '<s>id</s>',
    });

    const { html } = sentPayload();
    expect(html).not.toMatch(/<(script|img|b|u|i|em|s)[ >]/);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('p&lt;i&gt;ss&lt;/i&gt;&amp;&quot;&#39;');
    expect(html).toContain('&lt;s&gt;id&lt;/s&gt;');
  });

  it('throws when Resend rejects the email, without leaking the key or the password', async () => {
    send.mockResolvedValue({
      data: null,
      error: { name: 'invalid_api_key', message: 'API key is invalid' },
    });

    const failure = await new EmailService()
      .sendBusinessCredentialsEmail({
        ...credentials,
        socioEmail: 'socio@example.test',
      })
      .catch((e: Error) => e);

    expect(failure).toBeInstanceOf(Error);
    const { message } = failure as Error;
    expect(message).toContain('invalid_api_key');
    expect(message).not.toContain(API_KEY);
    expect(message).not.toContain(credentials.temporaryPassword);
  });

  it('never logs the password', async () => {
    send.mockResolvedValue({ data: { id: 'msg_cred' }, error: null });
    const log = vi.spyOn(Logger.prototype, 'log');

    await new EmailService().sendBusinessCredentialsEmail({
      ...credentials,
      socioEmail: 'socio@example.test',
    });

    expect(log).toHaveBeenCalledWith(expect.stringContaining('msg_cred'));
    expect(log).not.toHaveBeenCalledWith(
      expect.stringContaining(credentials.temporaryPassword),
    );
  });

  it('fails fast when it must relay through the approver and none is configured', async () => {
    vi.stubEnv('APPROVAL_NOTIFICATION_EMAIL', '');

    await expect(
      new EmailService().sendBusinessCredentialsEmail(credentials),
    ).rejects.toThrow(/APPROVAL_NOTIFICATION_EMAIL/);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('EmailService.sendBusinessCredentialsEmail timeout', () => {
  const credentials = {
    nombreNegocio: 'Bolsas de prueba',
    nombreSocio: 'Socio',
    contactoSocio: 'socio@example.test',
    socioEmail: 'socio@example.test',
    username: 'socio@example.test',
    temporaryPassword: 'Tmp-Pass_0123456789abcd',
    deviceName: 'Dispositivo principal',
    deviceIdentifier: '0b6f1c2e-4d5a-4c7b-9e1f-123456789abc',
  };

  beforeEach(() => {
    vi.stubEnv('RESEND_API_KEY', API_KEY);
    vi.stubEnv('APPROVAL_NOTIFICATION_EMAIL', 'approver@example.test');
    send.mockReset();
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('gives up with a timeout error when Resend never answers, without leaking secrets', async () => {
    send.mockReturnValue(new Promise(() => undefined));

    const outcome = new EmailService()
      .sendBusinessCredentialsEmail(credentials)
      .catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(CREDENTIALS_EMAIL_TIMEOUT_MS - 1);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);

    const failure = await outcome;
    expect(failure).toBeInstanceOf(Error);
    const { message } = failure as Error;
    expect(message).toBe(
      `Resend credentials email timed out after ${CREDENTIALS_EMAIL_TIMEOUT_MS} ms`,
    );
    expect(message).not.toContain(API_KEY);
    expect(message).not.toContain(credentials.temporaryPassword);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears its timer when Resend accepts the email', async () => {
    send.mockResolvedValue({ data: { id: 'msg_cred' }, error: null });

    await new EmailService().sendBusinessCredentialsEmail(credentials);

    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears its timer when Resend rejects the email', async () => {
    send.mockResolvedValue({
      data: null,
      error: { name: 'invalid_api_key', message: 'API key is invalid' },
    });

    await expect(
      new EmailService().sendBusinessCredentialsEmail(credentials),
    ).rejects.toThrow(/invalid_api_key/);

    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears its timer when the Resend call itself throws', async () => {
    send.mockRejectedValue(new Error('network down'));

    await expect(
      new EmailService().sendBusinessCredentialsEmail(credentials),
    ).rejects.toThrow('network down');

    expect(vi.getTimerCount()).toBe(0);
  });
});

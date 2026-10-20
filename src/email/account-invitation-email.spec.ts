import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { EmailService } from './email.service.js';

// Correo de invitación para crear una cuenta personal. Resend no se llama de verdad.
const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('resend', () => ({
  Resend: class {
    emails = { send };
  },
}));

beforeEach(() => {
  vi.stubEnv('RESEND_API_KEY', 're_test_secret_key_do_not_leak');
  send.mockReset();
  send.mockResolvedValue({ data: { id: 'email_1' }, error: null });
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const URL_WITH_TOKEN = 'https://marchanta.example.test/invitacion/abc_DEF-123';
const input = {
  to: 'beto@example.test',
  memberName: 'Beto',
  inviterName: 'Ana',
  businessName: 'Bazar Sol',
  inviteUrl: URL_WITH_TOKEN,
  expiresInHours: 72,
};
const sent = () => send.mock.calls[0]![0] as { to: string; subject: string; html: string; text: string };

describe('correo de invitación a una cuenta personal', () => {
  it('va al socio invitado con el enlace y dice cuánto dura', async () => {
    await new EmailService().sendAccountInvitationEmail(input);

    expect(sent().to).toBe('beto@example.test');
    expect(sent().subject).toBe('Te invitaron a crear tu cuenta en Bazar Sol');
    expect(sent().html).toContain(`href="${URL_WITH_TOKEN}"`);
    expect(sent().text).toContain(URL_WITH_TOKEN);
    expect(sent().text).toContain('72 horas');
    expect(sent().text).toContain('Ana te invitó');
  });

  it('nunca lleva contraseña, ni temporal ni de ningún tipo', async () => {
    await new EmailService().sendAccountInvitationEmail(input);

    expect(sent().text.toLowerCase()).not.toContain('contraseña temporal');
    expect(sent().html.toLowerCase()).not.toContain('contraseña temporal');
    expect(sent().text).toContain('Tú eliges tu contraseña');
  });

  it('escapa los nombres y no deja que el enlace se salga del atributo', async () => {
    await new EmailService().sendAccountInvitationEmail({
      ...input,
      memberName: '<b>Beto</b>',
      inviterName: '"><script>x</script>',
      businessName: 'A&B',
      inviteUrl: 'https://x.test/invitacion/a"onmouseover="y',
    });

    expect(sent().html).not.toContain('<script>');
    expect(sent().html).not.toContain('<b>Beto</b>');
    expect(sent().html).not.toContain('"onmouseover=');
    expect(sent().html).toContain('&lt;b&gt;Beto&lt;/b&gt;');
  });

  it('un rechazo de Resend sube como error', async () => {
    send.mockResolvedValue({ data: null, error: { name: 'validation_error', message: 'no' } });

    await expect(new EmailService().sendAccountInvitationEmail(input)).rejects.toThrow();
  });
});

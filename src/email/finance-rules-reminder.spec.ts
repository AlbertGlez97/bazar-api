import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { EmailService } from './email.service.js';

// Recordatorio de reglas de reparto. Resend no se llama de verdad.
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

const input = {
  to: 'beto@example.test',
  memberName: 'Beto',
  proposerName: 'Ana',
  businessName: 'Bazar Sol',
};
const sent = () =>
  send.mock.calls[0]![0] as { to: string; subject: string; html: string; text: string };

describe('correo de recordatorio de reglas de reparto', () => {
  it('va al socio que falta, dice quién propuso y no lleva enlaces ni secretos', async () => {
    await new EmailService().sendFinanceRulesReminderEmail(input);

    expect(sent().to).toBe('beto@example.test');
    expect(sent().subject).toBe('Reglas de reparto por aprobar: Bazar Sol');
    expect(sent().text).toContain('Ana propuso reglas de reparto para Bazar Sol');
    expect(sent().html).not.toMatch(/href|http/i);
    expect(sent().text).not.toMatch(/http/i);
  });

  it('escapa los nombres en el HTML', async () => {
    await new EmailService().sendFinanceRulesReminderEmail({
      ...input,
      proposerName: '<b>Ana</b>',
      businessName: 'A&B <script>',
    });

    expect(sent().html).not.toContain('<script>');
    expect(sent().html).toContain('&lt;b&gt;Ana&lt;/b&gt;');
  });

  it('un rechazo de Resend sube como error', async () => {
    send.mockResolvedValue({ data: null, error: { name: 'validation_error', message: 'no' } });

    await expect(new EmailService().sendFinanceRulesReminderEmail(input)).rejects.toThrow();
  });
});

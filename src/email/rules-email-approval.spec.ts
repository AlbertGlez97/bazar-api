import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { EmailService } from './email.service.js';

// Correos de la aprobación por correo. Resend no se llama de verdad.
const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('resend', () => ({
  Resend: class {
    emails = { send };
  },
}));

beforeEach(() => {
  vi.stubEnv('RESEND_API_KEY', 're_test_secret_key_do_not_leak');
  vi.stubEnv('APPROVAL_NOTIFICATION_EMAIL', 'operador@example.test');
  send.mockReset();
  send.mockResolvedValue({ data: { id: 'email_1' }, error: null });
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

type Sent = { to: string; subject: string; html: string; text: string };
const sent = (index = 0) => send.mock.calls[index]![0] as Sent;
const TEST_MODE_REJECTION = {
  data: null,
  error: { name: 'validation_error', message: 'You can only send testing emails to your own email address' },
};

const approval = {
  to: 'beto@example.test',
  memberName: 'Beto',
  proposerName: 'Ana',
  businessName: 'Bazar Sol',
  version: 3,
  summary: ['La utilidad va 50 % por ser socio, 30 % por capital y 20 % por trabajo.', 'Se aparta 10 % para reservas antes de repartir.'],
  changes: null,
  reviewUrl: 'https://site.test/acuerdo/' + 'A'.repeat(43),
  expiresInDays: 7,
};

describe('correo de aprobación de reglas de reparto', () => {
  it('va al socio, dice quién propuso, lista las reglas y trae el botón "Revisar y responder"', async () => {
    await new EmailService().sendFinanceRulesApprovalEmail(approval);

    expect(sent().to).toBe('beto@example.test');
    expect(sent().subject).toBe('Reglas de reparto para revisar: Bazar Sol');
    expect(sent().html).toContain('Revisar y responder');
    expect(sent().html).toContain(`href="${approval.reviewUrl}"`);
    expect(sent().html).toContain('Ana propuso reglas de reparto para Bazar Sol (versión 3)');
    expect(sent().text).toContain('- La utilidad va 50 % por ser socio, 30 % por capital y 20 % por trabajo.');
    expect(sent().text).toContain(approval.reviewUrl);
  });

  it('avisa que abrir el enlace no aprueba nada y que el enlace es solo suyo', async () => {
    await new EmailService().sendFinanceRulesApprovalEmail(approval);

    expect(sent().text).toContain('Abrir el enlace no aprueba nada. Tú decides en la página.');
    expect(sent().text).toContain('sirve una vez y dura 7 días');
  });

  it('sin cambios, no trae la sección "Qué cambió"', async () => {
    await new EmailService().sendFinanceRulesApprovalEmail(approval);

    expect(sent().html).not.toContain('Qué cambió');
    expect(sent().text).not.toContain('Qué cambió');
  });

  it('con cambios, trae "Qué cambió" con el antes y el ahora de cada tema', async () => {
    await new EmailService().sendFinanceRulesApprovalEmail({
      ...approval,
      changes: [{ topic: 'Reservas', before: 'Se aparta 10 % para reservas antes de repartir.', after: 'Se aparta 20 % para reservas antes de repartir.' }],
    });

    expect(sent().html).toContain('Qué cambió');
    expect(sent().html).toContain('Antes: Se aparta 10 % para reservas');
    expect(sent().html).toContain('Ahora: Se aparta 20 % para reservas');
    expect(sent().text).toContain('- Reservas. Antes: Se aparta 10 %');
  });

  it('escapa los textos libres en el HTML', async () => {
    await new EmailService().sendFinanceRulesApprovalEmail({
      ...approval,
      proposerName: '<b>Ana</b>',
      businessName: 'A&B <script>',
      summary: ['<img src=x onerror=alert(1)>'],
    });

    expect(sent().html).not.toContain('<script>');
    expect(sent().html).not.toContain('<img');
    expect(sent().html).toContain('&lt;b&gt;Ana&lt;/b&gt;');
  });

  it('un rechazo de Resend sube como error y NO se reenvía al operador (a diferencia de las credenciales)', async () => {
    send.mockResolvedValue(TEST_MODE_REJECTION);

    await expect(new EmailService().sendFinanceRulesApprovalEmail(approval)).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(1);
    expect(sent().to).toBe('beto@example.test');
  });
});

describe('correo de confirmación de correo', () => {
  const confirmation = {
    to: 'ana@example.test',
    memberName: 'Ana',
    businessName: 'Bazar Sol',
    confirmUrl: 'https://site.test/confirmar-correo/' + 'B'.repeat(43),
    expiresInHours: 48,
  };

  it('va al correo que se confirma, con botón, enlace de respaldo y vigencia', async () => {
    await new EmailService().sendMemberEmailConfirmationEmail(confirmation);

    expect(sent().to).toBe('ana@example.test');
    expect(sent().subject).toBe('Confirma tu correo en Bazar Sol');
    expect(sent().html).toContain('Confirmar mi correo');
    expect(sent().html).toContain(`href="${confirmation.confirmUrl}"`);
    expect(sent().text).toContain('vence en 48 horas y solo puede usarse una vez');
    expect(sent().text).toContain('Si no fuiste tú, ignora este mensaje.');
  });

  it('un rechazo de Resend sube como error y NO se reenvía al operador', async () => {
    send.mockResolvedValue(TEST_MODE_REJECTION);

    await expect(new EmailService().sendMemberEmailConfirmationEmail(confirmation)).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('aviso a los otros socios de que alguien registró su correo', () => {
  const notice = {
    to: 'beto@example.test',
    memberName: 'Beto',
    registeredName: 'Ana',
    maskedCorreo: 'a***@e***.test',
    businessName: 'Bazar Sol',
  };

  it('dice quién registró y muestra el correo enmascarado, nunca completo', async () => {
    await new EmailService().sendMemberEmailRegisteredNoticeEmail(notice);

    expect(sent().to).toBe('beto@example.test');
    expect(sent().subject).toBe('Ana registró su correo en Bazar Sol');
    expect(sent().text).toContain('a***@e***.test');
    expect(sent().html).not.toMatch(/href/i);
  });

  it('escapa los nombres en el HTML', async () => {
    await new EmailService().sendMemberEmailRegisteredNoticeEmail({ ...notice, registeredName: '<i>Ana</i>' });

    expect(sent().html).toContain('&lt;i&gt;Ana&lt;/i&gt;');
  });
});

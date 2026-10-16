import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { EmailService } from './email.service.js';

// Correos del registro de negocios v2: la verificación del correo (a quien se registra) y el
// aviso de solicitud (al aprobador, ya con el correo confirmado). Resend no se llama de verdad.
const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('resend', () => ({
  Resend: class {
    emails = { send };
  },
}));

const API_KEY = 're_test_secret_key_do_not_leak';
const VERIFY_URL = 'https://marchanta.example.test/verificar-correo?token=abc_DEF-123';

beforeEach(() => {
  vi.stubEnv('RESEND_API_KEY', API_KEY);
  vi.stubEnv('APPROVAL_NOTIFICATION_EMAIL', 'approver@example.test');
  send.mockReset();
  send.mockResolvedValue({ data: { id: 'email_1' }, error: null });
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const sent = () => send.mock.calls[0]![0] as { to: string; subject: string; html: string; text: string; from: string };

describe('correo de verificación (a quien se registra)', () => {
  const input = { correo: 'ana@example.test', nombre: 'Ana', verifyUrl: VERIFY_URL };

  it('va a la persona que se registró, desde la dirección de la marca', async () => {
    await new EmailService().sendRegistrationVerificationEmail(input);

    expect(sent().to).toBe('ana@example.test');
    expect(sent().from).toBe('notificaciones@albertogdlc.org');
  });

  it('el asunto es claro', async () => {
    await new EmailService().sendRegistrationVerificationEmail(input);

    expect(sent().subject).toBe('Confirma tu correo para La Marchanta');
  });

  it('trae el botón "Confirmar mi correo" con el enlace y el enlace en texto plano', async () => {
    await new EmailService().sendRegistrationVerificationEmail(input);
    const { html } = sent();

    expect(html).toContain('Confirmar mi correo');
    expect(html).toContain(`href="${VERIFY_URL}"`);
    // El enlace también se ve como texto, para copiarlo si el botón no funciona.
    expect(html.split(VERIFY_URL).length).toBeGreaterThanOrEqual(3);
  });

  it('dice que vence a las 48 horas y que, si no fue la persona, ignore el mensaje', async () => {
    await new EmailService().sendRegistrationVerificationEmail(input);
    const { html, text } = sent();

    for (const body of [html, text]) {
      expect(body).toContain('48 horas');
      expect(body).toContain('Si no fuiste tú, ignora este mensaje');
    }
  });

  it('incluye una versión en texto plano con el enlace', async () => {
    await new EmailService().sendRegistrationVerificationEmail(input);

    expect(sent().text).toContain(VERIFY_URL);
    expect(sent().text).toContain('Confirmar mi correo');
    expect(sent().text).not.toMatch(/<[a-z]/i);
  });

  it('usa la plantilla de marca de los demás correos', async () => {
    await new EmailService().sendRegistrationVerificationEmail(input);
    const { html } = sent();

    for (const token of ['La Marchanta', 'Gracias por confiar en nosotros', '#b8501c', 'role="presentation"', 'max-width:600px']) {
      expect(html).toContain(token);
    }
    expect(html).not.toMatch(/<(style|script|img|link)\b/i);
  });

  it('ESCAPA el nombre: un nombre con HTML no inyecta nada', async () => {
    await new EmailService().sendRegistrationVerificationEmail({
      ...input,
      nombre: '<img src=x onerror=alert(1)>"&',
    });
    const { html } = sent();

    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;&quot;&amp;');
  });

  it('ESCAPA el enlace dentro del atributo href', async () => {
    await new EmailService().sendRegistrationVerificationEmail({
      ...input,
      verifyUrl: 'https://x.test/?a=1&b="><script>1</script>',
    });

    expect(sent().html).not.toContain('"><script>');
    expect(sent().html).toContain('&amp;b=&quot;&gt;&lt;script&gt;');
  });

  it('si Resend falla lanza un error (el servicio responde 503 y no deja nada a medias)', async () => {
    send.mockResolvedValue({ data: null, error: { name: 'rate_limit_exceeded', message: 'Too many requests' } });

    await expect(new EmailService().sendRegistrationVerificationEmail(input)).rejects.toThrow(/Resend rejected the verification email/);
  });

  it('el error y los logs no llevan la clave de Resend ni el token del enlace', async () => {
    send.mockResolvedValue({ data: null, error: { name: 'x', message: 'fail' } });
    const log = vi.spyOn(Logger.prototype, 'log');
    const error = await new EmailService().sendRegistrationVerificationEmail(input).catch((e: Error) => e);

    expect(String((error as Error).message)).not.toContain(API_KEY);
    expect(String((error as Error).message)).not.toContain('abc_DEF-123');
    expect(JSON.stringify(log.mock.calls)).not.toContain('abc_DEF-123');
  });
});

describe('correo de solicitud al aprobador (ya con el correo confirmado)', () => {
  const input = {
    nombreNegocio: 'Bonsáis de Alberto',
    tipoNegocio: 'plantas_y_jardineria' as const,
    queVende: 'Bonsáis y macetas hechas a mano',
    dondeVende: 'Tianguis de Acolman',
    recomendadoPor: 'Doña Luz',
    nombre: 'Alberto',
    apellidos: 'Gómez Pérez',
    correo: 'alberto@example.test',
    telefono: '5512345678',
    emailVerifiedAt: new Date('2026-10-16T18:30:00Z'),
    approveUrl: 'https://api.example.test/api/v1/business-registration/approve?token=t1',
    rejectUrl: 'https://api.example.test/api/v1/business-registration/reject?token=t1',
  };

  it('sigue yendo al correo del aprobador (APPROVAL_NOTIFICATION_EMAIL)', async () => {
    await new EmailService().sendBusinessRegistrationApprovalEmail(input);

    expect(sent().to).toBe('approver@example.test');
    expect(sent().subject).toBe('Nueva solicitud de negocio: Bonsáis de Alberto');
  });

  it('muestra negocio, tipo con su etiqueta, qué vende, dónde vende y quién lo recomendó', async () => {
    await new EmailService().sendBusinessRegistrationApprovalEmail(input);
    const { html } = sent();

    for (const text of ['Bonsáis de Alberto', 'Plantas y jardinería', 'Bonsáis y macetas hechas a mano', 'Tianguis de Acolman', 'Doña Luz']) {
      expect(html).toContain(text);
    }
  });

  it('muestra el nombre completo y el correo "confirmado ✓" con la fecha', async () => {
    await new EmailService().sendBusinessRegistrationApprovalEmail(input);
    const { html, text } = sent();

    expect(html).toContain('Alberto Gómez Pérez');
    expect(html).toContain('alberto@example.test');
    expect(html).toContain('confirmado ✓');
    expect(html).toMatch(/16 de octubre de 2026/);
    expect(text).toContain('confirmado ✓');
  });

  it('el teléfono trae el botón "Escribirle por WhatsApp" con un enlace wa.me de 52 + 10 dígitos', async () => {
    await new EmailService().sendBusinessRegistrationApprovalEmail(input);
    const { html } = sent();

    expect(html).toContain('Escribirle por WhatsApp');
    const href = /href="(https:\/\/wa\.me\/[^"]+)"/.exec(html)![1]!.replace(/&amp;/g, '&');
    const url = new URL(href);
    expect(url.pathname).toBe('/525512345678');
    const message = url.searchParams.get('text')!;
    expect(message).toContain('Hola Alberto');
    expect(message).toContain('Bonsáis de Alberto');
    expect(message).toContain('quiero confirmar unos datos');
  });

  it('NO trae enlaces a mapas ni a redes sociales', async () => {
    await new EmailService().sendBusinessRegistrationApprovalEmail(input);
    const { html, text } = sent();

    for (const body of [html, text]) {
      expect(body).not.toMatch(/maps\.google|goo\.gl\/maps|google\.com\/maps|facebook\.com|instagram\.com|tiktok\.com|twitter\.com|x\.com/i);
    }
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => new URL(m[1]!.replace(/&amp;/g, '&')).origin);
    expect(new Set(hrefs)).toEqual(new Set(['https://wa.me', 'https://api.example.test']));
  });

  it('avisa si el teléfono o el correo ya aparecen en otra solicitud', async () => {
    await new EmailService().sendBusinessRegistrationApprovalEmail({ ...input, duplicates: { telefono: 2, correo: 1 } });
    const { html, text } = sent();

    expect(html).toContain('Este teléfono ya aparece en 2 solicitudes');
    expect(html).toContain('Este correo ya aparece en 1 solicitud');
    expect(text).toContain('Este teléfono ya aparece en 2 solicitudes');
  });

  it('sin duplicados no pone ningún aviso', async () => {
    await new EmailService().sendBusinessRegistrationApprovalEmail({ ...input, duplicates: { telefono: 0, correo: 0 } });

    expect(sent().html).not.toContain('ya aparece');
  });

  it('conserva los enlaces de aprobar y rechazar, y la nota de que vencen y son de un solo uso', async () => {
    await new EmailService().sendBusinessRegistrationApprovalEmail(input);
    const { html, text } = sent();

    expect(html).toContain(`href="${input.approveUrl}"`);
    expect(html).toContain(`href="${input.rejectUrl}"`);
    expect(html).toContain('Aprobar');
    expect(html).toContain('Rechazar');
    expect(html).toContain('solo puede usarse una vez');
    expect(text).toContain(input.approveUrl);
    expect(text).toContain(input.rejectUrl);
  });

  it('trae un texto plano alterno sin etiquetas HTML', async () => {
    await new EmailService().sendBusinessRegistrationApprovalEmail(input);

    expect(sent().text).toContain('Bonsáis de Alberto');
    expect(sent().text).toContain('https://wa.me/525512345678');
    expect(sent().text).not.toMatch(/<[a-z/]/i);
  });

  it('ESCAPA todo el texto libre en el HTML', async () => {
    const hostile = '<img src=x onerror=alert(1)>';
    await new EmailService().sendBusinessRegistrationApprovalEmail({
      ...input,
      nombreNegocio: hostile,
      queVende: hostile,
      dondeVende: hostile,
      recomendadoPor: hostile,
      nombre: hostile,
      apellidos: hostile,
    });
    const { html } = sent();

    expect(html).not.toContain('<img src=x');
    expect(html.split('&lt;img src=x onerror=alert(1)&gt;').length).toBeGreaterThanOrEqual(6);
  });

  it('el mensaje de WhatsApp con HTML o comillas no rompe el atributo href', async () => {
    await new EmailService().sendBusinessRegistrationApprovalEmail({ ...input, nombre: 'A"><b>', nombreNegocio: '"x"&y' });
    const { html } = sent();

    expect(html).not.toContain('"><b>');
    for (const [, href] of html.matchAll(/href="([^"]*)"/g)) {
      expect(href).not.toMatch(/[<>"]/);
    }
  });

  it('el asunto nunca lleva saltos de línea (no se pueden inyectar cabeceras)', async () => {
    await new EmailService().sendBusinessRegistrationApprovalEmail({ ...input, nombreNegocio: 'Tacos\r\nBcc: x@y.z' });

    expect(sent().subject).not.toMatch(/[\r\n]/);
  });

  it('un teléfono ausente no muestra botón de WhatsApp (filas antiguas)', async () => {
    await new EmailService().sendBusinessRegistrationApprovalEmail({ ...input, telefono: null });

    expect(sent().html).not.toContain('wa.me');
  });

  it('un teléfono que no son 10 dígitos (fila antigua) se muestra como texto y no arma enlace', async () => {
    await new EmailService().sendBusinessRegistrationApprovalEmail({ ...input, telefono: '555-000 ext 22' });

    expect(sent().html).toContain('555-000 ext 22');
    expect(sent().html).not.toContain('wa.me');
  });

  it('sin tipo, qué vende, dónde vende ni recomendado (fila antigua) usa guiones y no falla', async () => {
    await new EmailService().sendBusinessRegistrationApprovalEmail({
      nombreNegocio: 'Negocio viejo',
      nombre: 'Ana',
      apellidos: '',
      correo: 'ana@example.test',
      approveUrl: input.approveUrl,
      rejectUrl: input.rejectUrl,
    });

    expect(sent().html).toContain('Negocio viejo');
    expect(sent().subject).toContain('Negocio viejo');
  });
});

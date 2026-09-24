import 'dotenv/config';
import { Injectable, Logger } from '@nestjs/common';
import { Resend } from 'resend';
import { escapeHtml } from '../common/escape-html.js';

export interface BusinessRegistrationApprovalEmailInput {
  nombreNegocio: string;
  nombreSocio: string;
  contactoSocio: string;
  approveUrl: string;
  rejectUrl: string;
}

export interface BusinessCredentialsEmailInput {
  nombreNegocio: string;
  nombreSocio: string;
  /** Raw free-text contact; shown in the relay note when there is no email. */
  contactoSocio: string;
  /** Normalized socio email; when absent the email goes to the approver. */
  socioEmail?: string;
  username: string;
  temporaryPassword: string;
  deviceName: string;
  deviceIdentifier: string;
}

/**
 * Thin wrapper over the Resend SDK, scoped to the emails this project
 * sends so far (BE-11's business-registration approval request and the
 * initial credentials of an approved business).
 *
 * The API key is read lazily (inside {@link send}, not the constructor):
 * unlike JWT_SECRET (required by every request), Resend is only exercised
 * by the narrow business-registration flow, so an environment that never
 * configures it (e.g. a machine only running unrelated tests) should
 * still be able to boot the whole app; it only fails the moment an email
 * actually needs to go out.
 *
 * `onboarding@resend.dev` (Resend's own shared test sender) is used as
 * the "from" address for now, per this entrega's explicit instruction —
 * a real, domain-verified sender is a follow-up once one exists.
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private client?: Resend;

  private getClient(): Resend {
    if (this.client) return this.client;
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey)
      throw new Error('RESEND_API_KEY is required to send email');
    this.client = new Resend(apiKey);
    return this.client;
  }

  /**
   * Sends the "new business wants to register" notification to the
   * fixed approver address (`APPROVAL_NOTIFICATION_EMAIL`), with both
   * the approve and reject links already built by the caller (see
   * {@link BusinessRegistrationService}).
   */
  async sendBusinessRegistrationApprovalEmail(
    input: BusinessRegistrationApprovalEmailInput,
  ): Promise<void> {
    const to = process.env.APPROVAL_NOTIFICATION_EMAIL;
    if (!to)
      throw new Error(
        'APPROVAL_NOTIFICATION_EMAIL is required to send the approval email',
      );
    await this.deliver('approval', {
      to,
      subject: `Nueva solicitud de negocio: ${input.nombreNegocio}`,
      html: renderApprovalEmailHtml(input),
    });
  }

  /**
   * Sends the initial credentials (username, temporary password and device
   * identifier) of a freshly approved business. They go to the socio's own
   * address when the contact is an email (`socioEmail`); otherwise to the
   * approver (`APPROVAL_NOTIFICATION_EMAIL`) with a note to relay them, so
   * an approval never silently loses its credentials.
   *
   * Throws when the email cannot be sent: the caller relies on that to roll
   * the approval back. Neither the thrown message nor the logs ever contain
   * the password.
   */
  async sendBusinessCredentialsEmail(
    input: BusinessCredentialsEmailInput,
  ): Promise<void> {
    const relayThroughApprover = !input.socioEmail;
    const to = input.socioEmail ?? process.env.APPROVAL_NOTIFICATION_EMAIL;
    if (!to)
      throw new Error(
        'APPROVAL_NOTIFICATION_EMAIL is required to send credentials when the socio has no email',
      );
    await this.deliver('credentials', {
      to,
      subject: relayThroughApprover
        ? `Credenciales para reenviar al socio: ${input.nombreNegocio}`
        : `Acceso a Bazar: ${input.nombreNegocio}`,
      html: renderCredentialsEmailHtml(input, relayThroughApprover),
    });
  }

  private async deliver(
    kind: 'approval' | 'credentials',
    message: { to: string; subject: string; html: string },
  ): Promise<void> {
    // The Resend SDK does not throw on API errors (invalid key, unverified
    // domain, testing-recipient restriction, rate limit...): it resolves to
    // `{ data, error }`. Ignoring that result made a rejected email look
    // like a successful one (the endpoint answered 201, nothing was sent
    // and nothing was logged), so the error is surfaced here. The message
    // carries only Resend's error name/message, never the API key.
    const { data, error } = await this.getClient().emails.send({
      from: 'onboarding@resend.dev',
      ...message,
    });
    const label = kind === 'approval' ? 'approval' : 'credentials';
    if (error)
      throw new Error(
        `Resend rejected the ${label} email: ${error.name}: ${error.message}`,
      );
    this.logger.log(
      `${label[0].toUpperCase()}${label.slice(1)} email accepted by Resend (id ${data?.id})`,
    );
  }
}

function renderCredentialsEmailHtml(
  input: BusinessCredentialsEmailInput,
  relayThroughApprover: boolean,
): string {
  const nombreNegocio = escapeHtml(input.nombreNegocio);
  const nombreSocio = escapeHtml(input.nombreSocio);
  const contactoSocio = escapeHtml(input.contactoSocio);
  const username = escapeHtml(input.username);
  const temporaryPassword = escapeHtml(input.temporaryPassword);
  const deviceName = escapeHtml(input.deviceName);
  const deviceIdentifier = escapeHtml(input.deviceIdentifier);
  const relayNote = relayThroughApprover
    ? `<p style="background:#fff8e1;padding:12px;border-radius:4px;"><strong>Para quien aprueba:</strong> el contacto del socio (${contactoSocio}) no es un correo electrónico, por eso este mensaje llegó a ti. Debes hacer llegar al socio (${nombreSocio}) estos datos de acceso por otro medio.</p>`
    : '';
  return `<!doctype html>
<html lang="es">
  <body style="font-family: sans-serif; line-height: 1.5;">
    <h1>Tu negocio fue aprobado</h1>
    ${relayNote}
    <p>El negocio <strong>${nombreNegocio}</strong> ya está activo. Estos son los datos de acceso de ${nombreSocio}:</p>
    <p><strong>Usuario:</strong> <code>${username}</code></p>
    <p><strong>Contraseña temporal:</strong> <code>${temporaryPassword}</code></p>
    <p><strong>Dispositivo:</strong> ${deviceName}<br /><strong>Identificador del dispositivo:</strong> <code>${deviceIdentifier}</code></p>
    <p>Inicia sesión con el usuario y la contraseña temporal. Después, la aplicación necesita el identificador del dispositivo para reconocer este dispositivo: consérvalo junto con este mensaje.</p>
    <p>Es una contraseña temporal: cámbiala en cuanto la aplicación lo permita y no la compartas.</p>
  </body>
</html>`;
}

function renderApprovalEmailHtml(
  input: BusinessRegistrationApprovalEmailInput,
): string {
  const nombreNegocio = escapeHtml(input.nombreNegocio);
  const nombreSocio = escapeHtml(input.nombreSocio);
  const contactoSocio = escapeHtml(input.contactoSocio);
  return `<!doctype html>
<html lang="es">
  <body style="font-family: sans-serif; line-height: 1.5;">
    <h1>Nueva solicitud de registro de negocio</h1>
    <p><strong>Negocio:</strong> ${nombreNegocio}</p>
    <p><strong>Socio fundador:</strong> ${nombreSocio}</p>
    <p><strong>Contacto:</strong> ${contactoSocio}</p>
    <p>
      <a href="${input.approveUrl}" style="display:inline-block;padding:10px 20px;background:#2e7d32;color:#fff;text-decoration:none;border-radius:4px;margin-right:12px;">Aprobar</a>
      <a href="${input.rejectUrl}" style="display:inline-block;padding:10px 20px;background:#c62828;color:#fff;text-decoration:none;border-radius:4px;">Rechazar</a>
    </p>
    <p style="color:#666;font-size:12px;">Este enlace expira en 30 días y solo puede usarse una vez.</p>
  </body>
</html>`;
}

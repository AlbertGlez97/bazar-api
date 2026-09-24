import 'dotenv/config';
import { Injectable, Logger } from '@nestjs/common';
import { Resend } from 'resend';

export interface BusinessRegistrationApprovalEmailInput {
  nombreNegocio: string;
  nombreSocio: string;
  contactoSocio: string;
  approveUrl: string;
  rejectUrl: string;
}

/**
 * Thin wrapper over the Resend SDK, scoped to exactly the one email this
 * project sends so far (BE-11's business-registration approval request).
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
    // The Resend SDK does not throw on API errors (invalid key, unverified
    // domain, testing-recipient restriction, rate limit...): it resolves to
    // `{ data, error }`. Ignoring that result made a rejected email look
    // like a successful one (the endpoint answered 201, nothing was sent
    // and nothing was logged), so the error is surfaced here. The message
    // carries only Resend's error name/message, never the API key.
    const { data, error } = await this.getClient().emails.send({
      from: 'onboarding@resend.dev',
      to,
      subject: `Nueva solicitud de negocio: ${input.nombreNegocio}`,
      html: renderApprovalEmailHtml(input),
    });
    if (error)
      throw new Error(
        `Resend rejected the approval email: ${error.name}: ${error.message}`,
      );
    this.logger.log(`Approval email accepted by Resend (id ${data?.id})`);
  }
}

/** Escapes untrusted user-supplied text before interpolating it into HTML. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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

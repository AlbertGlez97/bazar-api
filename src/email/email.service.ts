import 'dotenv/config';
import { Injectable, Logger } from '@nestjs/common';
import { Resend } from 'resend';
import { escapeHtml } from '../common/escape-html.js';
import { fullName } from '../common/full-name.js';
import { TimeoutError, withTimeout } from '../common/with-timeout.js';

/**
 * TOTAL time the credentials email operation may take, however many Resend
 * calls it makes: the direct send to the socio plus, when Resend test mode
 * rejects that recipient, the backup forward to the approver. Both sends
 * share this ONE deadline (a single {@link withTimeout} around the whole
 * operation) instead of getting one timeout each: two sequential 8 s waits
 * would total 16 s and outlast the approve transaction.
 *
 * The installed Resend SDK (4.x) offers no abort signal or request timeout,
 * so the wait is bounded with {@link withTimeout}. The approval sends this
 * email from INSIDE its database transaction
 * (`APPROVE_TRANSACTION_OPTIONS.timeout`, 15 s in
 * BusinessRegistrationService), so this MUST stay well below it (at least a
 * 5 s margin for the queries and the Argon2 hash that run before the email):
 * the email then fails first, in a controlled way (CredentialsEmailError ->
 * rollback -> 502 retry page) instead of the transaction expiring under a
 * pending call. A unit test pins the relation.
 *
 * Trade-off: timing out stops waiting, it cannot cancel the HTTP request. The
 * email may still be delivered although the approval rolled back; the retry
 * sends a fresh, valid set of credentials (the trade-off already accepted
 * for "email sent, commit failed"). The backup forward is never STARTED after
 * the deadline has passed, so a late rejection cannot forward credentials of
 * an approval that already rolled back.
 */
export const CREDENTIALS_EMAIL_TIMEOUT_MS = 10_000;

/** Where the credentials email actually went. */
export type CredentialsDelivery =
  /** The socio's own address (the normal path). */
  | 'socio'
  /**
   * The approver, because the socio has no usable email address (a legacy
   * request created before the correo field existed): relay note.
   */
  | 'approver-no-socio-email'
  /**
   * The approver, as a backup forward, because Resend test mode refused the
   * socio's address (see {@link isResendTestModeRecipientError}).
   */
  | 'approver-fallback';

export interface CredentialsEmailResult {
  deliveredTo: CredentialsDelivery;
}

/** The error object the Resend SDK returns in `{ data, error }`. */
export interface ResendApiError {
  name: string;
  message: string;
}

const RESEND_TEST_MODE_MESSAGE =
  'You can only send testing emails to your own email address';

/**
 * True only for the rejection Resend answers while the account has no
 * verified domain (test mode), when the recipient is not the account owner:
 * `name` is `validation_error` AND the message says testing emails can only
 * go to the owner's own address. Any other name or message (including other
 * `validation_error`s such as a malformed address) is NOT this case.
 */
export function isResendTestModeRecipientError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { name, message } = error as { name?: unknown; message?: unknown };
  return (
    name === 'validation_error' &&
    typeof message === 'string' &&
    message.includes(RESEND_TEST_MODE_MESSAGE)
  );
}

/** Resend answered `{ error }` (it does not throw); keeps the raw error. */
class ResendRejectionError extends Error {
  constructor(
    label: string,
    readonly resendError: ResendApiError,
  ) {
    super(
      `Resend rejected the ${label} email: ${resendError.name}: ${resendError.message}`,
    );
  }
}

type CredentialsEmailMode = 'socio' | 'relay' | 'backup';

export interface BusinessRegistrationApprovalEmailInput {
  nombreNegocio: string;
  nombre: string;
  apellidos: string;
  correo: string;
  telefono?: string | null;
  approveUrl: string;
  rejectUrl: string;
}

export interface BusinessCredentialsEmailInput {
  nombreNegocio: string;
  nombre: string;
  /** Empty for legacy requests. */
  apellidos: string;
  /** The stored correo (empty for legacy requests); shown in the notes. */
  correo: string;
  telefono?: string | null;
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
   * address when there is one (`socioEmail`); otherwise to the
   * approver (`APPROVAL_NOTIFICATION_EMAIL`) with a note to relay them, so
   * an approval never silently loses its credentials.
   *
   * Fallback: while Resend has no verified domain it only delivers to the
   * account owner and rejects any other recipient with a specific
   * `validation_error` ({@link isResendTestModeRecipientError}). Only for
   * that exact rejection of the SOCIO's address, the same credentials are
   * forwarded to the approver as an explicit backup (subject marker and a
   * note saying who it was meant for), and the result says so. Any other
   * failure, or a failure of the backup itself, propagates.
   *
   * Direct send and backup share ONE total deadline
   * ({@link CREDENTIALS_EMAIL_TIMEOUT_MS}).
   *
   * Throws when the email cannot be sent: the caller relies on that to roll
   * the approval back. Neither the thrown message nor the logs ever contain
   * the password.
   */
  async sendBusinessCredentialsEmail(
    input: BusinessCredentialsEmailInput,
  ): Promise<CredentialsEmailResult> {
    let deadlinePassed = false;
    try {
      return await withTimeout(
        this.sendCredentials(input, () => deadlinePassed),
        CREDENTIALS_EMAIL_TIMEOUT_MS,
        'Resend credentials email',
      );
    } catch (error) {
      if (error instanceof TimeoutError) deadlinePassed = true;
      throw error;
    }
  }

  private async sendCredentials(
    input: BusinessCredentialsEmailInput,
    deadlinePassed: () => boolean,
  ): Promise<CredentialsEmailResult> {
    const approver = process.env.APPROVAL_NOTIFICATION_EMAIL;
    if (!input.socioEmail) {
      if (!approver)
        throw new Error(
          'APPROVAL_NOTIFICATION_EMAIL is required to send credentials when the socio has no email',
        );
      await this.deliver('credentials', {
        to: approver,
        subject: `Credenciales para reenviar al socio: ${input.nombreNegocio}`,
        html: renderCredentialsEmailHtml(input, 'relay'),
      });
      return { deliveredTo: 'approver-no-socio-email' };
    }

    try {
      await this.deliver('credentials', {
        to: input.socioEmail,
        subject: `Acceso a Bazar: ${input.nombreNegocio}`,
        html: renderCredentialsEmailHtml(input, 'socio'),
      });
      return { deliveredTo: 'socio' };
    } catch (error) {
      if (
        !(error instanceof ResendRejectionError) ||
        !isResendTestModeRecipientError(error.resendError)
      )
        throw error;
      // The approval may already have rolled back (deadline passed while the
      // rejection was in flight): forwarding credentials that never became
      // valid would only mislead the approver.
      if (deadlinePassed()) throw error;
      return this.forwardCredentialsToApprover(input, error, approver);
    }
  }

  /** Backup forward to the approver after Resend test mode refused the socio. */
  private async forwardCredentialsToApprover(
    input: BusinessCredentialsEmailInput,
    original: Error,
    approver: string | undefined,
  ): Promise<CredentialsEmailResult> {
    this.logger.warn(
      'Resend test mode rejected the credentials email to the socio; forwarding it to the approver as a backup',
    );
    try {
      if (!approver)
        throw new Error(
          'APPROVAL_NOTIFICATION_EMAIL is required to forward the credentials',
        );
      await this.deliver('credentials', {
        to: approver,
        subject: `[RESPALDO] Credenciales para reenviar al socio: ${input.nombreNegocio}`,
        html: renderCredentialsEmailHtml(input, 'backup'),
      });
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new Error(
        `${original.message}; the fallback to the approver also failed: ${reason}`,
      );
    }
    return { deliveredTo: 'approver-fallback' };
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
    const label = kind === 'approval' ? 'approval' : 'credentials';
    // Only the credentials email is time-bounded, as a whole (see
    // CREDENTIALS_EMAIL_TIMEOUT_MS); the approval notification keeps waiting
    // for Resend as before.
    const { data, error } = await this.getClient().emails.send({
      from: 'onboarding@resend.dev',
      ...message,
    });
    if (error) throw new ResendRejectionError(label, error);
    this.logger.log(
      `${label[0].toUpperCase()}${label.slice(1)} email accepted by Resend (id ${data?.id})`,
    );
  }
}

function renderCredentialsEmailHtml(
  input: BusinessCredentialsEmailInput,
  mode: CredentialsEmailMode,
): string {
  const nombreNegocio = escapeHtml(input.nombreNegocio);
  const nombre = escapeHtml(input.nombre);
  const nombreCompleto = escapeHtml(fullName(input.nombre, input.apellidos));
  const correo = escapeHtml(input.correo);
  const telefono = input.telefono ? escapeHtml(input.telefono) : undefined;
  const telefonoNote = telefono ? `, teléfono ${telefono}` : '';
  const username = escapeHtml(input.username);
  const temporaryPassword = escapeHtml(input.temporaryPassword);
  const deviceName = escapeHtml(input.deviceName);
  const deviceIdentifier = escapeHtml(input.deviceIdentifier);
  const relayNote =
    mode === 'relay'
      ? `<p style="background:#fff8e1;padding:12px;border-radius:4px;"><strong>Para quien aprueba:</strong> ${correo ? `el correo registrado del socio (${correo}) no se pudo usar como destinatario` : 'el socio no tiene un correo electrónico registrado'}, por eso este mensaje llegó a ti. Debes hacer llegar al socio (${nombreCompleto}${telefonoNote}) estos datos de acceso por otro medio.</p>`
      : mode === 'backup'
        ? `<p style="background:#fff8e1;padding:12px;border-radius:4px;"><strong>Reenvío de respaldo para quien aprueba:</strong> Este correo era para ${correo} (Resend en modo de prueba no permitió entregarlo); reenviarlo manualmente al socio (${nombreCompleto}${telefonoNote}) por otro medio.</p>`
        : '';
  // Only the socio reads it as a greeting; the approver gets the relay/backup
  // variants, which name the socio in the note instead.
  const greeting = mode === 'socio' ? `<p>Estimado/a ${nombre}:</p>` : '';
  const heading =
    mode === 'backup'
      ? 'Reenvío de respaldo: negocio aprobado'
      : 'Tu negocio fue aprobado';
  return `<!doctype html>
<html lang="es">
  <body style="font-family: sans-serif; line-height: 1.5;">
    <h1>${heading}</h1>
    ${greeting}
    ${relayNote}
    <p>El negocio <strong>${nombreNegocio}</strong> ya está activo. Estos son los datos de acceso de ${nombreCompleto}:</p>
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
  const nombreCompleto = escapeHtml(fullName(input.nombre, input.apellidos));
  const correo = escapeHtml(input.correo);
  const telefono = input.telefono ? escapeHtml(input.telefono) : undefined;
  return `<!doctype html>
<html lang="es">
  <body style="font-family: sans-serif; line-height: 1.5;">
    <h1>Nueva solicitud de registro de negocio</h1>
    <p><strong>Negocio:</strong> ${nombreNegocio}</p>
    <p><strong>Socio fundador:</strong> ${nombreCompleto}</p>
    <p><strong>Correo:</strong> ${correo}</p>${telefono ? `
    <p><strong>Teléfono:</strong> ${telefono}</p>` : ''}
    <p>
      <a href="${input.approveUrl}" style="display:inline-block;padding:10px 20px;background:#2e7d32;color:#fff;text-decoration:none;border-radius:4px;margin-right:12px;">Aprobar</a>
      <a href="${input.rejectUrl}" style="display:inline-block;padding:10px 20px;background:#c62828;color:#fff;text-decoration:none;border-radius:4px;">Rechazar</a>
    </p>
    <p style="color:#666;font-size:12px;">Este enlace expira en 30 días y solo puede usarse una vez.</p>
  </body>
</html>`;
}

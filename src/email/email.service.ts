import 'dotenv/config';
import { Injectable, Logger } from '@nestjs/common';
import { Resend } from 'resend';
import { escapeHtml } from '../common/escape-html.js';
import { fullName } from '../common/full-name.js';
import { TimeoutError, withTimeout } from '../common/with-timeout.js';
import {
  businessTypeLabel,
  type BusinessTypeValue,
} from '../business-registration/business-type.js';
import { whatsappUrl } from '../business-registration/phone.js';

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

export interface FinanceRulesReminderEmailInput {
  to: string;
  memberName: string;
  proposerName: string;
  businessName: string;
}

export interface AccountInvitationEmailInput {
  to: string;
  memberName: string;
  inviterName: string;
  businessName: string;
  /** Link to the public page; it carries the single-use token and nothing else. */
  inviteUrl: string;
  expiresInHours: number;
}

type EmailKind =
  | 'approval'
  | 'credentials'
  | 'activation'
  | 'member credentials'
  | 'verification'
  | 'finance rules reminder'
  | 'account invitation';

interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  /** Plain-text alternative (clients that block HTML, spam filters, accessibility). */
  text?: string;
}

/**
 * TOTAL time the registration emails (verification and approver notice) may take. Both are
 * sent from INSIDE a database transaction (15 s) so a failed send rolls everything back: this
 * must stay well below it.
 */
export const REGISTRATION_EMAIL_TIMEOUT_MS = 10_000;

export interface DeviceActivationEmailInput {
  /** Who receives the code (the `correoEnvio` a socio typed). */
  to: string;
  /** The name the person must type, exactly, together with the code. */
  deviceName: string;
  /** The one-time activation code (`Device.identifier`). */
  identifier: string;
  businessName?: string;
}

/** Where the activation code actually went. */
export interface DeviceActivationEmailResult {
  /**
   * `recipient`: the address the socio chose. `approver-fallback`: the
   * approver, as a `[RESPALDO]` copy, because Resend test mode refused it.
   */
  deliveredTo: 'recipient' | 'approver-fallback';
}

export interface MemberCredentialsEmailInput {
  /** The new member's own address (the `correo` a socio typed; not stored). */
  to: string;
  memberName: string;
  username: string;
  /** Shown only in the email body; never in the subject, the logs or errors. */
  temporaryPassword: string;
  role: 'socio' | 'colaborador';
  businessName?: string;
  /** The socio who added this person. */
  addedByName?: string;
}

/** Where the new member's credentials actually went. */
export interface MemberCredentialsEmailResult {
  /**
   * `member`: the address the socio typed. `approver-fallback`: the approver,
   * as a `[RESPALDO]` copy, because Resend test mode refused it.
   */
  deliveredTo: 'member' | 'approver-fallback';
}

export interface BusinessRegistrationApprovalEmailInput {
  nombreNegocio: string;
  /** Registration v2 fields: absent on rows that predate them. */
  tipoNegocio?: BusinessTypeValue | null;
  queVende?: string | null;
  dondeVende?: string | null;
  recomendadoPor?: string | null;
  nombre: string;
  apellidos: string;
  correo: string;
  /** 10 digits for v2 rows; free text on old ones. */
  telefono?: string | null;
  /** When the applicant confirmed the correo (v2). */
  emailVerifiedAt?: Date | null;
  /** How many OTHER requests already use this telefono / correo. */
  duplicates?: { telefono: number; correo: number };
  approveUrl: string;
  rejectUrl: string;
}

export interface RegistrationVerificationEmailInput {
  /** Where it goes: the person who is registering. */
  correo: string;
  nombre: string;
  /** Link to the FRONTEND page (/verificar-correo?token=...), never an API GET. */
  verifyUrl: string;
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
 * Sends from `notificaciones@albertogdlc.org`, now that the domain is
 * verified in Resend (DKIM/SPF records added to Cloudflare DNS) — replaces
 * the earlier placeholder, Resend's own shared test sender
 * (`onboarding@resend.dev`), which could only deliver to the account
 * owner's own verified address.
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private client?: Resend;

  private getClient(): Resend {
    if (this.client) return this.client;
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) throw new Error('RESEND_API_KEY is required to send email');
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
    await withTimeout(
      this.deliver('approval', {
        to,
        subject: `Nueva solicitud de negocio: ${input.nombreNegocio}`,
        html: renderApprovalEmailHtml(input),
        text: renderApprovalEmailText(input),
      }),
      REGISTRATION_EMAIL_TIMEOUT_MS,
      'Resend approval email',
    );
  }

  /**
   * Sends the "confirm your correo" email to the person who is registering. The link opens a
   * page of the FRONTEND with a button (the confirmation is a POST, never a GET, so mail
   * scanners that open links cannot confirm someone else's address). Throws if Resend fails:
   * the caller rolls the request back and answers 503.
   */
  async sendRegistrationVerificationEmail(
    input: RegistrationVerificationEmailInput,
  ): Promise<void> {
    await withTimeout(
      this.deliver('verification', {
        to: input.correo,
        subject: 'Confirma tu correo para La Marchanta',
        html: renderVerificationEmailHtml(input),
        text: renderVerificationEmailText(input),
      }),
      REGISTRATION_EMAIL_TIMEOUT_MS,
      'Resend verification email',
    );
  }

  /**
   * Invites an existing socio to create their own login. The email carries a
   * single-use link and NO password: the person chooses theirs on the page
   * that the link opens. Opening the link consumes nothing; only the button on
   * that page does.
   */
  async sendAccountInvitationEmail(
    input: AccountInvitationEmailInput,
  ): Promise<void> {
    const name = escapeHtml(input.memberName);
    const inviter = escapeHtml(input.inviterName);
    const business = escapeHtml(input.businessName);
    const url = escapeHtml(input.inviteUrl);
    await withTimeout(
      this.deliver('account invitation', {
        to: input.to,
        subject: `Te invitaron a crear tu cuenta en ${input.businessName}`,
        html:
          `<p>Hola, ${name}.</p>` +
          `<p>${inviter} te invitó a crear tu cuenta personal en ${business}.</p>` +
          `<p><a href="${url}">Crear mi cuenta</a></p>` +
          `<p>El enlace sirve una sola vez y dura ${input.expiresInHours} horas.</p>` +
          '<p>Tú eliges tu contraseña. No compartas este correo con nadie.</p>',
        text:
          `Hola, ${input.memberName}.\n${input.inviterName} te invitó a crear tu cuenta personal en ${input.businessName}.\n` +
          `Crea tu cuenta aquí: ${input.inviteUrl}\n` +
          `El enlace sirve una sola vez y dura ${input.expiresInHours} horas.\n` +
          'Tú eliges tu contraseña. No compartas este correo con nadie.',
      }),
      REGISTRATION_EMAIL_TIMEOUT_MS,
      'Resend account invitation email',
    );
  }

  /**
   * Tells a socio that a proposal of profit-sharing rules waits for their
   * approval. Carries no link or secret: they approve from their own session.
   */
  async sendFinanceRulesReminderEmail(
    input: FinanceRulesReminderEmailInput,
  ): Promise<void> {
    const business = escapeHtml(input.businessName);
    const name = escapeHtml(input.memberName);
    const proposer = escapeHtml(input.proposerName);
    await withTimeout(
      this.deliver('finance rules reminder', {
        to: input.to,
        subject: `Reglas de reparto por aprobar: ${input.businessName}`,
        html:
          `<p>Hola, ${name}.</p>` +
          `<p>${proposer} propuso reglas de reparto para ${business}.</p>` +
          '<p>Falta tu aprobación. Entra a Finanzas, abre el Simulador y revisa las reglas.</p>' +
          '<p>Las reglas solo valen cuando todos los socios las aprueban.</p>',
        text:
          `Hola, ${input.memberName}.\n${input.proposerName} propuso reglas de reparto para ${input.businessName}.\n` +
          'Falta tu aprobación. Entra a Finanzas, abre el Simulador y revisa las reglas.\n' +
          'Las reglas solo valen cuando todos los socios las aprueban.',
      }),
      REGISTRATION_EMAIL_TIMEOUT_MS,
      'Resend finance rules reminder email',
    );
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

    const delivery = await this.deliverWithApproverFallback({
      kind: 'credentials',
      what: 'credentials',
      recipientLabel: 'socio',
      primary: {
        to: input.socioEmail,
        subject: `Acceso a Bazar: ${input.nombreNegocio}`,
        html: renderCredentialsEmailHtml(input, 'socio'),
      },
      backup: {
        subject: `[RESPALDO] Credenciales para reenviar al socio: ${input.nombreNegocio}`,
        html: renderCredentialsEmailHtml(input, 'backup'),
      },
      deadlinePassed,
    });
    return {
      deliveredTo: delivery === 'direct' ? 'socio' : 'approver-fallback',
    };
  }

  /**
   * Sends the one-time activation code of a device to the address a socio
   * chose (`POST /devices` and `reissue` with `correoEnvio`). It carries the
   * identifier and the exact device name the person must type in the app, and
   * says the code stops working once used. It never carries a password or a
   * device token.
   *
   * Same delivery policy as {@link sendBusinessCredentialsEmail}: while Resend
   * is in test mode and refuses the recipient, the exact same code is
   * forwarded to `APPROVAL_NOTIFICATION_EMAIL` as an explicit `[RESPALDO]`
   * backup, and the result says so; any other failure propagates. Both sends
   * share ONE total deadline ({@link CREDENTIALS_EMAIL_TIMEOUT_MS}), so a
   * caller that sends from inside a database transaction must keep that
   * transaction's timeout well above it.
   */
  async sendDeviceActivationEmail(
    input: DeviceActivationEmailInput,
  ): Promise<DeviceActivationEmailResult> {
    let deadlinePassed = false;
    try {
      const delivery = await withTimeout(
        this.deliverWithApproverFallback({
          kind: 'activation',
          what: 'device activation',
          recipientLabel: 'recipient',
          primary: {
            to: input.to,
            subject: `Código para activar tu dispositivo: ${input.deviceName}`,
            html: renderDeviceActivationEmailHtml(input, 'direct'),
          },
          backup: {
            subject: `[RESPALDO] Código de activación para reenviar: ${input.deviceName}`,
            html: renderDeviceActivationEmailHtml(input, 'backup'),
          },
          deadlinePassed: () => deadlinePassed,
        }),
        CREDENTIALS_EMAIL_TIMEOUT_MS,
        'Resend device activation email',
      );
      return {
        deliveredTo: delivery === 'direct' ? 'recipient' : 'approver-fallback',
      };
    } catch (error) {
      if (error instanceof TimeoutError) deadlinePassed = true;
      throw error;
    }
  }

  /**
   * Sends the login of a person a socio just added (`POST /members`): the
   * username and a temporary password, with the reminder to change it through
   * the in-app "Cambiar mi contraseña" option. It carries no device code.
   *
   * Same delivery policy as {@link sendBusinessCredentialsEmail}: while Resend
   * is in test mode and refuses the recipient, the exact same credentials are
   * forwarded to `APPROVAL_NOTIFICATION_EMAIL` as an explicit `[RESPALDO]`
   * backup, and the result says so; any other failure propagates, and the
   * caller relies on that to roll the member creation back. Both sends share
   * ONE total deadline ({@link CREDENTIALS_EMAIL_TIMEOUT_MS}), so a caller
   * that sends from inside a database transaction must keep that
   * transaction's timeout well above it. Neither the thrown message nor the
   * logs ever contain the password.
   */
  async sendMemberCredentialsEmail(
    input: MemberCredentialsEmailInput,
  ): Promise<MemberCredentialsEmailResult> {
    let deadlinePassed = false;
    try {
      const delivery = await withTimeout(
        this.deliverWithApproverFallback({
          kind: 'member credentials',
          what: 'member credentials',
          recipientLabel: 'new member',
          primary: {
            to: input.to,
            subject: `Tu acceso a Bazar${input.businessName ? `: ${input.businessName}` : ''}`,
            html: renderMemberCredentialsEmailHtml(input, 'direct'),
          },
          backup: {
            subject: `[RESPALDO] Credenciales para reenviar a ${input.memberName}`,
            html: renderMemberCredentialsEmailHtml(input, 'backup'),
          },
          deadlinePassed: () => deadlinePassed,
        }),
        CREDENTIALS_EMAIL_TIMEOUT_MS,
        'Resend member credentials email',
      );
      return {
        deliveredTo: delivery === 'direct' ? 'member' : 'approver-fallback',
      };
    } catch (error) {
      if (error instanceof TimeoutError) deadlinePassed = true;
      throw error;
    }
  }

  /**
   * Sends `primary`; when Resend test mode refuses that recipient (and ONLY
   * for that exact rejection, {@link isResendTestModeRecipientError}) it
   * forwards the same message to the approver with the `backup` subject and
   * body. Returns which of the two sends went through.
   *
   * The backup is never started once the caller's deadline has passed: the
   * operation may already have rolled back, and forwarding something that
   * never became valid would only mislead the approver. If the backup fails
   * too, the thrown error names both failures; neither the message nor the
   * logs ever carry a secret.
   */
  private async deliverWithApproverFallback(spec: {
    kind: EmailKind;
    /** What is being sent, for the log line and the error text. */
    what: string;
    /** Who the primary recipient is, for the log line. */
    recipientLabel: string;
    primary: EmailMessage;
    backup: { subject: string; html: string };
    deadlinePassed: () => boolean;
  }): Promise<'direct' | 'approver-fallback'> {
    const approver = process.env.APPROVAL_NOTIFICATION_EMAIL;
    try {
      await this.deliver(spec.kind, spec.primary);
      return 'direct';
    } catch (error) {
      if (
        !(error instanceof ResendRejectionError) ||
        !isResendTestModeRecipientError(error.resendError)
      )
        throw error;
      // The operation may already have rolled back (deadline passed while the
      // rejection was in flight).
      if (spec.deadlinePassed()) throw error;
      this.logger.warn(
        `Resend test mode rejected the ${spec.what} email to the ${spec.recipientLabel}; forwarding it to the approver as a backup`,
      );
      try {
        if (!approver)
          throw new Error(
            `APPROVAL_NOTIFICATION_EMAIL is required to forward the ${spec.what}`,
          );
        await this.deliver(spec.kind, { to: approver, ...spec.backup });
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause);
        throw new Error(
          `${error.message}; the fallback to the approver also failed: ${reason}`,
        );
      }
      return 'approver-fallback';
    }
  }

  private async deliver(kind: EmailKind, message: EmailMessage): Promise<void> {
    // The Resend SDK does not throw on API errors (invalid key, unverified
    // domain, testing-recipient restriction, rate limit...): it resolves to
    // `{ data, error }`. Ignoring that result made a rejected email look
    // like a successful one (the endpoint answered 201, nothing was sent
    // and nothing was logged), so the error is surfaced here. The message
    // carries only Resend's error name/message, never the API key.
    const label = kind;
    // Only the credentials and activation emails are time-bounded, as a whole
    // (see CREDENTIALS_EMAIL_TIMEOUT_MS); the approval notification keeps
    // waiting for Resend as before.
    const { data, error } = await this.getClient().emails.send({
      from: 'notificaciones@albertogdlc.org',
      ...message,
      // Defence in depth against header injection: a subject is one line.
      subject: message.subject.replace(/[\r\n]+/g, ' '),
    });
    if (error) throw new ResendRejectionError(label, error);
    this.logger.log(
      `${label[0].toUpperCase()}${label.slice(1)} email accepted by Resend (id ${data?.id})`,
    );
  }
}

// Email clients cannot rely on CSS variables or downloaded fonts. These
// inline values match frontend/src/assets/main.css and its brand guidelines.
const businessEmailColors = {
  paper: '#faf4e8',
  surface: '#fffdf9',
  text: '#2b1d14',
  muted: '#6a5443',
  border: '#e3d5bc',
  terracotta: '#b8501c',
  maize: '#f0b429',
  nopal: '#2f6b3f',
};
const businessEmailDisplayFont =
  "'Bricolage Grotesque', 'Trebuchet MS', 'Segoe UI', Arial, sans-serif";
const businessEmailBodyFont = "'Figtree', 'Segoe UI', Arial, sans-serif";

function renderBusinessEmailShell(heading: string, content: string): string {
  const c = businessEmailColors;
  return `<!doctype html>
<html lang="es">
  <head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /></head>
  <body style="margin:0;padding:0;background:${c.paper};color:${c.text};font-family:${businessEmailBodyFont};font-size:16px;line-height:1.6;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${c.paper};border-collapse:collapse;">
      <tr><td align="center" style="padding:24px 12px;">
        <!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:${c.surface};border:1px solid ${c.border};border-collapse:collapse;">
          <tr><td style="padding:24px;border-top:8px solid ${c.maize};border-bottom:1px solid ${c.border};font-family:${businessEmailDisplayFont};font-size:28px;font-weight:800;color:${c.terracotta};">La Marchanta</td></tr>
          <tr><td style="padding:24px;word-wrap:break-word;overflow-wrap:anywhere;">
            <h1 style="margin:0 0 20px;font-family:${businessEmailDisplayFont};font-size:26px;line-height:1.3;color:${c.nopal};">${heading}</h1>
            ${content}
          </td></tr>
          <tr><td style="padding:20px 24px;border-top:1px solid ${c.border};color:${c.muted};font-size:14px;">Gracias por confiar en nosotros.<br />De tu lado del mostrador, La Marchanta.</td></tr>
        </table>
        <!--[if mso]></td></tr></table><![endif]-->
      </td></tr>
    </table>
  </body>
</html>`;
}

function renderBusinessEmailCard(heading: string, content: string): string {
  const c = businessEmailColors;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="table-layout:fixed;border-collapse:collapse;background:${c.paper};border:1px solid ${c.border};">
    <tr><td style="padding:20px;word-wrap:break-word;overflow-wrap:anywhere;"><h2 style="margin:0 0 16px;font-family:${businessEmailDisplayFont};font-size:20px;">${heading}</h2>${content}</td></tr>
  </table>`;
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
      ? `<p style="background:${businessEmailColors.maize};color:${businessEmailColors.text};padding:16px;border:1px solid ${businessEmailColors.border};"><strong>Para quien aprueba:</strong> ${correo ? `el correo registrado del socio (${correo}) no se pudo usar como destinatario` : 'el socio no tiene un correo electrónico registrado'}, por eso este mensaje llegó a ti. Debes hacer llegar al socio (${nombreCompleto}${telefonoNote}) estos datos de acceso por otro medio.</p>`
      : mode === 'backup'
        ? `<p style="background:${businessEmailColors.maize};color:${businessEmailColors.text};padding:16px;border:1px solid ${businessEmailColors.border};"><strong>Reenvío de respaldo para quien aprueba:</strong> Este correo era para ${correo} (Resend en modo de prueba no permitió entregarlo); reenviarlo manualmente al socio (${nombreCompleto}${telefonoNote}) por otro medio.</p>`
        : '';
  // Welcome the socio directly; the approver variants address the approver
  // and name the socio only in the forwarding instructions.
  const greeting =
    mode === 'socio'
      ? `<p>Hola, ${nombre}. ¡Qué gusto darte la bienvenida a La Marchanta!</p>`
      : '<p>Hola. Gracias por ayudar a que este negocio dé su siguiente paso.</p>';
  const heading =
    mode === 'backup'
      ? 'Reenvío de respaldo: negocio aprobado'
      : 'Tu negocio fue aprobado';
  return renderBusinessEmailShell(
    heading,
    `
    ${greeting}
    ${relayNote}
    <p>El negocio <strong>${nombreNegocio}</strong> ya está activo. Estos son los datos de acceso de ${nombreCompleto}:</p>
    ${renderBusinessEmailCard(
      'Datos de acceso',
      `
    <p><strong>Usuario:</strong> <code>${username}</code></p>
    <p><strong>Contraseña temporal:</strong> <code>${temporaryPassword}</code></p>
    <p><strong>Dispositivo:</strong> ${deviceName}<br /><strong>Identificador del dispositivo:</strong> <code>${deviceIdentifier}</code></p>`,
    )}
    <p>Inicia sesión con el usuario y la contraseña temporal. Después, la aplicación necesita el identificador del dispositivo para reconocer este dispositivo: consérvalo junto con este mensaje.</p>
    <p>Es una contraseña temporal: cámbiala en cuanto la aplicación lo permita y no la compartas.</p>
  `,
  );
}

function renderDeviceActivationEmailHtml(
  input: DeviceActivationEmailInput,
  mode: 'direct' | 'backup',
): string {
  const deviceName = escapeHtml(input.deviceName);
  const identifier = escapeHtml(input.identifier);
  const businessNote = input.businessName
    ? ` del negocio <strong>${escapeHtml(input.businessName)}</strong>`
    : '';
  const backupNote =
    mode === 'backup'
      ? `<p style="background:#fff8e1;padding:12px;border-radius:4px;"><strong>Reenvío de respaldo para quien administra:</strong> Este correo era para ${escapeHtml(input.to)} (Resend en modo de prueba no permitió entregarlo); reenviarlo manualmente a la persona que usará el dispositivo por otro medio.</p>`
      : '';
  const heading =
    mode === 'backup'
      ? 'Reenvío de respaldo: código de activación de un dispositivo'
      : 'Activa tu dispositivo';
  return `<!doctype html>
<html lang="es">
  <body style="font-family: sans-serif; line-height: 1.5;">
    <h1>${heading}</h1>
    ${backupNote}
    <p>Se registró el dispositivo <strong>${deviceName}</strong>${businessNote}. Para activarlo, escribe en la aplicación este código y el nombre exacto del dispositivo:</p>
    <p><strong>Código de activación:</strong> <code>${identifier}</code></p>
    <p><strong>Nombre del dispositivo:</strong> <code>${deviceName}</code></p>
    <p>Es un código de un solo uso: deja de funcionar en cuanto se usa. Si lo pierdes o ya se usó, pide a un socio que te genere uno nuevo.</p>
  </body>
</html>`;
}

function renderMemberCredentialsEmailHtml(
  input: MemberCredentialsEmailInput,
  mode: 'direct' | 'backup',
): string {
  const memberName = escapeHtml(input.memberName);
  const username = escapeHtml(input.username);
  const temporaryPassword = escapeHtml(input.temporaryPassword);
  const role = escapeHtml(input.role);
  const businessNote = input.businessName
    ? ` del negocio <strong>${escapeHtml(input.businessName)}</strong>`
    : '';
  const addedByNote = input.addedByName
    ? `<p>Te agregó ${escapeHtml(input.addedByName)}.</p>`
    : '';
  const backupNote =
    mode === 'backup'
      ? `<p style="background:#fff8e1;padding:12px;border-radius:4px;"><strong>Reenvío de respaldo para quien administra:</strong> Este correo era para ${escapeHtml(input.to)} (Resend en modo de prueba no permitió entregarlo); reenviarlo manualmente a ${memberName} por otro medio.</p>`
      : '';
  const heading =
    mode === 'backup'
      ? 'Reenvío de respaldo: acceso de una persona nueva'
      : 'Ya tienes acceso a Bazar';
  return `<!doctype html>
<html lang="es">
  <body style="font-family: sans-serif; line-height: 1.5;">
    <h1>${heading}</h1>
    ${backupNote}
    <p>Hola ${memberName}: ya puedes usar Bazar${businessNote} como <strong>${role}</strong>.</p>
    ${addedByNote}
    <p><strong>Usuario:</strong> <code>${username}</code></p>
    <p><strong>Contraseña temporal:</strong> <code>${temporaryPassword}</code></p>
    <p>Inicia sesión con el usuario y la contraseña temporal. Es una contraseña temporal: cámbiala lo antes posible con la opción <strong>Cambiar mi contraseña</strong> de la aplicación y no la compartas.</p>
  </body>
</html>`;
}

const businessEmailButton = (href: string, label: string, color: string) =>
  `<a href="${escapeHtml(href)}" style="display:inline-block;padding:12px 20px;background:${color};color:#ffffff;text-decoration:none;border-radius:6px;margin:0 12px 12px 0;">${escapeHtml(label)}</a>`;

/** Mexico City date and time, in Spanish: "16 de octubre de 2026, 12:30". */
function formatMexicoDateTime(date: Date): string {
  return new Intl.DateTimeFormat('es-MX', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: 'America/Mexico_City',
  }).format(date);
}

const pluralRequests = (count: number) =>
  count === 1 ? '1 solicitud' : `${count} solicitudes`;

/** "5512345678" only when it is a normalized 10-digit phone (rows that predate v2 hold free text). */
const isNormalizedPhone = (telefono: string) => /^[2-9]\d{9}$/.test(telefono);

function renderVerificationEmailHtml(
  input: RegistrationVerificationEmailInput,
): string {
  const url = escapeHtml(input.verifyUrl);
  return renderBusinessEmailShell(
    'Confirma tu correo',
    `
    <p>Hola, ${escapeHtml(input.nombre)}. Gracias por querer sumarte a La Marchanta.</p>
    <p>Para seguir con tu solicitud, confirma que este correo es tuyo.</p>
    <p>${businessEmailButton(input.verifyUrl, 'Confirmar mi correo', businessEmailColors.terracotta)}</p>
    <p style="color:${businessEmailColors.muted};font-size:14px;">Si el botón no funciona, copia este enlace en tu navegador:<br />${url}</p>
    <p style="color:${businessEmailColors.muted};font-size:14px;">El enlace vence en 48 horas y solo puede usarse una vez.</p>
    <p style="color:${businessEmailColors.muted};font-size:14px;">Si no fuiste tú, ignora este mensaje. No pasará nada.</p>
  `,
  );
}

function renderVerificationEmailText(
  input: RegistrationVerificationEmailInput,
): string {
  return [
    `Hola, ${input.nombre}. Gracias por querer sumarte a La Marchanta.`,
    '',
    'Para seguir con tu solicitud, confirma que este correo es tuyo.',
    'Confirmar mi correo:',
    input.verifyUrl,
    '',
    'El enlace vence en 48 horas y solo puede usarse una vez.',
    'Si no fuiste tú, ignora este mensaje. No pasará nada.',
    '',
    'De tu lado del mostrador, La Marchanta.',
  ].join('\n');
}

function approvalFacts(input: BusinessRegistrationApprovalEmailInput) {
  const nombreCompleto = fullName(input.nombre, input.apellidos);
  const telefono = input.telefono?.trim() || undefined;
  const whatsapp =
    telefono && isNormalizedPhone(telefono)
      ? whatsappUrl(telefono, input.nombre, input.nombreNegocio)
      : undefined;
  const verifiedLine = input.emailVerifiedAt
    ? `confirmado ✓ (${formatMexicoDateTime(input.emailVerifiedAt)})`
    : undefined;
  const warnings: string[] = [];
  if (input.duplicates?.telefono)
    warnings.push(
      `Este teléfono ya aparece en ${pluralRequests(input.duplicates.telefono)} más.`,
    );
  if (input.duplicates?.correo)
    warnings.push(
      `Este correo ya aparece en ${pluralRequests(input.duplicates.correo)} más.`,
    );
  return { nombreCompleto, telefono, whatsapp, verifiedLine, warnings };
}

function renderApprovalEmailHtml(
  input: BusinessRegistrationApprovalEmailInput,
): string {
  const { nombreCompleto, telefono, whatsapp, verifiedLine, warnings } =
    approvalFacts(input);
  const row = (label: string, value: string | null | undefined) =>
    value ? `\n    <p><strong>${label}:</strong> ${escapeHtml(value)}</p>` : '';
  const tipo = input.tipoNegocio ? businessTypeLabel(input.tipoNegocio) : undefined;
  return renderBusinessEmailShell(
    'Nueva solicitud de registro de negocio',
    `
    <p>Hola. Un nuevo negocio quiere sumarse a La Marchanta. Estos son sus datos para que puedas revisar la solicitud:</p>${
      warnings.length
        ? `
    <p style="padding:12px;background:#fbebc0;border:1px solid ${businessEmailColors.maize};">${warnings
      .map((warning) => `⚠ ${escapeHtml(warning)}`)
      .join('<br />')}</p>`
        : ''
    }
    ${renderBusinessEmailCard(
      'Datos del negocio',
      `${row('Negocio', input.nombreNegocio)}${row('Tipo', tipo)}${row('Qué vende', input.queVende)}${row('Dónde vende', input.dondeVende)}${row('Lo recomendó', input.recomendadoPor)}`,
    )}
    ${renderBusinessEmailCard(
      'Datos de contacto',
      `${row('Socio fundador', nombreCompleto)}
    <p><strong>Correo:</strong> ${escapeHtml(input.correo)}${verifiedLine ? ` — ${escapeHtml(verifiedLine)}` : ''}</p>${
      telefono
        ? `
    <p><strong>Teléfono (WhatsApp):</strong> ${escapeHtml(telefono)}</p>${
      whatsapp
        ? `
    <p>${businessEmailButton(whatsapp, 'Escribirle por WhatsApp', businessEmailColors.nopal)}</p>`
        : ''
    }`
        : ''
    }`,
    )}
    <p>
      ${businessEmailButton(input.approveUrl, 'Aprobar', businessEmailColors.terracotta)}
      ${businessEmailButton(input.rejectUrl, 'Rechazar', '#b3261e')}
    </p>
    <p style="color:${businessEmailColors.muted};font-size:14px;">Este enlace expira en 30 días y solo puede usarse una vez.</p>
  `,
  );
}

function renderApprovalEmailText(
  input: BusinessRegistrationApprovalEmailInput,
): string {
  const { nombreCompleto, telefono, whatsapp, verifiedLine, warnings } =
    approvalFacts(input);
  const lines = [
    'Nueva solicitud de registro de negocio',
    '',
    ...warnings.map((warning) => `AVISO: ${warning}`),
    ...(warnings.length ? [''] : []),
    `Negocio: ${input.nombreNegocio}`,
    ...(input.tipoNegocio ? [`Tipo: ${businessTypeLabel(input.tipoNegocio)}`] : []),
    ...(input.queVende ? [`Qué vende: ${input.queVende}`] : []),
    ...(input.dondeVende ? [`Dónde vende: ${input.dondeVende}`] : []),
    ...(input.recomendadoPor ? [`Lo recomendó: ${input.recomendadoPor}`] : []),
    '',
    `Socio fundador: ${nombreCompleto}`,
    `Correo: ${input.correo}${verifiedLine ? ` — ${verifiedLine}` : ''}`,
    ...(telefono ? [`Teléfono (WhatsApp): ${telefono}`] : []),
    ...(whatsapp ? [`Escribirle por WhatsApp: ${whatsapp}`] : []),
    '',
    `Aprobar: ${input.approveUrl}`,
    `Rechazar: ${input.rejectUrl}`,
    '',
    'Este enlace expira en 30 días y solo puede usarse una vez.',
  ];
  return lines.join('\n');
}

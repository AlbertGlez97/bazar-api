import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import {
  EmailService,
  type CredentialsEmailResult,
} from '../email/email.service.js';
import { createServerId } from '../common/server-id.js';
import { fullName } from '../common/full-name.js';
import { hashPassword } from '../common/password.js';
import {
  isAccountUsernameConflict,
  isTransactionExpired,
} from './approve-failures.js';
import { CreateBusinessRegistrationDto } from './dto/create-business-registration.dto.js';
import {
  INITIAL_DEVICE_NAME,
  deriveUniqueUsername,
  generateTemporaryPassword,
  normalizeSocioEmail,
} from './initial-credentials.js';
import { renderStatusPage } from './status-page.html.js';

const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Approve sends the credentials email from INSIDE its transaction (so a
// failed send rolls the whole approval back). Prisma's default interactive
// transaction timeout is 5s, which a slow Resend call could exceed and turn
// into a spurious rollback, so approve opens its transaction with a larger
// explicit budget. The tenant-isolation `$transaction` override forwards
// these options untouched (see test/tenant-extension.e2e-spec.ts).
// `timeout` must stay well above CREDENTIALS_EMAIL_TIMEOUT_MS (EmailService),
// the TOTAL deadline of the credentials email including the approver
// fallback (two sends share it), so a hung Resend call fails first, in a
// controlled way; a unit test pins it.
export const APPROVE_TRANSACTION_OPTIONS = { maxWait: 5_000, timeout: 15_000 };

/** The credentials email could not be sent; the approval was rolled back. */
class CredentialsEmailError extends Error {}

/** How a failed (rolled back) approval is reported to the approver. */
interface RetryableApproveFailure {
  /** Server log line: never contains the password or raw driver output. */
  log: string;
  title: string;
  message: string;
}

const RETRY_HINT =
  'La aprobación no se completó y la solicitud sigue pendiente. Vuelve a abrir este mismo enlace para reintentarlo.';

/**
 * The approve failures that leave the request "pendiente" (the transaction
 * rolled back) and that a retry with the same link can fix, so they get the
 * HTML 502 retry page instead of a JSON 500. Anything else is not
 * recognized (returns `undefined`) and must be rethrown by the caller.
 */
function retryableApproveFailure(
  error: unknown,
): RetryableApproveFailure | undefined {
  if (error instanceof CredentialsEmailError)
    return {
      // Message only (Resend's error name/message or the timeout): no secrets.
      log: error.message,
      title: 'No se pudo enviar el correo de credenciales',
      message: RETRY_HINT,
    };
  if (isTransactionExpired(error))
    return {
      log: 'Approval rolled back: the database transaction expired before it could commit.',
      title: 'La aprobación tardó demasiado',
      message: `Se agotó el tiempo de la operación. ${RETRY_HINT}`,
    };
  if (isAccountUsernameConflict(error))
    return {
      log: 'Approval rolled back: the derived username was taken by a concurrent approval.',
      title: 'No se pudo crear el usuario',
      message: `Otro registro tomó el mismo nombre de usuario al mismo tiempo. ${RETRY_HINT}`,
    };
  return undefined;
}

function alreadyProcessedPage(): string {
  return renderStatusPage(
    'Ya fue procesado',
    'Esta solicitud ya fue resuelta anteriormente; este enlace ya no tiene efecto.',
  );
}

/** The request fields the approve/reject callbacks need. */
interface PendingRequest {
  id: string;
  nombreNegocio: string;
  nombre: string;
  /** Empty for legacy requests. */
  apellidos: string;
  /** Empty for legacy requests whose old contact was not an email. */
  correo: string;
  telefono: string | null;
}

/** HTTP status + rendered HTML body for one of the approve/reject outcomes. */
export interface HtmlPageResult {
  statusCode: number;
  html: string;
}

function hashToken(token: string): string {
  // sha256, not argon2/bcrypt: this hash must be looked up directly by
  // equality in a WHERE clause (there is no "candidate account" to check
  // it against, unlike a login password) — a deterministic digest is the
  // correct primitive here, and the token's own 256 bits of entropy
  // (crypto.randomBytes(32)) is what actually protects it, not slow
  // hashing (which exists to blunt brute-forcing a low-entropy human
  // password, a concern this random token does not have).
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Server origin used to build the email links. The `/api/v1` global prefix
 * is appended by the caller, so an `APP_BASE_URL` that already ends in it
 * (in any letter case, with or without trailing slashes) is normalized to
 * avoid `/api/v1/api/v1/...`. A query string or fragment is dropped too:
 * appended after it, the path would end up inside the query and the link
 * would point at the wrong place.
 */
function baseUrl(): string {
  return (
    process.env.APP_BASE_URL?.trim() ||
    `http://localhost:${process.env.PORT ?? 3000}`
  )
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '')
    .replace(/\/api\/v1$/i, '')
    .replace(/\/+$/, '');
}

/**
 * BE-11 Part 2: public registration of a brand-new business/tenant,
 * gated by manual email approval (Resend) rather than instant
 * self-service — a business only becomes operational (gets a real
 * contextId, a founding socio Member, a login Account and an authorized
 * Device) once a human clicks "approve" on the notification email.
 *
 * Runs with no tenant/contextId in scope by design: at creation time
 * there is no contextId yet at all, and the approve/reject endpoints are
 * public (no Account, so no AuthGuard, so nothing populates the
 * AsyncLocalStorage tenant context — see src/database/tenant-context.ts).
 * The writes that need a contextId (the founding Member and the Device,
 * created on approval) pass it explicitly in their own `data`, which the
 * tenant-isolation extension treats as the source of truth when no
 * request-scoped contextId is active — this is the documented
 * "bootstrapping a brand-new tenant from a public endpoint" escape
 * hatch for the application layer. The database layer needs the same
 * thing: Postgres RLS denies every write to a tenant table unless the
 * session variable `app.context_id` matches the row, so `approve` sets
 * it (transaction-local) to the brand-new contextId before creating the
 * Member and Device (Account has no RLS: login needs it before any
 * context is known). Without that, the INSERT is rejected with SQLSTATE 42501 —
 * invisible while the app connected as a superuser, which bypasses RLS.
 */
@Injectable()
export class BusinessRegistrationService {
  private readonly logger = new Logger(BusinessRegistrationService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(EmailService) private readonly email: EmailService,
  ) {}

  /**
   * Creates the pending request and emails the approver. The raw token
   * is only ever held in memory here and inside the email sent to
   * `APPROVAL_NOTIFICATION_EMAIL` — only its sha256 hash is persisted.
   */
  async create(dto: CreateBusinessRegistrationDto) {
    const token = randomBytes(32).toString('base64url');
    const approvalTokenHash = hashToken(token);
    const tokenExpiresAt = new Date(Date.now() + TOKEN_TTL_MS);

    // The DTO already trimmed it and checked its syntax; lower-casing gives
    // the stored value (and the future username) a canonical form.
    const correo = dto.correo.trim().toLowerCase();
    const telefono = dto.telefono ?? null;

    const created = await this.prisma.businessRegistrationRequest.create({
      data: {
        id: createServerId(),
        nombreNegocio: dto.nombreNegocio,
        nombre: dto.nombre,
        apellidos: dto.apellidos,
        correo,
        telefono,
        approvalTokenHash,
        tokenExpiresAt,
      },
    });

    const approveUrl = `${baseUrl()}/api/v1/business-registration/approve?token=${token}`;
    const rejectUrl = `${baseUrl()}/api/v1/business-registration/reject?token=${token}`;
    await this.email.sendBusinessRegistrationApprovalEmail({
      nombreNegocio: dto.nombreNegocio,
      nombre: dto.nombre,
      apellidos: dto.apellidos,
      correo,
      telefono,
      approveUrl,
      rejectUrl,
    });

    return {
      id: created.id,
      status: created.status,
      createdAt: created.createdAt,
    };
  }

  /**
   * Approves a pending, unexpired request. In ONE transaction it creates
   * the real contextId with everything a new business needs to be usable:
   * the founding socio Member, the socio's login Account (Argon2id-hashed
   * temporary password), one authorized "Dispositivo principal" Device, and
   * marks the request "aprobado". The credentials email is the LAST step
   * inside that transaction: if it cannot be sent (Resend error or the
   * EmailService timeout), everything rolls back, the request stays
   * "pendiente" and the page (HTTP 502) tells the approver the same link can
   * be used to retry. The same 502 page answers the two other rolled-back,
   * retryable failures: the transaction expiring, and a concurrent approval
   * taking the same username first (unique constraint on Account.username;
   * the retry derives a fresh one). Any other error is rethrown. Trade-off:
   * if the email is sent (or merely timed out, with the request still on the
   * wire) and the approval then rolls back or fails to commit, the recipient
   * holds credentials that never became valid, and the retry sends a fresh,
   * valid set.
   *
   * Returns an HTML confirmation page in every case (see the module doc
   * comment on {@link renderStatusPage}), never a JSON error. The password
   * is never rendered, logged or stored in plaintext.
   */
  async approve(token: string): Promise<HtmlPageResult> {
    try {
      return await this.resolve(
        token,
        (tx, request) => this.approveInTransaction(tx, request),
        APPROVE_TRANSACTION_OPTIONS,
      );
    } catch (error) {
      const failure = retryableApproveFailure(error);
      if (!failure) throw error;
      // Everything rolled back and the request is still "pendiente".
      this.logger.error(failure.log);
      return {
        statusCode: 502,
        html: renderStatusPage(failure.title, failure.message),
      };
    }
  }

  private async approveInTransaction(
    tx: Prisma.TransactionClient,
    request: PendingRequest,
  ): Promise<string> {
    const contextId = createServerId();
    await tx.$executeRaw`SELECT set_config('app.context_id', ${contextId}, true)`;
    // Claim the request first. The row lock makes a concurrent approval of
    // the same link wait for this transaction and then match nothing, so
    // credentials are never created (or emailed) twice.
    const claimed = await tx.businessRegistrationRequest.updateMany({
      where: { id: request.id, status: 'pendiente' },
      data: {
        status: 'aprobado',
        resolvedAt: new Date(),
        createdContextId: contextId,
      },
    });
    if (claimed.count === 0) return alreadyProcessedPage();

    const socioEmail = normalizeSocioEmail(request.correo);
    const username = await deriveUniqueUsername(request, async (candidate) => {
      const existing = await tx.account.findUnique({
        where: { username: candidate },
        select: { id: true },
      });
      return existing !== null;
    });
    const temporaryPassword = generateTemporaryPassword();
    const deviceIdentifier = randomUUID();

    await tx.member.create({
      data: {
        id: createServerId(),
        name: fullName(request.nombre, request.apellidos),
        role: 'socio',
        contextId,
        active: true,
      },
    });
    await tx.device.create({
      data: {
        id: createServerId(),
        name: INITIAL_DEVICE_NAME,
        identifier: deviceIdentifier,
        contextId,
        authorized: true,
      },
    });
    // Same Argon2id setup as AuthService/seed; only the hash is stored.
    await tx.account.create({
      data: {
        id: createServerId(),
        username,
        passwordHash: await hashPassword(temporaryPassword),
        contextId,
      },
    });

    let delivery: CredentialsEmailResult;
    try {
      delivery = await this.email.sendBusinessCredentialsEmail({
        nombreNegocio: request.nombreNegocio,
        nombre: request.nombre,
        apellidos: request.apellidos,
        correo: request.correo,
        telefono: request.telefono,
        socioEmail,
        username,
        temporaryPassword,
        deviceName: INITIAL_DEVICE_NAME,
        deviceIdentifier,
      });
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new CredentialsEmailError(
        `Credentials email for registration request ${request.id} failed; approval rolled back: ${reason}`,
      );
    }

    // The page must say where the credentials REALLY went (never the
    // password itself).
    switch (delivery.deliveredTo) {
      case 'socio':
        return renderStatusPage(
          'Negocio aprobado',
          `El negocio "${request.nombreNegocio}" fue aprobado. Las credenciales de acceso (usuario, contraseña temporal e identificador del dispositivo) se enviaron por correo a ${socioEmail}.`,
        );
      case 'approver-fallback':
        return renderStatusPage(
          'Negocio aprobado',
          `El negocio "${request.nombreNegocio}" fue aprobado. Resend (en modo de prueba) no permitió enviar las credenciales de acceso a ${socioEmail}, así que se enviaron al correo del aprobador como reenvío de respaldo: hazlas llegar al socio.`,
        );
      case 'approver-no-socio-email':
        return renderStatusPage(
          'Negocio aprobado',
          `El negocio "${request.nombreNegocio}" fue aprobado. El socio (${fullName(request.nombre, request.apellidos)}) no tiene un correo electrónico utilizable, así que las credenciales de acceso se enviaron al correo del aprobador: hazlas llegar al socio${request.telefono ? ` (teléfono: ${request.telefono})` : ''}.`,
        );
    }
  }

  /**
   * Rejects a pending, unexpired request: marks it "rechazado" and
   * creates nothing operative (no contextId, no Member).
   */
  async reject(token: string): Promise<HtmlPageResult> {
    return this.resolve(token, async (tx, request) => {
      await tx.businessRegistrationRequest.update({
        where: { id: request.id },
        data: { status: 'rechazado', resolvedAt: new Date() },
      });
      return renderStatusPage(
        'Solicitud rechazada',
        `La solicitud de "${request.nombreNegocio}" fue rechazada. No se creó nada.`,
      );
    });
  }

  /**
   * Shared validation for approve/reject: looks the request up by the
   * token's hash, and renders the appropriate "invalid" / "already
   * processed" / "expired" page instead of running `onValid` whenever
   * the token cannot be honored. `onValid` runs inside the same
   * transaction as the final status update, so a crash partway through
   * (e.g. the Member create failing) leaves the request exactly as
   * "pendiente" as it was before this call, not half-approved.
   */
  private async resolve(
    token: string,
    onValid: (
      tx: Prisma.TransactionClient,
      request: PendingRequest,
    ) => Promise<string>,
    transactionOptions?: { maxWait?: number; timeout?: number },
  ): Promise<HtmlPageResult> {
    const approvalTokenHash = hashToken(token);
    const request = await this.prisma.businessRegistrationRequest.findFirst({
      where: { approvalTokenHash },
    });
    if (!request) {
      return {
        statusCode: 404,
        html: renderStatusPage(
          'Enlace inválido',
          'Este enlace no corresponde a ninguna solicitud.',
        ),
      };
    }
    if (request.status !== 'pendiente') {
      return { statusCode: 200, html: alreadyProcessedPage() };
    }
    if (request.tokenExpiresAt.getTime() < Date.now()) {
      return {
        statusCode: 200,
        html: renderStatusPage(
          'El enlace expiró',
          'Este enlace de aprobación/rechazo ya expiró (30 días). Solicita el registro de nuevo si sigue vigente el interés.',
        ),
      };
    }
    const html = await this.prisma.$transaction(
      (tx) => onValid(tx, request),
      transactionOptions,
    );
    return { statusCode: 200, html };
  }
}

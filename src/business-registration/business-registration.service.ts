import { randomBytes, randomUUID, createHash } from 'node:crypto';
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
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
import { maskEmail } from '../common/text-sanitize.js';
import { RegistrationCleanupService } from './registration-cleanup.service.js';
import { REGISTRATION_RULES, RegistrationLimits } from './registration-limits.js';
import { TurnstileService } from './turnstile.service.js';

// The registration steps send an email from INSIDE their transaction (a failed send rolls
// everything back). Same budget as the approval, well above the 10 s email deadline.
const REGISTRATION_TRANSACTION_OPTIONS = { maxWait: 5_000, timeout: 15_000 };

/** The verification or approver email could not be sent; the step was rolled back. */
class RegistrationEmailError extends Error {}

/** Prisma unique-constraint violation (the live-correo index): another submission won the race. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

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
export function apiBaseUrl(): string {
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
    @Inject(TurnstileService) private readonly turnstile: TurnstileService,
    @Inject(RegistrationLimits) private readonly limits: RegistrationLimits,
    @Inject(RegistrationCleanupService)
    private readonly cleanup: RegistrationCleanupService,
  ) {}

  /**
   * Public registration (v2). ALWAYS answers the same thing for a well-formed request, so
   * nobody can learn whether a correo already has a request. In order:
   *   1. honeypot filled -> pretend it worked, create nothing;
   *   2. Cloudflare Turnstile (server side, one-use token): 400 invalid / 503 unavailable;
   *   3. a new correo -> create the request as "pendiente_correo" and email the verification
   *      link (48 h, one use, only the sha256 hash is stored); an existing "pendiente_correo"
   *      one -> resend the link under the resend rules; anything else -> do nothing.
   * The approver is NOT told anything until the applicant confirms the correo
   * ({@link verifyEmail}). If Resend fails the whole operation rolls back (503, no half rows).
   */
  async create(dto: CreateBusinessRegistrationDto, ip: string): Promise<void> {
    if (dto.sitioWebEmpresa && dto.sitioWebEmpresa.trim() !== '') {
      this.logger.warn('Registration ignored: the honeypot field was filled.');
      return;
    }
    const verdict = await this.turnstile.verify(dto.turnstileToken, ip);
    if (verdict === 'invalid')
      throw new BadRequestException({
        statusCode: 400,
        code: 'turnstile_invalid',
        message: 'No pudimos comprobar que eres una persona. Intenta de nuevo.',
      });
    if (verdict === 'unavailable')
      throw new ServiceUnavailableException({
        statusCode: 503,
        code: 'turnstile_unavailable',
        message: 'No pudimos comprobar tu solicitud en este momento. Intenta de nuevo en unos minutos.',
      });

    const correo = dto.correo.trim().toLowerCase();
    const siteUrl = this.publicSiteUrl();
    // Fire and forget: housekeeping must never slow down or fail a registration.
    void this.cleanup.runBatch().catch(() => undefined);

    try {
      await this.prisma.$transaction(
        async (tx) => {
          const existing = await this.findLiveRequest(tx, correo);
          if (existing) {
            await this.resendVerification(tx, existing, siteUrl);
            return;
          }
          await this.createRequest(tx, dto, correo, siteUrl);
        },
        REGISTRATION_TRANSACTION_OPTIONS,
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        // Another submission for the same correo won the race: treat this one as a resend.
        await this.resendByCorreo(correo, siteUrl);
        return;
      }
      throw this.unavailable(error, 'create');
    }
  }

  /**
   * POST /business-registration/resend. Same generic answer whether the correo exists or not.
   * Only a "pendiente_correo" request gets a new link, at most once per 60 s and 3 in total.
   */
  async resend(correoInput: string): Promise<void> {
    const correo = correoInput.trim().toLowerCase();
    const siteUrl = this.publicSiteUrl();
    try {
      await this.resendByCorreo(correo, siteUrl);
    } catch (error) {
      throw this.unavailable(error, 'resend');
    }
  }

  private async resendByCorreo(correo: string, siteUrl: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const existing = await this.findLiveRequest(tx, correo);
      if (existing) await this.resendVerification(tx, existing, siteUrl);
    }, REGISTRATION_TRANSACTION_OPTIONS);
  }

  /** The one live (not rejected) registration-v2 request of a correo, if any. */
  private findLiveRequest(tx: Prisma.TransactionClient, correo: string) {
    return tx.businessRegistrationRequest.findFirst({
      where: { correo, status: { not: 'rechazado' }, legalVersion: { not: null } },
    });
  }

  private verificationUrl(siteUrl: string, token: string): string {
    return `${siteUrl}/verificar-correo?token=${token}`;
  }

  private async createRequest(
    tx: Prisma.TransactionClient,
    dto: CreateBusinessRegistrationDto,
    correo: string,
    siteUrl: string,
  ): Promise<void> {
    // The per-correo hourly limit is only spent when an email really goes out.
    if (!this.limits.allowVerificationEmail(correo)) {
      this.logger.warn(`Verification emails limit reached for ${maskEmail(correo)}.`);
      return;
    }
    const now = new Date();
    const token = randomBytes(32).toString('base64url');
    await tx.businessRegistrationRequest.create({
      data: {
        id: createServerId(),
        status: 'pendiente_correo',
        nombreNegocio: dto.nombreNegocio,
        tipoNegocio: dto.tipoNegocio,
        queVende: dto.queVende,
        dondeVende: dto.dondeVende ?? null,
        recomendadoPor: dto.recomendadoPor ?? null,
        nombre: dto.nombre,
        apellidos: dto.apellidos,
        correo,
        telefono: dto.telefono,
        legalVersion: dto.versionLegal,
        legalAcceptedAt: now,
        emailTokenHash: hashToken(token),
        emailTokenExpiresAt: new Date(now.getTime() + REGISTRATION_RULES.verificationTtlMs),
        verificationEmailsSent: 1,
        lastVerificationEmailAt: now,
        // Placeholder: nobody holds the matching raw value, so this row cannot be approved
        // or rejected through any link. The real approval token is issued on confirmation.
        approvalTokenHash: hashToken(randomBytes(32).toString('base64url')),
        tokenExpiresAt: new Date(now.getTime() + REGISTRATION_RULES.verificationTtlMs),
      },
    });
    await this.sendVerification(dto.nombre, correo, this.verificationUrl(siteUrl, token));
    this.logger.log(`Registration created for ${maskEmail(correo)}; verification email sent.`);
  }

  /** Reissues the verification link for a "pendiente_correo" request, if the resend rules allow it. */
  private async resendVerification(
    tx: Prisma.TransactionClient,
    request: { id: string; status: string; nombre: string; correo: string; verificationEmailsSent: number; lastVerificationEmailAt: Date | null },
    siteUrl: string,
  ): Promise<void> {
    if (request.status !== 'pendiente_correo') return;
    if (request.verificationEmailsSent >= REGISTRATION_RULES.maxVerificationEmailsPerRequest) return;
    const now = new Date();
    const waitUntil = new Date(now.getTime() - REGISTRATION_RULES.resendWaitMs);
    if (request.lastVerificationEmailAt && request.lastVerificationEmailAt > waitUntil) return;
    if (!this.limits.allowVerificationEmail(request.correo)) {
      this.logger.warn(`Verification emails limit reached for ${maskEmail(request.correo)}.`);
      return;
    }
    const token = randomBytes(32).toString('base64url');
    // Optimistic claim: two simultaneous resends cannot both pass (only one row update matches).
    const claimed = await tx.businessRegistrationRequest.updateMany({
      where: {
        id: request.id,
        status: 'pendiente_correo',
        verificationEmailsSent: request.verificationEmailsSent,
        OR: [{ lastVerificationEmailAt: null }, { lastVerificationEmailAt: { lte: waitUntil } }],
      },
      data: {
        emailTokenHash: hashToken(token),
        emailTokenExpiresAt: new Date(now.getTime() + REGISTRATION_RULES.verificationTtlMs),
        verificationEmailsSent: { increment: 1 },
        lastVerificationEmailAt: now,
      },
    });
    if (claimed.count === 0) return;
    await this.sendVerification(request.nombre, request.correo, this.verificationUrl(siteUrl, token));
    this.logger.log(`Verification email resent to ${maskEmail(request.correo)}.`);
  }

  private async sendVerification(nombre: string, correo: string, verifyUrl: string): Promise<void> {
    try {
      await this.email.sendRegistrationVerificationEmail({ correo, nombre, verifyUrl });
    } catch (cause) {
      // The token never reaches the log: only Resend's own error text, which carries no secret.
      throw new RegistrationEmailError(`Verification email failed: ${cause instanceof Error ? cause.message : 'unknown'}`);
    }
  }

  /**
   * POST /business-registration/verify-email: the applicant pressed the button on the frontend
   * page. NEVER a GET (mail scanners open links on their own). In ONE transaction it consumes
   * the one-use token (atomic: only one of N simultaneous calls wins), moves the request to
   * "pendiente", issues the approver's approve/reject token and — only now — emails the
   * approver. If that email fails everything rolls back: 503 and the same link still works.
   * An unknown, used or expired token all answer the same 400.
   */
  async verifyEmail(token: string): Promise<void> {
    const emailTokenHash = hashToken(token);
    const approvalToken = randomBytes(32).toString('base64url');
    const now = new Date();
    try {
      const verified = await this.prisma.$transaction(async (tx) => {
        const claimed = await tx.businessRegistrationRequest.updateMany({
          where: {
            emailTokenHash,
            status: 'pendiente_correo',
            emailTokenExpiresAt: { gt: now },
          },
          data: {
            status: 'pendiente',
            emailVerifiedAt: now,
            emailTokenHash: null,
            emailTokenExpiresAt: null,
            approvalTokenHash: hashToken(approvalToken),
            tokenExpiresAt: new Date(now.getTime() + REGISTRATION_RULES.approvalTtlMs),
          },
        });
        if (claimed.count === 0) return false;
        const request = await tx.businessRegistrationRequest.findFirstOrThrow({
          where: { approvalTokenHash: hashToken(approvalToken) },
        });
        const [telefono, correo] = await Promise.all([
          request.telefono
            ? tx.businessRegistrationRequest.count({ where: { telefono: request.telefono, id: { not: request.id } } })
            : Promise.resolve(0),
          tx.businessRegistrationRequest.count({ where: { correo: request.correo, id: { not: request.id } } }),
        ]);
        try {
          await this.email.sendBusinessRegistrationApprovalEmail({
            nombreNegocio: request.nombreNegocio,
            tipoNegocio: request.tipoNegocio,
            queVende: request.queVende,
            dondeVende: request.dondeVende,
            recomendadoPor: request.recomendadoPor,
            nombre: request.nombre,
            apellidos: request.apellidos,
            correo: request.correo,
            telefono: request.telefono,
            emailVerifiedAt: request.emailVerifiedAt,
            duplicates: { telefono, correo },
            approveUrl: `${apiBaseUrl()}/api/v1/business-registration/approve?token=${approvalToken}`,
            rejectUrl: `${apiBaseUrl()}/api/v1/business-registration/reject?token=${approvalToken}`,
          });
        } catch (cause) {
          throw new RegistrationEmailError(`Approver email failed; verification rolled back: ${cause instanceof Error ? cause.message : 'unknown'}`);
        }
        this.logger.log(`Correo confirmed for ${maskEmail(request.correo)}; approver notified.`);
        return true;
      }, REGISTRATION_TRANSACTION_OPTIONS);
      if (!verified)
        throw new BadRequestException({
          statusCode: 400,
          code: 'link_invalid',
          message: 'Este enlace ya no sirve: venció o ya se usó. Puedes pedir uno nuevo.',
        });
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw this.unavailable(error, 'verify');
    }
  }

  /** Maps a failure of the registration transaction to a friendly 503 (or rethrows what is not ours). */
  private unavailable(error: unknown, step: string): unknown {
    if (error instanceof RegistrationEmailError || isTransactionExpired(error)) {
      this.logger.error(`Registration ${step} failed and rolled back: ${error instanceof Error ? error.message : 'error'}`);
      return new ServiceUnavailableException({
        statusCode: 503,
        code: 'email_unavailable',
        message: 'No pudimos enviar el correo en este momento. Intenta de nuevo en unos minutos.',
      });
    }
    return error;
  }

  /** Public origin of the FRONTEND (for the link in the verification email). */
  private publicSiteUrl(): string {
    const configured = process.env.PUBLIC_SITE_URL?.trim();
    if (configured) return configured.replace(/[?#].*$/, '').replace(/\/+$/, '');
    if (process.env.NODE_ENV === 'production') {
      this.logger.error('PUBLIC_SITE_URL is not configured: verification links cannot be built.');
      throw new ServiceUnavailableException({
        statusCode: 503,
        code: 'email_unavailable',
        message: 'No pudimos enviar el correo en este momento. Intenta de nuevo en unos minutos.',
      });
    }
    return 'http://localhost:5173';
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

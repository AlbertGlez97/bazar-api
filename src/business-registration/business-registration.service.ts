import { randomBytes, createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { EmailService } from '../email/email.service.js';
import { createServerId } from '../common/server-id.js';
import { CreateBusinessRegistrationDto } from './dto/create-business-registration.dto.js';
import { renderStatusPage } from './status-page.html.js';

const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

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
 * contextId and a founding socio Member) once a human clicks "approve"
 * on the notification email.
 *
 * Runs with no tenant/contextId in scope by design: at creation time
 * there is no contextId yet at all, and the approve/reject endpoints are
 * public (no Account, so no AuthGuard, so nothing populates the
 * AsyncLocalStorage tenant context — see src/database/tenant-context.ts).
 * The one write that actually needs a contextId (the founding Member,
 * created on approval) passes it explicitly in its own `data`, which the
 * tenant-isolation extension treats as the source of truth when no
 * request-scoped contextId is active — this is the documented
 * "bootstrapping a brand-new tenant from a public endpoint" escape
 * hatch for the application layer. The database layer needs the same
 * thing: Postgres RLS denies every write to a tenant table unless the
 * session variable `app.context_id` matches the row, so `approve` sets
 * it (transaction-local) to the brand-new contextId before creating the
 * Member. Without that, the INSERT is rejected with SQLSTATE 42501 —
 * invisible while the app connected as a superuser, which bypasses RLS.
 */
@Injectable()
export class BusinessRegistrationService {
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

    const created = await this.prisma.businessRegistrationRequest.create({
      data: {
        id: createServerId(),
        nombreNegocio: dto.nombreNegocio,
        nombreSocio: dto.nombreSocio,
        contactoSocio: dto.contactoSocio,
        approvalTokenHash,
        tokenExpiresAt,
      },
    });

    const approveUrl = `${baseUrl()}/api/v1/business-registration/approve?token=${token}`;
    const rejectUrl = `${baseUrl()}/api/v1/business-registration/reject?token=${token}`;
    await this.email.sendBusinessRegistrationApprovalEmail({
      nombreNegocio: dto.nombreNegocio,
      nombreSocio: dto.nombreSocio,
      contactoSocio: dto.contactoSocio,
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
   * Approves a pending, unexpired request: creates the real contextId
   * and the founding socio Member, and marks the request "aprobado".
   * Returns an HTML confirmation page in every case (see the module doc
   * comment on {@link renderStatusPage}), never a JSON error.
   */
  async approve(token: string): Promise<HtmlPageResult> {
    return this.resolve(token, async (tx, request) => {
      const contextId = createServerId();
      await tx.$executeRaw`SELECT set_config('app.context_id', ${contextId}, true)`;
      await tx.member.create({
        data: {
          id: createServerId(),
          name: request.nombreSocio,
          role: 'socio',
          contextId,
          active: true,
        },
      });
      await tx.businessRegistrationRequest.update({
        where: { id: request.id },
        data: {
          status: 'aprobado',
          resolvedAt: new Date(),
          createdContextId: contextId,
        },
      });
      return renderStatusPage(
        'Negocio aprobado',
        `"${request.nombreNegocio}" ya está activo y listo para iniciar sesión.`,
      );
    });
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
      request: {
        id: string;
        nombreNegocio: string;
        nombreSocio: string;
        contactoSocio: string;
      },
    ) => Promise<string>,
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
      return {
        statusCode: 200,
        html: renderStatusPage(
          'Ya fue procesado',
          'Esta solicitud ya fue resuelta anteriormente; este enlace ya no tiene efecto.',
        ),
      };
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
    const html = await this.prisma.$transaction((tx) => onValid(tx, request));
    return { statusCode: 200, html };
  }
}

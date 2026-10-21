import {
  BadRequestException,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { normalizeSocioEmail } from '../business-registration/initial-credentials.js';
import { SlidingWindowLimiter } from '../business-registration/rate-limiter.js';
import { businessNameOf } from '../common/business-name.js';
import { publicSiteUrl } from '../common/public-site-url.js';
import { createServerId } from '../common/server-id.js';
import { generateSingleUseToken, hashSingleUseToken } from '../common/single-use-token.js';
import { maskEmail } from '../common/text-sanitize.js';
import { PrismaService } from '../database/prisma.service.js';
import { EmailService } from '../email/email.service.js';

type Actor = Pick<AuthenticatedRequest, 'account' | 'selection'>;

/** The confirmation link works for 48 hours. */
export const EMAIL_CONFIRMATION_TTL_MS = 48 * 60 * 60 * 1000;
/** A socio can ask for this many confirmation emails per hour. */
const REQUEST_LIMIT = 5;
const REQUEST_WINDOW_MS = 60 * 60 * 1000;
/** Public page: attempts per link and per address in a 10 minute window. */
const WINDOW_MS = 10 * 60 * 1000;
const TOKEN_LIMIT = 10;
const IP_LIMIT = 120;

export const EMAIL_IN_USE_MESSAGE = 'Ese correo ya está en uso. Usa otro correo.';
export const EMAIL_LINK_INVALID_MESSAGE =
  'Este enlace no sirve. Escribe tu correo de nuevo para recibir otro.';

const invalidLink = () =>
  new NotFoundException({ code: 'MEMBER_EMAIL_LINK_INVALID', message: EMAIL_LINK_INVALID_MESSAGE });
const tooMany = (code: string, message: string) => new HttpException({ code, message }, 429);

/**
 * A socio writes the address their approvals go to, once, and proves it is theirs with a link
 * sent to that address. Until the link is opened nothing about the member changes.
 */
@Injectable()
export class MemberEmailService {
  private readonly logger = new Logger(MemberEmailService.name);
  private readonly byMember = new SlidingWindowLimiter();
  private readonly byToken = new SlidingWindowLimiter();
  private readonly byIp = new SlidingWindowLimiter();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(EmailService) private readonly email: EmailService,
  ) {}

  // ───────────────────── the socio, from the app ─────────────────────

  /** The caller's own address (masked) and the confirmation still waiting, if any. */
  async status(actor: Actor, now = new Date()) {
    const contextId = actor.account.contextId;
    const memberId = actor.selection!.memberId;
    const [member, pending] = await Promise.all([
      this.prisma.member.findFirst({ where: { id: memberId, contextId } }),
      this.prisma.memberEmailConfirmation.findFirst({
        where: { contextId, memberId, usedAt: null, supersededAt: null, expiresAt: { gt: now } },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    return {
      correo: member?.correo ? maskEmail(member.correo) : null,
      pending: pending
        ? { correo: maskEmail(pending.correo), expiresAt: pending.expiresAt.toISOString() }
        : null,
    };
  }

  /** Starts the confirmation: validates the address and emails the link to it. */
  async request(actor: Actor, rawCorreo: string, now = new Date()) {
    const correo = normalizeSocioEmail(rawCorreo);
    if (!correo)
      throw new BadRequestException({
        code: 'MEMBER_EMAIL_INVALID',
        message: 'Escribe un correo válido, por ejemplo nombre@dominio.com',
      });
    const contextId = actor.account.contextId;
    const memberId = actor.selection!.memberId;
    if (!this.byMember.hit(memberId, REQUEST_LIMIT, REQUEST_WINDOW_MS).allowed)
      throw tooMany(
        'MEMBER_EMAIL_TOO_MANY',
        'Pediste muchos correos de confirmación. Espera una hora e inténtalo de nuevo.',
      );
    const { token, hash } = generateSingleUseToken();
    const created = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Member" WHERE "id" = ${memberId}::uuid AND "contextId" = ${contextId} FOR UPDATE`;
      const member = await tx.member.findFirst({
        where: { id: memberId, contextId, active: true, role: 'socio' },
      });
      if (!member) throw new NotFoundException('No encontramos a esa persona.');
      if (member.correo)
        throw new ConflictException({
          code: 'MEMBER_EMAIL_ALREADY_SET',
          message: 'Ya tienes un correo registrado.',
        });
      // Another person's address, in any business.
      const [{ taken }] = await tx.$queryRaw<{ taken: boolean }[]>`
        SELECT member_correo_taken(${memberId}::uuid, ${correo}) AS taken`;
      // A login that already uses this address belongs to someone else, unless it is this
      // business's own shared login (the founder typing the address they signed up with).
      const login = await tx.account.findFirst({ where: { username: correo } });
      const loginIsSomeoneElses =
        login !== null && !(login.contextId === contextId && login.memberId === null) && login.memberId !== memberId;
      if (taken || loginIsSomeoneElses)
        throw new ConflictException({ code: 'MEMBER_EMAIL_IN_USE', message: EMAIL_IN_USE_MESSAGE });
      await tx.memberEmailConfirmation.updateMany({
        where: { contextId, memberId, usedAt: null, supersededAt: null },
        data: { supersededAt: now },
      });
      const expiresAt = new Date(now.getTime() + EMAIL_CONFIRMATION_TTL_MS);
      const row = await tx.memberEmailConfirmation.create({
        data: {
          id: createServerId(),
          contextId,
          memberId,
          correo,
          tokenHash: hash,
          requestedByAccountId: actor.account.id,
          createdAt: now,
          expiresAt,
        },
      });
      return { id: row.id, name: member.name, expiresAt };
    });

    const site = publicSiteUrl();
    try {
      if (!site) throw new Error('PUBLIC_SITE_URL is not configured');
      await this.email.sendMemberEmailConfirmationEmail({
        to: correo,
        memberName: created.name,
        businessName: (await businessNameOf(this.prisma, contextId)) ?? 'tu negocio',
        confirmUrl: `${site}/confirmar-correo/${token}`,
        expiresInHours: EMAIL_CONFIRMATION_TTL_MS / (60 * 60 * 1000),
      });
    } catch (error) {
      // The link never reached the address: it must not stay usable.
      await this.prisma.memberEmailConfirmation
        .update({ where: { id: created.id }, data: { supersededAt: new Date() } })
        .catch(() => undefined);
      this.logger.warn(
        `Member email confirmation failed: ${error instanceof Error ? error.name : 'error'}`,
      );
      throw new UnprocessableEntityException({
        code: 'MEMBER_EMAIL_NOT_SENT',
        message: 'No pudimos enviar el correo. Revisa que esté bien escrito e inténtalo de nuevo.',
      });
    }
    return { ok: true, correo: maskEmail(correo), expiresAt: created.expiresAt.toISOString() };
  }

  // ───────────────────── public page (no session) ─────────────────────

  /** Read-only: shows whose address is being confirmed. Never consumes the link. */
  async inspect(token: string, ip: string) {
    this.limit(token, ip);
    const rows = await this.prisma.$queryRaw<
      { memberName: string; correo: string; expiresAt: Date }[]
    >`SELECT "memberName", "correo", "expiresAt" FROM member_email_confirmation_lookup(${hashSingleUseToken(token)})`;
    const row = rows[0];
    if (!row) throw invalidLink();
    return {
      memberName: row.memberName,
      correo: maskEmail(row.correo),
      expiresAt: row.expiresAt.toISOString(),
    };
  }

  /** The address becomes the member's. The link works exactly once. */
  async confirm(token: string, ip: string) {
    this.limit(token, ip);
    const rows = await this.prisma.$queryRaw<
      {
        correo: string;
        memberName: string;
        contextId: string;
        memberId: string;
        notify: { name: string; correo: string }[];
      }[]
    >`SELECT "correo", "memberName", "contextId", "memberId", "notify" FROM member_email_confirm(${hashSingleUseToken(token)})`;
    const row = rows[0];
    if (!row) throw invalidLink();
    // The other socios hear who registered an address (masked), so a wrong one does not go unseen.
    const business = (await businessNameOf(this.prisma, row.contextId)) ?? 'tu negocio';
    for (const other of row.notify) {
      try {
        await this.email.sendMemberEmailRegisteredNoticeEmail({
          to: other.correo,
          memberName: other.name,
          registeredName: row.memberName,
          maskedCorreo: maskEmail(row.correo),
          businessName: business,
        });
      } catch (error) {
        this.logger.warn(
          `Member email notice failed: ${error instanceof Error ? error.name : 'error'}`,
        );
      }
    }
    return { ok: true, correo: maskEmail(row.correo) };
  }

  private limit(token: string, ip: string) {
    const blocked =
      !this.byToken.hit(hashSingleUseToken(token), TOKEN_LIMIT, WINDOW_MS).allowed ||
      !this.byIp.hit(ip, IP_LIMIT, WINDOW_MS).allowed;
    if (blocked)
      throw tooMany(
        'MEMBER_EMAIL_RATE_LIMITED',
        'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.',
      );
  }
}

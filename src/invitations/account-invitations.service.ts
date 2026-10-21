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
import { hashPassword } from '../common/password.js';
import { createServerId } from '../common/server-id.js';
import { stripQueryAndFragment, trimTrailingSlashes } from '../common/url-parts.js';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { EmailService } from '../email/email.service.js';
import {
  INVITATION_MAX_NEW_PER_DAY,
  INVITATION_MAX_PER_DAY,
  INVITATION_MIN_GAP_MS,
  INVITATION_TTL_MS,
  generateInvitationToken,
  hashInvitationToken,
} from './invitation-token.js';

type Actor = Pick<AuthenticatedRequest, 'account' | 'selection'>;

const DAY_MS = 24 * 60 * 60 * 1000;
/** Same limit as the login: `LoginDto.username` accepts at most 100 characters. */
const MAX_EMAIL_LENGTH = 100;
/** Public page: attempts per link and per address in a 10 minute window. */
const WINDOW_MS = 10 * 60 * 1000;
const TOKEN_LIMIT = 10;
const IP_LIMIT = 120;

export const INVITATION_NOT_SENT_MESSAGE =
  'No pudimos enviar la invitación a ese correo.';
export const INVITATION_INVALID_MESSAGE =
  'Este enlace no sirve. Pide una invitación nueva.';

/** One answer for every reason an invitation cannot be sent, so nothing about accounts leaks. */
const notSent = () =>
  new UnprocessableEntityException({
    code: 'INVITATION_NOT_SENT',
    message: INVITATION_NOT_SENT_MESSAGE,
  });
/** One answer for unknown, used, replaced and expired links. */
const invalidLink = () =>
  new NotFoundException({
    code: 'INVITATION_INVALID',
    message: INVITATION_INVALID_MESSAGE,
  });
const tooMany = (code: string, message: string) =>
  new HttpException({ code, message }, 429);

export interface InvitationStatus {
  memberId: string;
  name: string;
  hasPersonalAccount: boolean;
  invitation: null | {
    email: string;
    sentAt: string;
    expiresAt: string;
    canResendAt: string;
    resendsLeftToday: number;
  };
}

@Injectable()
export class AccountInvitationsService {
  private readonly logger = new Logger(AccountInvitationsService.name);
  private readonly byToken = new SlidingWindowLimiter();
  private readonly byIp = new SlidingWindowLimiter();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(EmailService) private readonly email: EmailService,
  ) {}

  // ───────────────────── a socio invites another socio ─────────────────────

  async invite(actor: Actor, memberId: string, rawEmail: string, now = new Date()) {
    const email = normalizeSocioEmail(rawEmail);
    if (!email || email.length > MAX_EMAIL_LENGTH)
      throw new BadRequestException('Escribe un correo válido.');
    const contextId = actor.account.contextId;
    const inviterId = actor.selection!.memberId;
    const { token, hash } = generateInvitationToken();
    const expiresAt = new Date(now.getTime() + INVITATION_TTL_MS);

    const created = await this.prisma.$transaction(async (tx) => {
      // One invitation at a time per socio: the row lock orders concurrent requests.
      await tx.$queryRaw`SELECT "id" FROM "Member" WHERE "id" = ${memberId}::uuid AND "contextId" = ${contextId} FOR UPDATE`;
      const member = await tx.member.findFirst({ where: { id: memberId, contextId } });
      if (!member) throw new NotFoundException('No encontramos a esa persona.');
      if (!member.active || member.role !== 'socio')
        throw new UnprocessableEntityException(
          'Solo se puede invitar a un socio activo.',
        );
      if (await tx.account.findFirst({ where: { memberId } }))
        throw new ConflictException('Este socio ya tiene su cuenta personal.');

      await this.enforceSendLimits(tx, contextId, memberId, now);
      await this.enforceNewInvitationLimit(tx, contextId, memberId, inviterId, now);
      // Any account with this address, in any business, gets the same generic answer.
      if (await tx.account.findFirst({ where: { username: email } })) throw notSent();

      await tx.accountInvitation.updateMany({
        where: { contextId, memberId, usedAt: null, supersededAt: null },
        data: { supersededAt: now },
      });
      const row = await tx.accountInvitation.create({
        data: {
          id: createServerId(),
          contextId,
          memberId,
          email,
          tokenHash: hash,
          invitedByMemberId: inviterId,
          createdAt: now,
          expiresAt,
        },
      });
      const inviter = await tx.member.findFirst({ where: { id: inviterId, contextId } });
      return { id: row.id, memberName: member.name, inviterName: inviter?.name ?? 'Un socio' };
    });

    try {
      await this.email.sendAccountInvitationEmail({
        to: email,
        memberName: created.memberName,
        inviterName: created.inviterName,
        businessName: (await businessNameOf(this.prisma, contextId)) ?? 'tu negocio',
        inviteUrl: `${this.publicSiteUrl()}/invitacion/${token}`,
        expiresInHours: INVITATION_TTL_MS / (60 * 60 * 1000),
      });
    } catch (error) {
      // The link was never delivered: it must not stay usable.
      await this.prisma.accountInvitation
        .update({ where: { id: created.id }, data: { supersededAt: new Date() } })
        .catch(() => undefined);
      this.logger.warn(
        `Invitation email failed: ${error instanceof Error ? error.name : 'error'}`,
      );
      throw notSent();
    }
    return { ok: true, expiresAt: expiresAt.toISOString() };
  }

  /** Who already has a personal login and who has a live invitation, for the team screen. */
  async status(actor: Actor, now = new Date()): Promise<InvitationStatus[]> {
    const contextId = actor.account.contextId;
    const members = await this.prisma.member.findMany({
      where: { contextId, role: 'socio', active: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const ids = members.map((m) => m.id);
    const [accounts, invitations] = await Promise.all([
      this.prisma.account.findMany({ where: { contextId, memberId: { in: ids } } }),
      this.prisma.accountInvitation.findMany({
        where: { contextId, memberId: { in: ids } },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    return members.map((member) => {
      const mine = invitations.filter((i) => i.memberId === member.id);
      const latest = mine[0];
      const live =
        latest && !latest.usedAt && !latest.supersededAt && latest.expiresAt > now ? latest : null;
      const today = mine.filter((i) => now.getTime() - i.createdAt.getTime() < DAY_MS).length;
      return {
        memberId: member.id,
        name: member.name,
        hasPersonalAccount: accounts.some((a) => a.memberId === member.id),
        invitation: live
          ? {
              email: live.email,
              sentAt: live.createdAt.toISOString(),
              expiresAt: live.expiresAt.toISOString(),
              canResendAt: new Date(live.createdAt.getTime() + INVITATION_MIN_GAP_MS).toISOString(),
              resendsLeftToday: Math.max(0, INVITATION_MAX_PER_DAY - today),
            }
          : null,
      };
    });
  }

  // ───────────────────── public page (no session) ─────────────────────

  /** Read-only: shows who the invitation is for. Never consumes the link. */
  async inspect(token: string, ip: string) {
    this.limit(token, ip);
    const rows = await this.prisma.$queryRaw<
      { memberName: string; email: string; expiresAt: Date }[]
    >`SELECT "memberName", "email", "expiresAt" FROM account_invitation_lookup(${hashInvitationToken(token)})`;
    const row = rows[0];
    if (!row) throw invalidLink();
    return { memberName: row.memberName, email: row.email, expiresAt: row.expiresAt.toISOString() };
  }

  /** Creates the login with the password the person chose; the link works exactly once. */
  async accept(token: string, password: string, ip: string) {
    this.limit(token, ip);
    const tokenHash = hashInvitationToken(token);
    // Hashing is expensive: do it only for a link that is still usable.
    const live = await this.prisma.$queryRaw<{ email: string }[]>`
      SELECT "email" FROM account_invitation_lookup(${tokenHash})`;
    if (!live.length) throw invalidLink();
    const passwordHash = await hashPassword(password);
    const accountId = createServerId();
    const rows = await this.prisma.$queryRaw<{ email: string }[]>`
      SELECT "email" FROM account_invitation_accept(${tokenHash}, ${accountId}::uuid, ${passwordHash})`;
    if (!rows.length) throw invalidLink();
    return { ok: true, email: rows[0]!.email };
  }

  // ───────────────────── helpers ─────────────────────

  private async enforceSendLimits(
    tx: Prisma.TransactionClient,
    contextId: string,
    memberId: string,
    now: Date,
  ) {
    const mine = await tx.accountInvitation.findMany({
      where: { contextId, memberId },
      orderBy: { createdAt: 'desc' },
      take: INVITATION_MAX_PER_DAY + 1,
    });
    if (mine[0] && now.getTime() - mine[0].createdAt.getTime() < INVITATION_MIN_GAP_MS)
      throw tooMany(
        'INVITATION_TOO_SOON',
        'Espera un minuto antes de enviar otra invitación.',
      );
    const today = mine.filter((i) => now.getTime() - i.createdAt.getTime() < DAY_MS);
    if (today.length >= INVITATION_MAX_PER_DAY)
      throw tooMany(
        'INVITATION_DAILY_LIMIT',
        `Ya se enviaron ${INVITATION_MAX_PER_DAY} invitaciones hoy. Intenta mañana.`,
      );
  }

  /**
   * A socio can invite at most {@link INVITATION_MAX_NEW_PER_DAY} different people for the
   * first time in 24 hours. Re-sending to someone already invited is not a new person and
   * is governed only by the per-person limits above.
   */
  private async enforceNewInvitationLimit(
    tx: Prisma.TransactionClient,
    contextId: string,
    memberId: string,
    inviterId: string,
    now: Date,
  ) {
    if ((await tx.accountInvitation.count({ where: { contextId, memberId } })) > 0) return;
    const since = new Date(now.getTime() - DAY_MS);
    const recent = await tx.accountInvitation.findMany({
      where: { contextId, invitedByMemberId: inviterId, createdAt: { gte: since } },
    });
    if (!recent.length) return;
    const everything = await tx.accountInvitation.findMany({
      where: { contextId, memberId: { in: [...new Set(recent.map((i) => i.memberId))] } },
      orderBy: { createdAt: 'asc' },
    });
    // A person counts once, by their very first invitation.
    const first = new Map<string, (typeof everything)[number]>();
    for (const invitation of everything)
      if (!first.has(invitation.memberId)) first.set(invitation.memberId, invitation);
    const fresh = [...first.values()].filter(
      (i) => i.invitedByMemberId === inviterId && i.createdAt >= since,
    ).length;
    if (fresh >= INVITATION_MAX_NEW_PER_DAY)
      throw tooMany(
        'INVITATION_NEW_DAILY_LIMIT',
        `Ya invitaste a ${INVITATION_MAX_NEW_PER_DAY} personas hoy. Intenta mañana.`,
      );
  }

  private limit(token: string, ip: string) {
    const blocked =
      !this.byToken.hit(hashInvitationToken(token), TOKEN_LIMIT, WINDOW_MS).allowed ||
      !this.byIp.hit(ip, IP_LIMIT, WINDOW_MS).allowed;
    if (blocked)
      throw tooMany(
        'INVITATION_RATE_LIMITED',
        'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.',
      );
  }

  /** Public origin of the FRONTEND, for the link in the email. */
  private publicSiteUrl(): string {
    const configured = process.env.PUBLIC_SITE_URL?.trim();
    if (configured) return trimTrailingSlashes(stripQueryAndFragment(configured));
    if (process.env.NODE_ENV === 'production') {
      this.logger.error('PUBLIC_SITE_URL is not configured: invitation links cannot be built.');
      throw notSent();
    }
    return 'http://localhost:5173';
  }
}

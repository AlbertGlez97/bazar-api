import {
  BadRequestException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SlidingWindowLimiter } from '../business-registration/rate-limiter.js';
import { businessNameOf } from '../common/business-name.js';
import { publicSiteUrl } from '../common/public-site-url.js';
import { createServerId } from '../common/server-id.js';
import { generateSingleUseToken, hashSingleUseToken } from '../common/single-use-token.js';
import { cleanText } from '../common/text-sanitize.js';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { EmailService, type RuleChangeLine } from '../email/email.service.js';
import { rulesWarnings, type FinanceRulesConfig } from './finance-rules.config.js';
import { describeRules } from './finance-rules.summary.js';

type Tx = Prisma.TransactionClient;

/** An emailed link works for 7 days. */
export const LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** A socio is re-sent a link at most once in this long. */
export const RESEND_COOLDOWN_MS = 24 * 60 * 60 * 1000;
/** The objection reason: plain text, 1 to 500 characters. */
export const MAX_REASON_LENGTH = 500;

/** Public page: attempts per link and per address in a 10 minute window. */
const WINDOW_MS = 10 * 60 * 1000;
const TOKEN_LIMIT = 10;
const IP_LIMIT = 120;

export const AGREEMENT_LINK_INVALID_MESSAGE =
  'Este enlace no sirve. Pide a un socio que te lo envíe de nuevo.';
export const AGREEMENT_IN_REVIEW_MESSAGE =
  'Esta propuesta está en revisión; recibirás la versión nueva por correo.';

/** One answer for unknown, used, replaced, expired and closed links. */
const invalidLink = () =>
  new NotFoundException({ code: 'AGREEMENT_LINK_INVALID', message: AGREEMENT_LINK_INVALID_MESSAGE });
const tooMany = () =>
  new HttpException(
    {
      code: 'AGREEMENT_RATE_LIMITED',
      message: 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.',
    },
    429,
  );

export interface LinkToSend {
  linkId: string;
  token: string;
  memberId: string;
  memberName: string;
  correo: string;
}

export interface ProposalMeta {
  proposerName: string;
  version: number;
  config: FinanceRulesConfig;
  changes: RuleChangeLine[] | null;
}

export interface AgreementPage {
  state: 'pendiente' | 'en_revision';
  /** Only when state is 'en_revision': what the page says instead of the buttons. */
  message: string | null;
  business: string;
  memberName: string;
  proposerName: string;
  version: number;
  submittedAt: string | null;
  expiresAt: string;
  rules: string[];
  warnings: { code: string; message: string }[];
  changes: RuleChangeLine[] | null;
  approvedBy: string[];
  waitingFor: string[];
}

interface LookupRow {
  state: 'pendiente' | 'en_revision';
  contextId: string;
  version: number;
  config: FinanceRulesConfig;
  changeSummary: RuleChangeLine[] | null;
  memberName: string;
  proposerName: string;
  expiresAt: Date;
  submittedAt: Date | null;
  approvedNames: string[];
  waitingNames: string[];
}

export type AgreementOutcome = 'aprobada' | 'vigente' | 'objetada' | 'en_revision';

/**
 * The emailed approval links: issuing them inside the sender's transaction, delivering them after
 * it commits, and the public page that reads and answers one. The page never has a session: it
 * works through two SECURITY DEFINER functions that look the link up by the hash of its token.
 */
@Injectable()
export class FinanceRuleLinksService {
  private readonly logger = new Logger(FinanceRuleLinksService.name);
  private readonly byToken = new SlidingWindowLimiter();
  private readonly byIp = new SlidingWindowLimiter();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(EmailService) private readonly email: EmailService,
  ) {}

  // ───────────────────── issuing and delivering (inside a socio's request) ─────────────────────

  /** Creates a link for one socio, replacing any live one they had for this proposal. */
  async issue(
    tx: Tx,
    input: {
      contextId: string;
      ruleSetId: string;
      memberId: string;
      correo: string;
      kind: 'envio' | 'reenvio';
      sentByMemberId: string;
      now: Date;
    },
  ): Promise<{ linkId: string; token: string }> {
    const { contextId, ruleSetId, memberId, now } = input;
    const { token, hash } = generateSingleUseToken();
    await tx.financeRuleLink.updateMany({
      where: { contextId, ruleSetId, memberId, usedAt: null, supersededAt: null },
      data: { supersededAt: now },
    });
    const row = await tx.financeRuleLink.create({
      data: {
        id: createServerId(),
        contextId,
        ruleSetId,
        memberId,
        correo: input.correo,
        tokenHash: hash,
        kind: input.kind,
        sentByMemberId: input.sentByMemberId,
        createdAt: now,
        expiresAt: new Date(now.getTime() + LINK_TTL_MS),
      },
    });
    return { linkId: row.id, token };
  }

  /**
   * Emails the links after the transaction that created them committed. A failure for one socio
   * never stops the others: that link is retired (it was never delivered) and the socio is
   * reported, so "Reenviar correo" can try again at once. Returns who was emailed.
   */
  async deliver(contextId: string, links: LinkToSend[], meta: ProposalMeta): Promise<Set<string>> {
    const delivered = new Set<string>();
    if (!links.length) return delivered;
    const site = publicSiteUrl();
    const business = (await businessNameOf(this.prisma, contextId)) ?? 'tu negocio';
    const summary = describeRules(meta.config);
    for (const link of links) {
      try {
        if (!site) throw new Error('PUBLIC_SITE_URL is not configured');
        await this.email.sendFinanceRulesApprovalEmail({
          to: link.correo,
          memberName: link.memberName,
          proposerName: meta.proposerName,
          businessName: business,
          version: meta.version,
          summary,
          changes: meta.changes,
          reviewUrl: `${site}/acuerdo/${link.token}`,
          expiresInDays: LINK_TTL_MS / (24 * 60 * 60 * 1000),
        });
        await this.prisma.financeRuleLink.update({
          where: { id: link.linkId },
          data: { emailSent: true },
        });
        delivered.add(link.memberId);
      } catch (error) {
        // The link never reached anyone: it must not stay usable.
        await this.prisma.financeRuleLink
          .update({ where: { id: link.linkId }, data: { supersededAt: new Date() } })
          .catch(() => undefined);
        this.logger.warn(
          `Finance rules approval email failed: ${error instanceof Error ? error.name : 'error'}`,
        );
      }
    }
    return delivered;
  }

  // ───────────────────── public page (no session) ─────────────────────

  /** Read-only: shows the proposal to whoever holds the link. Never consumes it. */
  async inspect(token: string, ip: string): Promise<AgreementPage> {
    this.limit(token, ip);
    const rows = await this.prisma.$queryRaw<LookupRow[]>`
      SELECT "state", "contextId", "version", "config", "changeSummary", "memberName", "proposerName",
             "expiresAt", "submittedAt", "approvedNames", "waitingNames"
      FROM finance_rule_link_lookup(${hashSingleUseToken(token)})`;
    const row = rows[0];
    if (!row) throw invalidLink();
    return {
      state: row.state,
      message: row.state === 'en_revision' ? AGREEMENT_IN_REVIEW_MESSAGE : null,
      business: (await businessNameOf(this.prisma, row.contextId)) ?? 'tu negocio',
      memberName: row.memberName,
      proposerName: row.proposerName,
      version: row.version,
      submittedAt: row.submittedAt ? row.submittedAt.toISOString() : null,
      expiresAt: row.expiresAt.toISOString(),
      rules: describeRules(row.config),
      warnings: rulesWarnings(row.config),
      changes: row.changeSummary && row.changeSummary.length ? row.changeSummary : null,
      approvedBy: row.approvedNames,
      waitingFor: row.waitingNames,
    };
  }

  /**
   * Records the answer. The link works exactly once: two answers racing for the last approval end
   * with the rules in force once (the function locks the proposal before the link).
   */
  async respond(
    token: string,
    decision: 'approve' | 'object',
    rawReason: string | undefined,
    ip: string,
  ): Promise<{ outcome: AgreementOutcome }> {
    this.limit(token, ip);
    let reason = '';
    if (decision === 'object') {
      reason = String(cleanText(rawReason ?? ''));
      if (!reason)
        throw new BadRequestException({
          code: 'AGREEMENT_REASON_REQUIRED',
          message: 'Escribe en pocas palabras por qué no estás de acuerdo.',
        });
      if (reason.length > MAX_REASON_LENGTH)
        throw new BadRequestException({
          code: 'AGREEMENT_REASON_TOO_LONG',
          message: `Usa máximo ${MAX_REASON_LENGTH} letras.`,
        });
    }
    const rows = await this.prisma.$queryRaw<{ outcome: AgreementOutcome }[]>`
      SELECT "outcome" FROM finance_rule_link_respond(
        ${hashSingleUseToken(token)}, ${decision}, ${reason}, ${createServerId()}::uuid)`;
    const row = rows[0];
    if (!row) throw invalidLink();
    return { outcome: row.outcome };
  }

  private limit(token: string, ip: string) {
    const blocked =
      !this.byToken.hit(hashSingleUseToken(token), TOKEN_LIMIT, WINDOW_MS).allowed ||
      !this.byIp.hit(ip, IP_LIMIT, WINDOW_MS).allowed;
    if (blocked) throw tooMany();
  }
}

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { createServerId } from '../common/server-id.js';
import { maskEmail } from '../common/text-sanitize.js';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import type { RuleChangeLine } from '../email/email.service.js';
import {
  configHash,
  parseRulesConfig,
  rulesWarnings,
  type FinanceRulesConfig,
  type RulesWarning,
} from './finance-rules.config.js';
import {
  FinanceRuleLinksService,
  RESEND_COOLDOWN_MS,
  type LinkToSend,
} from './finance-rule-links.service.js';
import { describeChanges } from './finance-rules.summary.js';

type Actor = Pick<AuthenticatedRequest, 'account' | 'selection'>;
type Tx = Prisma.TransactionClient;

export const RULES_DISCLAIMER =
  'Esta herramienta ayuda a organizar el reparto. No es asesoría contable ni legal. Conviene validar las reglas con un contador.';

const fail = (Type: new (r: object) => Error, code: string, message: string) =>
  new Type({ code, message });

/** States in which a proposal is open: waiting for answers or in review. */
const OPEN = ['pendiente', 'en_revision'];

interface RuleSetRow {
  id: string;
  version: number;
  status: string;
  config: unknown;
  configHash: string;
  proposedByMemberId: string;
  basedOnId: string | null;
  changeSummary: unknown;
  closedNote: string | null;
  createdAt: Date;
  submittedAt: Date | null;
  inReviewAt: Date | null;
  activatedAt: Date | null;
  supersededAt: Date | null;
  discardedAt: Date | null;
  withdrawnAt: Date | null;
}

export interface ApprovalView {
  memberId: string;
  name: string;
  approvedAt: string;
  /** Masked on screen; null for approvals given from a session, before approval by email. */
  correo: string | null;
  via: 'correo' | 'sesion';
}

export interface ObjectionView {
  memberId: string;
  name: string;
  correo: string;
  reason: string;
  createdAt: string;
}

export interface RuleSetView {
  id: string;
  version: number;
  status: string;
  config: FinanceRulesConfig;
  configHash: string;
  warnings: RulesWarning[];
  proposedBy: { memberId: string; name: string };
  createdAt: string;
  submittedAt: string | null;
  inReviewAt: string | null;
  activatedAt: string | null;
  supersededAt: string | null;
  discardedAt: string | null;
  /** Only rows closed by the old "withdraw", which no longer exists. */
  withdrawnAt: string | null;
  /** Why it was closed without being approved, when there is a reason to tell. */
  closedNote: string | null;
  approvals: ApprovalView[];
  objections: ObjectionView[];
  /** What changed against the version it was copied from (or the one in force). */
  changes: RuleChangeLine[] | null;
  /** For a draft made with "Modificar": the version it comes from and the objections it answers. */
  basedOn: { id: string; version: number; objections: ObjectionView[] } | null;
  /** Active partners who have not answered yet (only meaningful while the proposal is open). */
  missing: { memberId: string; name: string }[];
}

export interface PartnerView {
  memberId: string;
  name: string;
  hasCorreo: boolean;
  /** Masked. */
  correo: string | null;
  /** What this partner answered on the open proposal. */
  response: 'aprobo' | 'objeto' | null;
  /** The last link that really went out for the open proposal. */
  link: null | { sentAt: string; expiresAt: string; expired: boolean; canResendAt: string | null };
}

interface Partner {
  memberId: string;
  name: string;
  correo: string | null;
}

const iso = (date: Date | null) => (date ? date.toISOString() : null);
const mask = (correo: string | null) => (correo ? maskEmail(correo) : null);

@Injectable()
export class FinanceRulesService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(FinanceRuleLinksService) private readonly links: FinanceRuleLinksService,
  ) {}

  // ───────────────────────── reading ─────────────────────────

  async overview(actor: Actor, now = new Date()) {
    const contextId = actor.account.contextId;
    const me = actor.selection!.memberId;
    const [rows, partners] = await Promise.all([
      this.prisma.financeRuleSet.findMany({
        where: { contextId },
        orderBy: { version: 'desc' },
        take: 60,
      }),
      this.activePartners(this.prisma, contextId),
    ]);
    const views = await this.toViews(contextId, rows as RuleSetRow[], partners);
    const inForce = views.find((v) => v.status === 'vigente') ?? null;
    const proposal = views.find((v) => OPEN.includes(v.status)) ?? null;
    const draft = views.find((v) => v.status === 'borrador') ?? null;
    const mine = partners.find((p) => p.memberId === me);
    const pendingCorreo = await this.prisma.memberEmailConfirmation.findFirst({
      where: { contextId, memberId: me, usedAt: null, supersededAt: null, expiresAt: { gt: now } },
      orderBy: { createdAt: 'desc' },
    });
    return {
      state: proposal ? proposal.status : inForce ? 'vigente' : 'sin_aprobar',
      inForce,
      proposal,
      draft,
      history: views.filter((v) => v.status !== 'borrador'),
      partners: await this.partnerViews(contextId, partners, proposal, now),
      me: {
        memberId: me,
        correo: mask(mine?.correo ?? null),
        hasCorreo: !!mine?.correo,
        pendingCorreo: pendingCorreo
          ? { correo: maskEmail(pendingCorreo.correo), expiresAt: pendingCorreo.expiresAt.toISOString() }
          : null,
      },
      disclaimer: RULES_DISCLAIMER,
    };
  }

  // ───────────────────────── writing ─────────────────────────

  /** Creates the open draft, or replaces the config of the one the caller already owns. */
  async saveDraft(actor: Actor, input: unknown) {
    const parsed = parseRulesConfig(input);
    if (!parsed.ok)
      throw fail(
        BadRequestException,
        'FINANCE_RULES_INVALID',
        `Las reglas no son válidas: ${parsed.errors.join('; ')}`,
      );
    const contextId = actor.account.contextId;
    const me = actor.selection!.memberId;
    const hash = configHash(parsed.config);
    const config = parsed.config as unknown as Prisma.InputJsonValue;
    const id = await this.prisma.$transaction(async (tx) => {
      await this.lockBusiness(tx, contextId);
      const open = await tx.financeRuleSet.findFirst({
        where: { contextId, status: 'borrador' },
      });
      if (open) {
        if (open.proposedByMemberId !== me)
          throw fail(
            ConflictException,
            'FINANCE_RULES_DRAFT_OWNED',
            'Otro socio ya tiene un borrador abierto. Pídele que lo envíe o lo descarte.',
          );
        await tx.financeRuleSet.update({
          where: { id: open.id },
          data: { config, configHash: hash, updatedAt: new Date() },
        });
        return open.id;
      }
      return this.createDraft(tx, actor, config, hash, null);
    });
    return this.viewOne(contextId, id);
  }

  /**
   * Closes a draft or an open proposal. Any active socio may: when the proposer is away, someone
   * else can still clear the way. The rules in force stay in force.
   */
  async discard(actor: Actor, id: string) {
    const contextId = actor.account.contextId;
    await this.prisma.$transaction(async (tx) => {
      const row = await this.lockRow(tx, contextId, id);
      if (row.status !== 'borrador' && !OPEN.includes(row.status))
        throw fail(
          ConflictException,
          'FINANCE_RULES_WRONG_STATE',
          'Solo se puede descartar un borrador o una propuesta abierta.',
        );
      const name = await this.nameOf(tx, contextId, actor.selection!.memberId);
      const now = new Date();
      await tx.financeRuleSet.update({
        where: { id },
        data: {
          status: 'descartada',
          discardedAt: now,
          updatedAt: now,
          closedNote: `Descartada por ${name}.`,
        },
      });
      await tx.financeRuleLink.updateMany({
        where: { contextId, ruleSetId: id, usedAt: null, supersededAt: null },
        data: { supersededAt: now },
      });
    });
    return this.viewOne(contextId, id);
  }

  /**
   * Freezes the draft, tells everyone what changed, and emails every active partner their own
   * link. Nothing is sent while someone has no address: the answer says who is missing.
   */
  async submit(actor: Actor, id: string, now = new Date()) {
    const contextId = actor.account.contextId;
    const me = actor.selection!.memberId;
    const plan = await this.prisma.$transaction(async (tx) => {
      await this.lockBusiness(tx, contextId);
      const row = await this.lockRow(tx, contextId, id);
      this.requireStatus(row, 'borrador', 'Solo se puede enviar un borrador.');
      this.requireProposer(row, actor);
      const partners = await this.activePartners(tx, contextId);
      const missing = partners.filter((p) => !p.correo);
      if (missing.length)
        throw new UnprocessableEntityException({
          code: 'FINANCE_RULES_MISSING_EMAIL',
          message: `No se puede enviar. Falta el correo de ${listNames(missing.map((p) => p.name))}.`,
          missing: missing.map(({ memberId, name }) => ({ memberId, name })),
        });
      const open = await tx.financeRuleSet.findFirst({
        where: { contextId, status: { in: OPEN } },
      });
      // The open proposal this one was copied from is replaced by it; any other blocks it.
      if (open && open.id !== row.basedOnId)
        throw fail(
          ConflictException,
          'FINANCE_RULES_PENDING_EXISTS',
          'Ya hay una propuesta abierta. Descártenla o modifíquenla antes de enviar otra.',
        );
      const base = await tx.financeRuleSet.findFirst({
        where: row.basedOnId
          ? { id: row.basedOnId, contextId }
          : { contextId, status: 'vigente' },
      });
      const changes = base
        ? describeChanges(base.config as unknown as FinanceRulesConfig, row.config as FinanceRulesConfig)
        : [];
      if (open)
        await tx.financeRuleSet.update({
          where: { id: open.id },
          data: {
            status: 'descartada',
            discardedAt: now,
            updatedAt: now,
            closedNote: `Reemplazada por la versión ${row.version}.`,
          },
        });
      await tx.financeRuleSet.update({
        where: { id },
        data: {
          status: 'pendiente',
          submittedAt: now,
          updatedAt: now,
          // Nothing to say when nothing changed: the column stays empty.
          ...(changes.length
            ? { changeSummary: changes as unknown as Prisma.InputJsonValue }
            : {}),
        },
      });
      const toSend: LinkToSend[] = [];
      for (const partner of partners) {
        const { linkId, token } = await this.links.issue(tx, {
          contextId,
          ruleSetId: id,
          memberId: partner.memberId,
          correo: partner.correo!,
          kind: 'envio',
          sentByMemberId: me,
          now,
        });
        toSend.push({ linkId, token, memberId: partner.memberId, memberName: partner.name, correo: partner.correo! });
      }
      const proposer = partners.find((p) => p.memberId === me);
      return {
        toSend,
        meta: {
          proposerName: proposer?.name ?? 'Un socio',
          version: row.version,
          config: row.config as FinanceRulesConfig,
          changes: changes.length ? changes : null,
        },
      };
    });
    const delivered = await this.links.deliver(contextId, plan.toSend, plan.meta);
    return {
      ...(await this.viewOne(contextId, id)),
      emails: {
        sent: plan.toSend.filter((l) => delivered.has(l.memberId)).map((l) => l.memberName),
        failed: plan.toSend.filter((l) => !delivered.has(l.memberId)).map((l) => l.memberName),
      },
    };
  }

  /**
   * Copies an open proposal into a new draft the caller owns, with the objections on top. The
   * proposal it comes from stays as it is until the new version is sent.
   */
  async modify(actor: Actor, id: string) {
    const contextId = actor.account.contextId;
    const newId = await this.prisma.$transaction(async (tx) => {
      await this.lockBusiness(tx, contextId);
      const row = await this.lockRow(tx, contextId, id);
      if (!OPEN.includes(row.status))
        throw fail(
          ConflictException,
          'FINANCE_RULES_WRONG_STATE',
          'Solo se puede modificar una propuesta abierta.',
        );
      const draft = await tx.financeRuleSet.findFirst({ where: { contextId, status: 'borrador' } });
      if (draft) {
        const owner = await this.nameOf(tx, contextId, draft.proposedByMemberId);
        throw fail(
          ConflictException,
          'FINANCE_RULES_DRAFT_EXISTS',
          `${owner} ya tiene un borrador abierto. Que lo envíe o lo descarte primero.`,
        );
      }
      return this.createDraft(
        tx,
        actor,
        row.config as Prisma.InputJsonValue,
        row.configHash,
        row.id,
      );
    });
    return this.viewOne(contextId, newId);
  }

  /**
   * Sends a new link to every partner who has not answered, each at most once every 24 hours.
   * The previous link of each one stops working. Any active socio may do it.
   */
  async resend(actor: Actor, id: string, now = new Date()) {
    const contextId = actor.account.contextId;
    const me = actor.selection!.memberId;
    const plan = await this.prisma.$transaction(async (tx) => {
      const row = await this.lockRow(tx, contextId, id);
      if (row.status === 'en_revision')
        throw fail(
          ConflictException,
          'FINANCE_RULES_IN_REVIEW',
          'Esta propuesta está en revisión. Modifícala o descártala.',
        );
      this.requireStatus(row, 'pendiente', 'Esta propuesta ya no espera respuestas.');
      // A partner who left since the proposal was sent may have been the last one missing.
      const [{ settled }] = await tx.$queryRaw<{ settled: boolean }[]>`
        SELECT finance_rule_set_settle(${contextId}, ${id}::uuid) AS settled`;
      if (settled) return { activated: true as const };
      const partners = await this.activePartners(tx, contextId);
      const answered = new Set(
        (await tx.financeRuleApproval.findMany({ where: { contextId, ruleSetId: id } })).map((a) => a.memberId),
      );
      const toSend: LinkToSend[] = [];
      const skipped: { memberId: string; name: string; nextAt: string }[] = [];
      const noEmail: { memberId: string; name: string }[] = [];
      for (const partner of partners.filter((p) => !answered.has(p.memberId))) {
        if (!partner.correo) {
          noEmail.push({ memberId: partner.memberId, name: partner.name });
          continue;
        }
        // Counts every re-send except one that failed (retired without ever going out), so two
        // requests at the same moment cannot both send, yet a failure never blocks the next try.
        const last = await tx.financeRuleLink.findFirst({
          where: {
            contextId,
            ruleSetId: id,
            memberId: partner.memberId,
            kind: 'reenvio',
            NOT: { emailSent: false, supersededAt: { not: null } },
          },
          orderBy: { createdAt: 'desc' },
        });
        if (last && now.getTime() - last.createdAt.getTime() < RESEND_COOLDOWN_MS) {
          skipped.push({
            memberId: partner.memberId,
            name: partner.name,
            nextAt: new Date(last.createdAt.getTime() + RESEND_COOLDOWN_MS).toISOString(),
          });
          continue;
        }
        const { linkId, token } = await this.links.issue(tx, {
          contextId,
          ruleSetId: id,
          memberId: partner.memberId,
          correo: partner.correo,
          kind: 'reenvio',
          sentByMemberId: me,
          now,
        });
        toSend.push({ linkId, token, memberId: partner.memberId, memberName: partner.name, correo: partner.correo });
      }
      const proposerName = await this.nameOf(tx, contextId, row.proposedByMemberId);
      return {
        activated: false as const,
        toSend,
        skipped,
        noEmail,
        meta: {
          proposerName,
          version: row.version,
          config: row.config as FinanceRulesConfig,
          changes: await this.storedChanges(tx, contextId, id),
        },
      };
    });
    if (plan.activated) return { activated: true, resent: [], skipped: [], noEmail: [] };
    const delivered = await this.links.deliver(contextId, plan.toSend, plan.meta);
    return {
      activated: false,
      resent: plan.toSend.map((l) => ({
        memberId: l.memberId,
        name: l.memberName,
        emailSent: delivered.has(l.memberId),
      })),
      skipped: plan.skipped,
      noEmail: plan.noEmail,
    };
  }

  // ───────────────────────── helpers ─────────────────────────

  private async createDraft(
    tx: Tx,
    actor: Actor,
    config: Prisma.InputJsonValue,
    hash: string,
    basedOnId: string | null,
  ): Promise<string> {
    const contextId = actor.account.contextId;
    const [{ next }] = await tx.$queryRaw<{ next: number }[]>`
      SELECT COALESCE(MAX("version"), 0) + 1 AS next FROM "FinanceRuleSet" WHERE "contextId" = ${contextId}`;
    const created = await tx.financeRuleSet.create({
      data: {
        id: createServerId(),
        contextId,
        version: Number(next),
        status: 'borrador',
        config,
        configHash: hash,
        proposedByMemberId: actor.selection!.memberId,
        proposedByAccountId: actor.account.id,
        basedOnId,
      },
    });
    return created.id;
  }

  /** The "what changed" frozen when the proposal was sent. */
  private async storedChanges(tx: Tx, contextId: string, id: string): Promise<RuleChangeLine[] | null> {
    const row = await tx.financeRuleSet.findFirst({ where: { id, contextId } });
    const stored = row?.changeSummary as RuleChangeLine[] | null | undefined;
    return stored && stored.length ? stored : null;
  }

  private async nameOf(tx: Tx, contextId: string, memberId: string): Promise<string> {
    const member = await tx.member.findFirst({ where: { id: memberId, contextId } });
    return member?.name ?? 'Un socio';
  }

  /** One writer at a time per business for version numbers and the single draft/open slots. */
  private lockBusiness(tx: Tx, contextId: string) {
    return tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'finance-rules:' + contextId}, 0))`;
  }

  /**
   * Locks the rule set row. Everything that touches a proposal and its links locks in this order
   * (rule set first, then links), the same as the SQL function that records an answer.
   */
  private async lockRow(tx: Tx, contextId: string, id: string) {
    const rows = await tx.$queryRaw<
      {
        id: string;
        version: number;
        status: string;
        config: unknown;
        configHash: string;
        proposedByMemberId: string;
        basedOnId: string | null;
      }[]
    >`SELECT "id", "version", "status", "config", "configHash", "proposedByMemberId", "basedOnId" FROM "FinanceRuleSet"
      WHERE "id" = ${id}::uuid AND "contextId" = ${contextId} FOR UPDATE`;
    if (!rows.length)
      throw fail(NotFoundException, 'FINANCE_RULES_NOT_FOUND', 'No encontramos esas reglas.');
    return rows[0]!;
  }

  private requireStatus(row: { status: string }, expected: string, message: string) {
    if (row.status !== expected)
      throw fail(ConflictException, 'FINANCE_RULES_WRONG_STATE', message);
  }

  /** The draft is the proposer's own work: only they edit and send it. */
  private requireProposer(row: { proposedByMemberId: string }, actor: Actor) {
    if (row.proposedByMemberId !== actor.selection!.memberId)
      throw fail(
        ForbiddenException,
        'FINANCE_RULES_NOT_PROPOSER',
        'Solo el socio que creó este borrador puede enviarlo.',
      );
  }

  private async activePartners(client: Tx | PrismaService, contextId: string): Promise<Partner[]> {
    const members = await client.member.findMany({
      where: { contextId, role: 'socio', active: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return members.map((m) => ({ memberId: m.id, name: m.name, correo: m.correo }));
  }

  private async partnerViews(
    contextId: string,
    partners: Partner[],
    proposal: RuleSetView | null,
    now: Date,
  ): Promise<PartnerView[]> {
    const links = proposal
      ? await this.prisma.financeRuleLink.findMany({
          where: { contextId, ruleSetId: proposal.id },
          orderBy: { createdAt: 'desc' },
        })
      : [];
    return partners.map((partner) => {
      const mine = links.filter((l) => l.memberId === partner.memberId);
      // The last one that really reached the partner, whether it is still live or was answered.
      const last = mine.find((l) => l.emailSent && (!l.supersededAt || l.usedAt));
      const lastResend = mine.find((l) => l.kind === 'reenvio' && (l.emailSent || !l.supersededAt));
      const next = lastResend ? lastResend.createdAt.getTime() + RESEND_COOLDOWN_MS : 0;
      return {
        memberId: partner.memberId,
        name: partner.name,
        hasCorreo: !!partner.correo,
        correo: mask(partner.correo),
        response: proposal?.approvals.some((a) => a.memberId === partner.memberId)
          ? 'aprobo'
          : proposal?.objections.some((o) => o.memberId === partner.memberId)
            ? 'objeto'
            : null,
        link: last
          ? {
              sentAt: last.createdAt.toISOString(),
              expiresAt: last.expiresAt.toISOString(),
              expired: !last.usedAt && last.expiresAt <= now,
              canResendAt: next > now.getTime() ? new Date(next).toISOString() : null,
            }
          : null,
      };
    });
  }

  private async viewOne(contextId: string, id: string): Promise<RuleSetView> {
    const row = await this.prisma.financeRuleSet.findFirst({ where: { id, contextId } });
    const partners = await this.activePartners(this.prisma, contextId);
    return (await this.toViews(contextId, [row as RuleSetRow], partners))[0]!;
  }

  private async toViews(
    contextId: string,
    rows: RuleSetRow[],
    partners: Partner[],
  ): Promise<RuleSetView[]> {
    if (!rows.length) return [];
    const baseIds = [...new Set(rows.flatMap((r) => (r.basedOnId ? [r.basedOnId] : [])))];
    const bases = baseIds.length
      ? await this.prisma.financeRuleSet.findMany({ where: { contextId, id: { in: baseIds } } })
      : [];
    const setIds = [...new Set([...rows.map((r) => r.id), ...baseIds])];
    const [approvals, objections] = await Promise.all([
      this.prisma.financeRuleApproval.findMany({
        where: { contextId, ruleSetId: { in: setIds } },
        orderBy: { approvedAt: 'asc' },
      }),
      this.prisma.financeRuleObjection.findMany({
        where: { contextId, ruleSetId: { in: setIds } },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    const ids = new Set<string>([
      ...rows.map((r) => r.proposedByMemberId),
      ...approvals.map((a) => a.memberId),
      ...objections.map((o) => o.memberId),
    ]);
    const names = new Map(
      (await this.prisma.member.findMany({ where: { contextId, id: { in: [...ids] } } })).map(
        (m) => [m.id, m.name] as const,
      ),
    );
    const objectionViews = (setId: string): ObjectionView[] =>
      objections
        .filter((o) => o.ruleSetId === setId)
        .map((o) => ({
          memberId: o.memberId,
          name: names.get(o.memberId) ?? 'Socio',
          correo: maskEmail(o.correo),
          reason: o.reason,
          createdAt: o.createdAt.toISOString(),
        }));
    return rows.map((row) => {
      const mine = approvals.filter((a) => a.ruleSetId === row.id);
      const answered = new Set([
        ...mine.map((a) => a.memberId),
        ...objections.filter((o) => o.ruleSetId === row.id).map((o) => o.memberId),
      ]);
      const config = row.config as FinanceRulesConfig;
      const base = bases.find((b) => b.id === row.basedOnId);
      return {
        id: row.id,
        version: row.version,
        status: row.status,
        config,
        configHash: row.configHash,
        warnings: rulesWarnings(config),
        proposedBy: {
          memberId: row.proposedByMemberId,
          name: names.get(row.proposedByMemberId) ?? 'Socio',
        },
        createdAt: row.createdAt.toISOString(),
        submittedAt: iso(row.submittedAt),
        inReviewAt: iso(row.inReviewAt),
        activatedAt: iso(row.activatedAt),
        supersededAt: iso(row.supersededAt),
        discardedAt: iso(row.discardedAt),
        withdrawnAt: iso(row.withdrawnAt),
        closedNote: row.closedNote,
        approvals: mine.map((a) => ({
          memberId: a.memberId,
          name: names.get(a.memberId) ?? 'Socio',
          approvedAt: a.approvedAt.toISOString(),
          correo: mask(a.correo),
          via: a.linkId ? 'correo' : 'sesion',
        })),
        objections: objectionViews(row.id),
        changes: (row.changeSummary as RuleChangeLine[] | null) ?? null,
        basedOn: base ? { id: base.id, version: base.version, objections: objectionViews(base.id) } : null,
        missing: OPEN.includes(row.status)
          ? partners.filter((p) => !answered.has(p.memberId)).map(({ memberId, name }) => ({ memberId, name }))
          : [],
      };
    });
  }
}

/** "Ana", "Ana y Beto", "Ana, Beto y Carla". */
export function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} y ${names.at(-1)}`;
}

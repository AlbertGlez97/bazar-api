import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { createServerId } from '../common/server-id.js';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { EmailService } from '../email/email.service.js';
import {
  configHash,
  parseRulesConfig,
  rulesWarnings,
  type FinanceRulesConfig,
  type RulesWarning,
} from './finance-rules.config.js';

type Actor = Pick<AuthenticatedRequest, 'account' | 'selection'>;
type Tx = Prisma.TransactionClient;

/** A partner can be reminded again only after this long. */
export const REMINDER_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export const RULES_DISCLAIMER =
  'Esta herramienta ayuda a organizar el reparto. No es asesoría contable ni legal. Conviene validar las reglas con un contador.';

export const SHARED_LOGIN_MESSAGE =
  'Tu acceso es compartido con otros socios. Por eso no podemos saber quién aprueba. Cada socio necesita su propia cuenta para aprobar.';

const fail = (Type: new (r: object) => Error, code: string, message: string) =>
  new Type({ code, message });

interface RuleSetRow {
  id: string;
  version: number;
  status: string;
  config: unknown;
  configHash: string;
  proposedByMemberId: string;
  createdAt: Date;
  submittedAt: Date | null;
  activatedAt: Date | null;
  supersededAt: Date | null;
  withdrawnAt: Date | null;
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
  activatedAt: string | null;
  supersededAt: string | null;
  withdrawnAt: string | null;
  approvals: { memberId: string; name: string; approvedAt: string }[];
  /** Active partners who have not approved yet (only meaningful while pending). */
  missing: { memberId: string; name: string }[];
}

const iso = (date: Date | null) => (date ? date.toISOString() : null);

@Injectable()
export class FinanceRulesService {
  private readonly logger = new Logger(FinanceRulesService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(EmailService) private readonly email: EmailService,
  ) {}

  // ───────────────────────── reading ─────────────────────────

  async overview(actor: Actor) {
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
    const pending = views.find((v) => v.status === 'pendiente') ?? null;
    const draft = views.find((v) => v.status === 'borrador') ?? null;
    const eligibility = this.eligibility(actor, partners);
    const lastReminder = pending
      ? await this.prisma.financeRuleReminder.findFirst({
          where: { contextId, ruleSetId: pending.id, memberId: me },
          orderBy: { sentAt: 'desc' },
        })
      : null;
    return {
      state: pending ? 'pendiente' : inForce ? 'vigente' : 'sin_aprobar',
      inForce,
      pending,
      draft,
      history: views.filter((v) => v.status !== 'borrador'),
      partners,
      me: {
        memberId: me,
        canApprove: eligibility.canApprove,
        cannotApproveReason: eligibility.reason,
        hasApproved: !!pending?.approvals.some((a) => a.memberId === me),
        isProposer: pending?.proposedBy.memberId === me,
        reminderReceivedAt: iso(lastReminder?.sentAt ?? null),
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
          proposedByMemberId: me,
          proposedByAccountId: actor.account.id,
        },
      });
      return created.id;
    });
    return this.viewOne(contextId, id);
  }

  async discardDraft(actor: Actor, id: string) {
    const contextId = actor.account.contextId;
    await this.prisma.$transaction(async (tx) => {
      const row = await this.lockRow(tx, contextId, id);
      this.requireStatus(row, 'borrador', 'Solo se puede descartar un borrador.');
      this.requireProposer(row, actor);
      await tx.financeRuleSet.update({
        where: { id },
        data: { status: 'retirada', withdrawnAt: new Date(), updatedAt: new Date() },
      });
    });
    return this.viewOne(contextId, id);
  }

  /** Freezes the draft and asks every active partner to approve it. */
  async submit(actor: Actor, id: string) {
    const contextId = actor.account.contextId;
    await this.prisma.$transaction(async (tx) => {
      await this.lockBusiness(tx, contextId);
      const row = await this.lockRow(tx, contextId, id);
      this.requireStatus(row, 'borrador', 'Solo se puede enviar un borrador.');
      this.requireProposer(row, actor);
      const pending = await tx.financeRuleSet.findFirst({
        where: { contextId, status: 'pendiente' },
      });
      if (pending)
        throw fail(
          ConflictException,
          'FINANCE_RULES_PENDING_EXISTS',
          'Ya hay una propuesta esperando aprobación. Apruébenla o retírenla antes de enviar otra.',
        );
      await tx.financeRuleSet.update({
        where: { id },
        data: { status: 'pendiente', submittedAt: new Date(), updatedAt: new Date() },
      });
    });
    return this.viewOne(contextId, id);
  }

  /** Back to draft, and every approval given so far is erased. */
  async withdraw(actor: Actor, id: string) {
    const contextId = actor.account.contextId;
    await this.prisma.$transaction(async (tx) => {
      const row = await this.lockRow(tx, contextId, id);
      this.requireStatus(row, 'pendiente', 'Solo se puede retirar una propuesta pendiente.');
      this.requireProposer(row, actor);
      const other = await tx.financeRuleSet.findFirst({
        where: { contextId, status: 'borrador' },
      });
      if (other)
        throw fail(
          ConflictException,
          'FINANCE_RULES_DRAFT_EXISTS',
          'Ya existe otro borrador abierto. Envíalo o descártalo antes de retirar esta propuesta.',
        );
      await tx.financeRuleSet.update({
        where: { id },
        data: { status: 'borrador', submittedAt: null, updatedAt: new Date() },
      });
      await tx.financeRuleApproval.deleteMany({
        where: { contextId, ruleSetId: id },
      });
    });
    return this.viewOne(contextId, id);
  }

  /**
   * Records the caller's approval. The row lock serializes concurrent approvals,
   * so the last one activates the rules exactly once. Repeating it is harmless.
   */
  async approve(actor: Actor, id: string) {
    const contextId = actor.account.contextId;
    const me = actor.selection!.memberId;
    await this.prisma.$transaction(async (tx) => {
      const row = await this.lockRow(tx, contextId, id);
      const partners = await this.activePartners(tx, contextId);
      const already = await tx.financeRuleApproval.findFirst({
        where: { contextId, ruleSetId: id, memberId: me },
      });
      if (row.status === 'vigente' && already) return;
      this.requireStatus(row, 'pendiente', 'Esta propuesta ya no espera aprobación.');
      const eligibility = this.eligibility(actor, partners);
      if (!eligibility.canApprove)
        throw fail(ForbiddenException, 'FINANCE_RULES_SHARED_LOGIN', eligibility.reason!);
      if (!already)
        await tx.financeRuleApproval.create({
          data: {
            id: createServerId(),
            contextId,
            ruleSetId: id,
            memberId: me,
            approvedByAccountId: actor.account.id,
            approvedHash: row.configHash,
          },
        });
      const approved = await tx.financeRuleApproval.findMany({
        where: { contextId, ruleSetId: id },
        select: { memberId: true },
      });
      const done = new Set(approved.map((a) => a.memberId));
      if (!partners.every((p) => done.has(p.memberId))) return;
      const now = new Date();
      await tx.financeRuleSet.updateMany({
        where: { contextId, status: 'vigente' },
        data: { status: 'reemplazada', supersededAt: now, updatedAt: now },
      });
      await tx.financeRuleSet.update({
        where: { id },
        data: { status: 'vigente', activatedAt: now, updatedAt: now },
      });
    });
    return this.viewOne(contextId, id);
  }

  /** Reminds every partner still missing, at most once per partner every 24 hours. */
  async remind(actor: Actor, id: string, now = new Date()) {
    const contextId = actor.account.contextId;
    const sender = actor.selection!.memberId;
    const plan = await this.prisma.$transaction(async (tx) => {
      const row = await this.lockRow(tx, contextId, id);
      this.requireStatus(row, 'pendiente', 'Solo se recuerda una propuesta pendiente.');
      this.requireProposer(row, actor);
      const partners = await this.activePartners(tx, contextId);
      const approved = new Set(
        (
          await tx.financeRuleApproval.findMany({
            where: { contextId, ruleSetId: id },
          })
        ).map((a) => a.memberId),
      );
      const reminded: { memberId: string; name: string; reminderId: string }[] = [];
      const skipped: { memberId: string; name: string; nextAt: string }[] = [];
      for (const partner of partners.filter((p) => !approved.has(p.memberId))) {
        const last = await tx.financeRuleReminder.findFirst({
          where: { contextId, ruleSetId: id, memberId: partner.memberId },
          orderBy: { sentAt: 'desc' },
        });
        if (last && now.getTime() - last.sentAt.getTime() < REMINDER_COOLDOWN_MS) {
          skipped.push({
            ...partner,
            nextAt: new Date(last.sentAt.getTime() + REMINDER_COOLDOWN_MS).toISOString(),
          });
          continue;
        }
        const reminderId = createServerId();
        await tx.financeRuleReminder.create({
          data: {
            id: reminderId,
            contextId,
            ruleSetId: id,
            memberId: partner.memberId,
            sentByMemberId: sender,
            sentAt: now,
          },
        });
        reminded.push({ ...partner, reminderId });
      }
      const proposer = await tx.member.findFirst({
        where: { id: sender, contextId },
      });
      return { reminded, skipped, proposerName: proposer?.name ?? 'Un socio' };
    });
    const emailed = await this.sendEmails(contextId, plan.reminded, plan.proposerName);
    return {
      reminded: plan.reminded.map(({ memberId, name }) => ({
        memberId,
        name,
        emailSent: emailed.has(memberId),
      })),
      skipped: plan.skipped,
    };
  }

  // ───────────────────────── helpers ─────────────────────────

  /** One writer at a time per business for version numbers and the single draft/pending slots. */
  private lockBusiness(tx: Tx, contextId: string) {
    return tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'finance-rules:' + contextId}, 0))`;
  }

  private async lockRow(tx: Tx, contextId: string, id: string) {
    const rows = await tx.$queryRaw<
      { id: string; status: string; configHash: string; proposedByMemberId: string }[]
    >`SELECT "id", "status", "configHash", "proposedByMemberId" FROM "FinanceRuleSet"
      WHERE "id" = ${id}::uuid AND "contextId" = ${contextId} FOR UPDATE`;
    if (!rows.length)
      throw fail(NotFoundException, 'FINANCE_RULES_NOT_FOUND', 'No encontramos esas reglas.');
    return rows[0]!;
  }

  private requireStatus(row: { status: string }, expected: string, message: string) {
    if (row.status !== expected)
      throw fail(ConflictException, 'FINANCE_RULES_WRONG_STATE', message);
  }

  private requireProposer(row: { proposedByMemberId: string }, actor: Actor) {
    if (row.proposedByMemberId !== actor.selection!.memberId)
      throw fail(
        ForbiddenException,
        'FINANCE_RULES_NOT_PROPOSER',
        'Solo el socio que creó esta propuesta puede hacer esto.',
      );
  }

  private async activePartners(client: Tx | PrismaService, contextId: string) {
    const members = await client.member.findMany({
      where: { contextId, role: 'socio', active: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return members.map((m) => ({ memberId: m.id, name: m.name }));
  }

  /**
   * Approving needs a login that belongs to the partner. A shared login may
   * approve only when there is a single partner, so nobody approves for another.
   */
  private eligibility(actor: Actor, partners: { memberId: string }[]) {
    const me = actor.selection!.memberId;
    if (!partners.some((p) => p.memberId === me))
      return { canApprove: false, reason: 'Solo los socios activos pueden aprobar.' };
    const bound = actor.account.memberId;
    if (bound === me) return { canApprove: true, reason: null };
    if (bound === null && partners.length === 1) return { canApprove: true, reason: null };
    return { canApprove: false, reason: SHARED_LOGIN_MESSAGE };
  }

  private async sendEmails(
    contextId: string,
    reminded: { memberId: string; name: string; reminderId: string }[],
    proposerName: string,
  ) {
    const sent = new Set<string>();
    if (!reminded.length) return sent;
    const business = (await this.businessName(contextId)) ?? 'tu negocio';
    const accounts = await this.prisma.account.findMany({
      where: { contextId, memberId: { in: reminded.map((r) => r.memberId) }, active: true },
    });
    for (const target of reminded) {
      const to = accounts.find((a) => a.memberId === target.memberId)?.username;
      if (!to || !/^[^\s@]+@[^\s@]+$/.test(to)) continue;
      try {
        await this.email.sendFinanceRulesReminderEmail({
          to,
          memberName: target.name,
          proposerName,
          businessName: business,
        });
        await this.prisma.financeRuleReminder.update({
          where: { id: target.reminderId },
          data: { emailSent: true },
        });
        sent.add(target.memberId);
      } catch (error) {
        // The in-app notice already exists; a failed email never blocks the reminder.
        this.logger.warn(
          `Finance rules reminder email failed: ${error instanceof Error ? error.name : 'error'}`,
        );
      }
    }
    return sent;
  }

  private async businessName(contextId: string): Promise<string | null> {
    const rows = await this.prisma.$queryRaw<{ name: string | null }[]>`
      SELECT "nombreNegocio" AS name FROM "BusinessRegistrationRequest"
      WHERE "createdContextId" = ${contextId} ORDER BY "createdAt" DESC LIMIT 1`;
    return rows[0]?.name ?? null;
  }

  private async viewOne(contextId: string, id: string): Promise<RuleSetView> {
    const row = await this.prisma.financeRuleSet.findFirst({ where: { id, contextId } });
    const partners = await this.activePartners(this.prisma, contextId);
    return (await this.toViews(contextId, [row as RuleSetRow], partners))[0]!;
  }

  private async toViews(
    contextId: string,
    rows: RuleSetRow[],
    partners: { memberId: string; name: string }[],
  ): Promise<RuleSetView[]> {
    if (!rows.length) return [];
    const approvals = await this.prisma.financeRuleApproval.findMany({
      where: { contextId, ruleSetId: { in: rows.map((r) => r.id) } },
      orderBy: { approvedAt: 'asc' },
    });
    const ids = new Set<string>([
      ...rows.map((r) => r.proposedByMemberId),
      ...approvals.map((a) => a.memberId),
    ]);
    const names = new Map(
      (await this.prisma.member.findMany({ where: { contextId, id: { in: [...ids] } } })).map(
        (m) => [m.id, m.name] as const,
      ),
    );
    return rows.map((row) => {
      const mine = approvals.filter((a) => a.ruleSetId === row.id);
      const done = new Set(mine.map((a) => a.memberId));
      const config = row.config as FinanceRulesConfig;
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
        activatedAt: iso(row.activatedAt),
        supersededAt: iso(row.supersededAt),
        withdrawnAt: iso(row.withdrawnAt),
        approvals: mine.map((a) => ({
          memberId: a.memberId,
          name: names.get(a.memberId) ?? 'Socio',
          approvedAt: a.approvedAt.toISOString(),
        })),
        missing:
          row.status === 'pendiente'
            ? partners.filter((p) => !done.has(p.memberId))
            : [],
      };
    });
  }
}

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { isUUID } from 'class-validator';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { canonicalDigest } from '../common/canonical-json.js';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { UUID_V7 } from './contribution.dto.js';
import type {
  CreateDistributionAgreementDto,
  DistributionAgreementListDto,
  ReverseDistributionAgreementDto,
} from './finance-agreements.dto.js';
import {
  buildAgreementDocument,
  folioYear,
  formatFolio,
  type SimulationShape,
} from './finance-agreements.snapshot.js';
import {
  commitmentOf,
  exceedsMessage,
} from './finance-agreements.commitment.js';
import { loadPaymentSummary } from './finance-payments.summary.js';
import { FinanceDistributionService } from './finance-distribution.service.js';
import type { FinanceOverviewDto } from './finance-overview.dto.js';
import { isCalendarDate } from './work-shift.dto.js';

type Actor = Pick<AuthenticatedRequest, 'account' | 'selection'>;

export const AGREEMENT_ERRORS = {
  idConflict: 'FINANCE_AGREEMENT_ID_CONFLICT',
  simulationChanged: 'FINANCE_AGREEMENT_SIMULATION_CHANGED',
  replacementInvalid: 'FINANCE_AGREEMENT_REPLACEMENT_INVALID',
  alreadyVoided: 'FINANCE_AGREEMENT_ALREADY_VOIDED',
  busy: 'FINANCE_AGREEMENT_BUSY',
  reversalTimeInvalid: 'FINANCE_AGREEMENT_REVERSAL_TIME_INVALID',
  exceedsUncommitted: 'FINANCE_AGREEMENT_EXCEEDS_UNCOMMITTED',
} as const;

export const MAX_CREATE_ATTEMPTS = 5;

const date = (value: string) => new Date(value + 'T00:00:00.000Z');
const isoDate = (value: Date) => value.toISOString().slice(0, 10);

/** Serialization failures and deadlocks are safe to retry from the start. */
export function isRetryableTransactionError(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) {
    const message = error instanceof Error ? error.message : '';
    return /could not serialize access|deadlock detected/i.test(message);
  }
  if (error.code === 'P2034') return true;
  const meta = JSON.stringify(error.meta ?? {});
  return (
    /"(40001|40P01)"/.test(meta) ||
    /could not serialize access|deadlock detected/i.test(error.message)
  );
}

const isUniqueViolation = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === 'P2002';

const wait = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Re-runs the WHOLE unit (re-simulation and drift check included) when a
 * concurrent writer made the snapshot stale. Bounded, with a small jittered
 * backoff; when attempts run out the last cause decides the error.
 */
export async function runWithRetry<T>(
  unit: () => Promise<T>,
  options: {
    attempts?: number;
    sleep?: (ms: number) => Promise<void>;
    random?: () => number;
  } = {},
): Promise<T> {
  const attempts = options.attempts ?? MAX_CREATE_ATTEMPTS;
  const sleep = options.sleep ?? wait;
  const random = options.random ?? Math.random;
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await unit();
    } catch (error) {
      if (!isRetryableTransactionError(error) && !isUniqueViolation(error))
        throw error;
      last = error;
      if (attempt < attempts)
        await sleep(Math.round(10 * attempt + random() * 40 * attempt));
    }
  }
  // A unique violation that survives fresh snapshots is an invisible global id
  // collision (RLS): it discloses nothing and is reported as not found.
  if (isUniqueViolation(last))
    throw new NotFoundException('Agreement not found');
  throw new ServiceUnavailableException({
    code: AGREEMENT_ERRORS.busy,
    message:
      'The agreement could not be created because of concurrent activity. Try again.',
  });
}

function normalized(dto: CreateDistributionAgreementDto) {
  return {
    id: dto.id.toLowerCase(),
    from: dto.from,
    to: dto.to,
    requestedAmountMinor: dto.requestedAmountMinor,
    partnerShareBps: dto.partnerShareBps,
    workShareBps: dto.workShareBps,
    workBasis: dto.workBasis,
    title: dto.title.trim(),
    note: dto.note === undefined || dto.note === null ? null : dto.note.trim(),
    replacesAgreementId: dto.replacesAgreementId
      ? dto.replacesAgreementId.toLowerCase()
      : null,
    simulationFingerprint: dto.simulationFingerprint,
    createdByMemberId: dto.createdByMemberId.toLowerCase(),
    deviceId: dto.deviceId.toLowerCase(),
    occurredAt: new Date(dto.occurredAt).toISOString(),
  };
}

const reversalProjection = (reversal: {
  id: string;
  agreementId: string;
  reason: string;
  occurredAt: Date;
  receivedAt: Date;
  createdByMemberId: string;
  createdByAccountId: string;
  deviceId: string;
}) => ({
  id: reversal.id,
  agreementId: reversal.agreementId,
  reason: reversal.reason,
  occurredAt: reversal.occurredAt.toISOString(),
  receivedAt: reversal.receivedAt.toISOString(),
  createdByMemberId: reversal.createdByMemberId,
  createdByAccountId: reversal.createdByAccountId,
  deviceId: reversal.deviceId,
});

const reversalSelect = {
  id: true,
  agreementId: true,
  reason: true,
  occurredAt: true,
  receivedAt: true,
  createdByMemberId: true,
  createdByAccountId: true,
  deviceId: true,
} as const;

const liveDocumentSelect = {
  creationResponse: true,
  reversal: { select: reversalSelect },
  replacedBy: { select: { id: true, folio: true } },
} as const;

/** Overlay live lifecycle facts without changing the immutable document hash. */
function liveDocument(
  row: Prisma.DistributionAgreementGetPayload<{
    select: typeof liveDocumentSelect;
  }>,
) {
  return {
    ...(row.creationResponse as Record<string, unknown>),
    status: row.reversal ? 'voided' : 'active',
    reversal: row.reversal ? reversalProjection(row.reversal) : null,
    replacedBy: row.replacedBy ?? null,
  };
}

@Injectable()
export class FinanceAgreementsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(FinanceDistributionService)
    private readonly distribution: FinanceDistributionService,
  ) {}

  // Creations of one context queue up inside this process so they do not fight
  // over the folio counter; the retry above remains the cross-process guarantee.
  private readonly createQueues = new Map<string, Promise<unknown>>();

  private serialized<T>(key: string, unit: () => Promise<T>): Promise<T> {
    const previous = this.createQueues.get(key) ?? Promise.resolve();
    const run = previous.then(unit, unit);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.createQueues.set(key, tail);
    void tail.then(() => {
      if (this.createQueues.get(key) === tail) this.createQueues.delete(key);
    });
    return run;
  }

  assertOrigin(
    actor: Actor,
    dto: { createdByMemberId: string; deviceId: string },
  ) {
    if (
      dto.createdByMemberId.toLowerCase() !== actor.selection?.memberId ||
      dto.deviceId.toLowerCase() !== actor.selection?.deviceId
    )
      throw new ForbiddenException(
        'Operation origin does not match the selected member and device',
      );
  }

  /** Re-checks, under FOR SHARE locks, that the origin is still authorized. */
  async authorize(
    tx: Prisma.TransactionClient,
    actor: Actor,
  ): Promise<{ memberName: string }> {
    const contextId = actor.account.contextId;
    const accounts = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM "Account" WHERE id = ${actor.account.id}::uuid AND "contextId" = ${contextId} AND active = true AND ("memberId" IS NULL OR "memberId" = ${actor.selection!.memberId}::uuid) FOR SHARE`;
    const members = await tx.$queryRaw<
      { id: string; name: string }[]
    >`SELECT id, name FROM "Member" WHERE id = ${actor.selection!.memberId}::uuid AND "contextId" = ${contextId} AND active = true AND role = 'socio' FOR SHARE`;
    const devices = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM "Device" WHERE id = ${actor.selection!.deviceId}::uuid AND "contextId" = ${contextId} AND authorized = true FOR SHARE`;
    if (!accounts.length || !members.length || !devices.length)
      throw new ForbiddenException('Operation origin is no longer authorized');
    return { memberName: members[0].name };
  }

  async create(actor: Actor, dto: CreateDistributionAgreementDto) {
    this.assertOrigin(actor, dto);
    if (
      !isCalendarDate(dto.from) ||
      !isCalendarDate(dto.to) ||
      dto.from >= dto.to
    )
      throw new BadRequestException('Invalid agreement period');
    const contextId = actor.account.contextId;
    const data = normalized(dto);
    const requestFingerprint = canonicalDigest({
      contextId,
      accountId: actor.account.id,
      operation: 'create',
      ...data,
    });
    return this.serialized(contextId, () =>
      runWithRetry(() =>
        this.prisma.$transaction(
          (tx) => this.createInTx(tx, actor, data, requestFingerprint),
          { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
        ),
      ),
    );
  }

  private async createInTx(
    tx: Prisma.TransactionClient,
    actor: Actor,
    data: ReturnType<typeof normalized>,
    requestFingerprint: string,
  ) {
    const contextId = actor.account.contextId;
    const { memberName } = await this.authorize(tx, actor);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`distribution-agreement:identity:${contextId}:${data.id}`}, 0))`;
    // Replay comes first: it must not depend on current data nor consume a folio.
    const existing = await tx.distributionAgreement.findFirst({
      where: { contextId, id: data.id },
      select: { requestFingerprint: true, ...liveDocumentSelect },
    });
    if (existing) {
      if (existing.requestFingerprint !== requestFingerprint)
        throw new ConflictException({
          code: AGREEMENT_ERRORS.idConflict,
          message: 'Agreement ID already has different content',
        });
      return { created: false as const, receipt: liveDocument(existing) };
    }

    const replacesAgreement = data.replacesAgreementId
      ? await this.validateReplacement(
          tx,
          contextId,
          data.id,
          data.replacesAgreementId,
        )
      : null;

    // Domain errors of the simulator (422) propagate unchanged.
    const simulation: SimulationShape = await this.distribution.simulateInTx(
      tx,
      contextId,
      {
        from: data.from,
        to: data.to,
        requestedAmountMinor: data.requestedAmountMinor,
        partnerShareBps: data.partnerShareBps,
        workShareBps: data.workShareBps,
        workBasis: data.workBasis,
      },
    );
    if (simulation.simulationFingerprint !== data.simulationFingerprint)
      throw new ConflictException({
        code: AGREEMENT_ERRORS.simulationChanged,
        message:
          'The data changed since this simulation was calculated. Simulate again before creating the agreement.',
        currentSimulationFingerprint: simulation.simulationFingerprint,
      });

    // The same available money cannot be agreed twice. Two creations racing for it
    // both touch the folio counter row below, so under REPEATABLE READ the loser fails
    // with 40001 and is retried from the start, where this check sees the winner.
    const commitment = commitmentOf(
      simulation.financialBase.potentiallyAvailableMinor,
      (await this.committedInTx(tx, contextId, data.from, data.to))
        .committedMinor,
    );
    if (data.requestedAmountMinor > commitment.freeMinor)
      throw new UnprocessableEntityException({
        code: AGREEMENT_ERRORS.exceedsUncommitted,
        message: exceedsMessage(commitment, data.requestedAmountMinor),
        ...commitment,
        requestedMinor: data.requestedAmountMinor,
        missingMinor: data.requestedAmountMinor - commitment.freeMinor,
      });

    const receivedAt = new Date();
    const year = folioYear(receivedAt);
    // Atomic, gapless allocation: a rollback releases the increment, and a
    // concurrent writer makes this statement fail with 40001 (retried above).
    const counter = await tx.$queryRaw<
      { lastNumber: number }[]
    >`INSERT INTO "DistributionAgreementCounter" ("contextId", "year", "lastNumber") VALUES (${contextId}, ${year}, 1) ON CONFLICT ("contextId", "year") DO UPDATE SET "lastNumber" = "DistributionAgreementCounter"."lastNumber" + 1 RETURNING "lastNumber"`;
    const folio = formatFolio(year, counter[0].lastNumber);

    const document = buildAgreementDocument({
      contextId,
      id: data.id,
      folio,
      title: data.title,
      note: data.note,
      replacesAgreement,
      occurredAt: new Date(data.occurredAt),
      receivedAt,
      createdBy: {
        memberId: data.createdByMemberId,
        name: memberName,
        accountId: actor.account.id,
        deviceId: data.deviceId,
      },
      simulation,
    });

    await tx.distributionAgreement.create({
      data: {
        id: data.id,
        contextId,
        folio,
        periodFrom: date(data.from),
        periodTo: date(data.to),
        requestedAmountMinor: data.requestedAmountMinor,
        partnerShareBps: data.partnerShareBps,
        workShareBps: data.workShareBps,
        workBasis: data.workBasis,
        partnerMode: 'EQUAL',
        currency: 'MXN',
        financialStatus: simulation.financialBase.status,
        potentiallyAvailableMinor:
          simulation.financialBase.potentiallyAvailableMinor,
        partnerPoolMinor: (simulation.pools as { partnerPoolMinor: number })
          .partnerPoolMinor,
        workPoolMinor: (simulation.pools as { workPoolMinor: number })
          .workPoolMinor,
        distributedMinor: (simulation.totals as { distributedMinor: number })
          .distributedMinor,
        undistributedMinor: (
          simulation.totals as { undistributedMinor: number }
        ).undistributedMinor,
        algorithmVersion: document.algorithmVersion,
        title: data.title,
        note: data.note,
        replacesAgreementId: data.replacesAgreementId,
        createdByMemberId: data.createdByMemberId,
        createdByMemberName: memberName,
        createdByAccountId: actor.account.id,
        deviceId: data.deviceId,
        occurredAt: new Date(data.occurredAt),
        receivedAt,
        requestFingerprint,
        snapshotFingerprint: document.snapshotFingerprint,
        warningsSnapshot: document.warnings as Prisma.InputJsonValue,
        creationResponse: document as unknown as Prisma.InputJsonValue,
      },
    });
    await tx.distributionAgreementParticipant.createMany({
      data: (
        simulation.members as {
          memberId: string;
          name: string;
          role: string;
          isActive: boolean;
          partnerEligible: boolean;
          partnerAmountMinor: number;
          workUnits: number;
          shiftCount: number;
          knownMinutes: number;
          unknownDurationCount: number;
          workAmountMinor: number;
          totalMinor: number;
        }[]
      ).map((member) => ({
        agreementId: data.id,
        contextId,
        memberId: member.memberId,
        memberName: member.name,
        role: member.role,
        isActive: member.isActive,
        partnerEligible: member.partnerEligible,
        partnerAmountMinor: member.partnerAmountMinor,
        workUnits: member.workUnits,
        shiftCount: member.shiftCount,
        knownMinutes: member.knownMinutes,
        unknownDurationCount: member.unknownDurationCount,
        workAmountMinor: member.workAmountMinor,
        totalMinor: member.totalMinor,
      })),
    });
    return { created: true as const, receipt: document };
  }

  /** A replacement must target an existing, voided, not yet replaced agreement. */
  private async validateReplacement(
    tx: Prisma.TransactionClient,
    contextId: string,
    newId: string,
    replacesId: string,
  ) {
    const target =
      replacesId === newId
        ? null
        : await tx.distributionAgreement.findFirst({
            where: { id: replacesId, contextId },
            select: {
              id: true,
              folio: true,
              reversal: { select: { id: true } },
              replacedBy: { select: { id: true } },
            },
          });
    if (!target || !target.reversal || target.replacedBy)
      throw new UnprocessableEntityException({
        code: AGREEMENT_ERRORS.replacementInvalid,
        message:
          'The agreement to replace must exist, be voided and not already replaced',
      });
    return { id: target.id, folio: target.folio };
  }

  async reverse(
    actor: Actor,
    agreementId: string,
    dto: ReverseDistributionAgreementDto,
  ) {
    this.assertOrigin(actor, dto);
    const contextId = actor.account.contextId;
    const id = dto.id.toLowerCase();
    const targetId = agreementId.toLowerCase();
    if (id === targetId)
      throw new BadRequestException(
        'Reversal and agreement identities must be distinct',
      );
    const data = {
      id,
      agreementId: targetId,
      reason: dto.reason.trim(),
      occurredAt: new Date(dto.occurredAt).toISOString(),
      createdByMemberId: dto.createdByMemberId.toLowerCase(),
      deviceId: dto.deviceId.toLowerCase(),
    };
    const requestFingerprint = canonicalDigest({
      contextId,
      accountId: actor.account.id,
      operation: 'reverse',
      ...data,
    });
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.authorize(tx, actor);
        // Same identity namespace as create; sorted locks avoid lock cycles.
        for (const identity of [id, targetId].sort())
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`distribution-agreement:identity:${contextId}:${identity}`}, 0))`;
        const existing = await tx.distributionAgreementReversal.findFirst({
          where: { id, contextId },
        });
        if (existing) {
          if (existing.requestFingerprint !== requestFingerprint)
            throw new ConflictException({
              code: AGREEMENT_ERRORS.idConflict,
              message: 'Reversal ID already has different content',
            });
          return { created: false, receipt: existing.creationResponse };
        }
        const locked = await tx.$queryRaw<
          { id: string }[]
        >`SELECT id FROM "DistributionAgreement" WHERE id = ${targetId}::uuid AND "contextId" = ${contextId} FOR UPDATE`;
        if (!locked.length) throw new NotFoundException('Agreement not found');
        const original = await tx.distributionAgreement.findFirstOrThrow({
          where: { id: targetId, contextId },
          include: { reversal: { select: { id: true } } },
        });
        if (original.reversal)
          throw new ConflictException({
            code: AGREEMENT_ERRORS.alreadyVoided,
            message: 'Agreement is already voided',
          });
        const receivedAt = new Date();
        const occurredAt = new Date(data.occurredAt);
        if (occurredAt < original.occurredAt || occurredAt > receivedAt)
          throw new UnprocessableEntityException({
            code: AGREEMENT_ERRORS.reversalTimeInvalid,
            message:
              'Reversal time must be on or after the agreement time and not in the future',
          });
        const receipt = {
          ...data,
          contextId,
          createdByAccountId: actor.account.id,
          receivedAt: receivedAt.toISOString(),
          original: original.creationResponse,
        };
        await tx.distributionAgreementReversal.create({
          data: {
            ...data,
            contextId,
            createdByAccountId: actor.account.id,
            occurredAt: new Date(data.occurredAt),
            receivedAt,
            requestFingerprint,
            creationResponse: receipt as Prisma.InputJsonValue,
          },
        });
        return { created: true, receipt };
      });
    } catch (error) {
      // An invisible global reversal ID collision never exposes its receipt.
      if (isUniqueViolation(error))
        throw new NotFoundException('Agreement not found');
      throw error;
    }
  }

  /** The frozen document of record plus the live status projection. */
  async findOne(contextId: string, id: string) {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.distributionAgreement.findFirst({
        where: { id: id.toLowerCase(), contextId },
        select: liveDocumentSelect,
      });
      if (!row) throw new NotFoundException('Agreement not found');
      // Live payments overlay; the immutable creation receipt never carries it.
      return {
        ...liveDocument(row),
        paymentSummary: await loadPaymentSummary(
          tx,
          contextId,
          id.toLowerCase(),
        ),
      };
    });
  }

  /** What the live (not voided) agreements of this exact period already distribute. */
  private async committedInTx(
    tx: Prisma.TransactionClient,
    contextId: string,
    from: string,
    to: string,
  ) {
    const live = await tx.distributionAgreement.aggregate({
      where: {
        contextId,
        periodFrom: date(from),
        periodTo: date(to),
        reversal: { is: null },
      },
      _sum: { distributedMinor: true },
      _count: { _all: true },
    });
    return {
      committedMinor: live._sum.distributedMinor ?? 0,
      agreementCount: live._count._all,
    };
  }

  /**
   * Available / committed / free for one exact period, read in one snapshot. It is
   * only a notice for the screen that creates an agreement; creation checks again.
   */
  async commitment(contextId: string, query: FinanceOverviewDto) {
    const { from, to } = query;
    if (!isCalendarDate(from) || !isCalendarDate(to) || from >= to)
      throw new BadRequestException(
        'from and to must be valid YYYY-MM-DD dates with from preceding to',
      );
    return this.prisma.$transaction(
      async (tx) => {
        const available = await this.distribution.availableInTx(
          tx,
          contextId,
          from,
          to,
        );
        const committed = await this.committedInTx(tx, contextId, from, to);
        return {
          from,
          to,
          ...commitmentOf(available, committed.committedMinor),
          agreementCount: committed.agreementCount,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  async list(contextId: string, query: DistributionAgreementListDto) {
    const { from, to, status, folio, limit } = query;
    if (
      (from !== undefined || to !== undefined) &&
      (!isCalendarDate(from) || !isCalendarDate(to) || from >= to)
    )
      throw new BadRequestException(
        'Both exact-period dates are required with from preceding to',
      );
    const scope = canonicalDigest({
      contextId,
      from: from ?? null,
      to: to ?? null,
      status,
      folio: folio ?? null,
    });
    let cursor: { id: string; receivedAt: Date } | undefined;
    if (query.cursor) {
      try {
        if (!/^[A-Za-z0-9_-]+$/.test(query.cursor))
          throw new Error('Invalid cursor');
        const raw = Buffer.from(query.cursor, 'base64url');
        if (raw.toString('base64url') !== query.cursor)
          throw new Error('Invalid cursor');
        const decoded = JSON.parse(raw.toString('utf8')) as {
          version: unknown;
          scope: unknown;
          id: unknown;
          receivedAt: unknown;
        };
        if (
          decoded.version !== 1 ||
          decoded.scope !== scope ||
          typeof decoded.id !== 'string' ||
          !isUUID(decoded.id) ||
          !UUID_V7.test(decoded.id) ||
          typeof decoded.receivedAt !== 'string' ||
          new Date(decoded.receivedAt).toISOString() !== decoded.receivedAt
        )
          throw new Error('Invalid cursor');
        cursor = { id: decoded.id, receivedAt: new Date(decoded.receivedAt) };
      } catch {
        throw new BadRequestException(
          'Invalid cursor for this context and filter',
        );
      }
    }
    const rows = await this.prisma.distributionAgreement.findMany({
      where: {
        contextId,
        ...(from && to ? { periodFrom: date(from), periodTo: date(to) } : {}),
        ...(folio ? { folio } : {}),
        reversal: status === 'voided' ? { isNot: null } : { is: null },
        ...(cursor
          ? {
              OR: [
                { receivedAt: { lt: cursor.receivedAt } },
                { receivedAt: cursor.receivedAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: {
        id: true,
        folio: true,
        title: true,
        note: true,
        periodFrom: true,
        periodTo: true,
        requestedAmountMinor: true,
        partnerShareBps: true,
        workShareBps: true,
        workBasis: true,
        financialStatus: true,
        distributedMinor: true,
        occurredAt: true,
        receivedAt: true,
        replacesAgreement: { select: { id: true, folio: true } },
        reversal: { select: { occurredAt: true } },
        _count: { select: { participants: true } },
      },
    });
    const items = rows.slice(0, limit).map((row) => ({
      id: row.id,
      folio: row.folio,
      status: row.reversal ? 'voided' : 'active',
      title: row.title,
      note: row.note,
      from: isoDate(row.periodFrom),
      to: isoDate(row.periodTo),
      requestedAmountMinor: row.requestedAmountMinor,
      partnerShareBps: row.partnerShareBps,
      workShareBps: row.workShareBps,
      workBasis: row.workBasis,
      financialStatus: row.financialStatus,
      distributedMinor: row.distributedMinor,
      participantCount: row._count.participants,
      occurredAt: row.occurredAt.toISOString(),
      receivedAt: row.receivedAt.toISOString(),
      replacesAgreement: row.replacesAgreement,
      voidedAt: row.reversal ? row.reversal.occurredAt.toISOString() : null,
    }));
    const last = items.at(-1);
    const nextCursor =
      rows.length > limit && last
        ? Buffer.from(
            JSON.stringify({
              version: 1,
              scope,
              receivedAt: last.receivedAt,
              id: last.id,
            }),
          ).toString('base64url')
        : null;
    return { items, nextCursor };
  }
}

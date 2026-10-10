import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { canonicalDigest } from '../common/canonical-json.js';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import type {
  CreateDistributionPaymentDto,
  ReverseDistributionPaymentDto,
} from './finance-payments.dto.js';
import { FinanceAgreementsService } from './finance-agreements.service.js';
import { loadPaymentSummary } from './finance-payments.summary.js';

type Actor = Pick<AuthenticatedRequest, 'account' | 'selection'>;

export const PAYMENT_ERRORS = {
  idConflict: 'FINANCE_PAYMENT_ID_CONFLICT',
  agreementVoided: 'FINANCE_PAYMENT_AGREEMENT_VOIDED',
  alreadyVoided: 'FINANCE_PAYMENT_ALREADY_VOIDED',
  exceedsPending: 'FINANCE_PAYMENT_EXCEEDS_PENDING',
  timeInvalid: 'FINANCE_PAYMENT_TIME_INVALID',
  nothingAgreed: 'FINANCE_PAYMENT_NOTHING_AGREED',
  reversalTimeInvalid: 'FINANCE_PAYMENT_REVERSAL_TIME_INVALID',
} as const;

// Interactive transactions may queue behind a participant row lock.
const TX_OPTIONS = { timeout: 15_000, maxWait: 15_000 } as const;

const isUniqueViolation = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === 'P2002';

interface Origin {
  memberId: string;
  name: string;
  accountId: string;
  deviceId: string;
}

interface PaymentCore {
  id: string;
  contextId: string;
  agreementId: string;
  participantMemberId: string;
  participantName: string;
  amountMinor: number;
  currency: string;
  occurredAt: string;
  receivedAt: string;
  note: string | null;
  createdBy: Origin;
}

interface ReversalCore {
  id: string;
  paymentId: string;
  reason: string;
  occurredAt: string;
  receivedAt: string;
  createdBy: Origin;
}

const liveSelect = {
  creationResponse: true,
  reversal: { select: { creationResponse: true } },
} as const;

type LiveRow = Prisma.DistributionPaymentGetPayload<{
  select: typeof liveSelect;
}>;

/** Frozen receipt core overlaid with the live status; the core never changes. */
function livePayment(row: LiveRow) {
  const core = row.creationResponse as unknown as PaymentCore;
  let reversal: Omit<ReversalCore, 'paymentId'> | null = null;
  if (row.reversal) {
    const { paymentId: _paymentId, ...rest } = row.reversal
      .creationResponse as unknown as ReversalCore;
    reversal = rest;
  }
  return {
    ...core,
    status: row.reversal ? ('voided' as const) : ('active' as const),
    reversal,
  };
}

@Injectable()
export class FinancePaymentsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(FinanceAgreementsService)
    private readonly agreements: FinanceAgreementsService,
  ) {}

  private async receipt(tx: Prisma.TransactionClient, row: LiveRow) {
    const payment = livePayment(row);
    const paymentSummary = await loadPaymentSummary(
      tx,
      payment.contextId,
      payment.agreementId,
    );
    const participantSummary = paymentSummary.participants.find(
      (p) => p.memberId === payment.participantMemberId,
    );
    return { ...payment, participantSummary, paymentSummary };
  }

  /**
   * Lock order (never reversed, so waiters queue instead of deadlocking):
   * advisory(payment id) -> agreement FOR SHARE -> participant FOR UPDATE.
   */
  async create(
    actor: Actor,
    agreementId: string,
    dto: CreateDistributionPaymentDto,
  ) {
    this.agreements.assertOrigin(actor, dto);
    const contextId = actor.account.contextId;
    const data = {
      id: dto.id.toLowerCase(),
      agreementId: agreementId.toLowerCase(),
      participantMemberId: dto.participantMemberId.toLowerCase(),
      amountMinor: dto.amountMinor,
      occurredAt: new Date(dto.occurredAt).toISOString(),
      note:
        dto.note === undefined || dto.note === null ? null : dto.note.trim(),
      createdByMemberId: dto.createdByMemberId.toLowerCase(),
      deviceId: dto.deviceId.toLowerCase(),
    };
    const requestFingerprint = canonicalDigest({
      contextId,
      accountId: actor.account.id,
      operation: 'payment:create',
      ...data,
    });
    try {
      return await this.prisma.$transaction(
        (tx) => this.createInTx(tx, actor, data, requestFingerprint),
        TX_OPTIONS,
      );
    } catch (error) {
      // The id exists in ANOTHER tenant (invisible under RLS): reused id.
      if (isUniqueViolation(error))
        throw new ConflictException({
          code: PAYMENT_ERRORS.idConflict,
          message: 'Payment ID is already in use',
        });
      throw error;
    }
  }

  private async createInTx(
    tx: Prisma.TransactionClient,
    actor: Actor,
    data: {
      id: string;
      agreementId: string;
      participantMemberId: string;
      amountMinor: number;
      occurredAt: string;
      note: string | null;
      createdByMemberId: string;
      deviceId: string;
    },
    requestFingerprint: string,
  ) {
    const contextId = actor.account.contextId;
    const { memberName } = await this.agreements.authorize(tx, actor);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`distribution-payment:identity:${contextId}:${data.id}`}, 0))`;

    // Replay precedes every business rule: an accepted retry stays valid even
    // after the payment filled the balance, was reversed or the agreement voided.
    const existing = await tx.distributionPayment.findFirst({
      where: { id: data.id, contextId },
      select: { requestFingerprint: true, ...liveSelect },
    });
    if (existing) {
      if (existing.requestFingerprint !== requestFingerprint)
        throw new ConflictException({
          code: PAYMENT_ERRORS.idConflict,
          message: 'Payment ID already has different content',
        });
      return {
        created: false as const,
        receipt: await this.receipt(tx, existing),
      };
    }

    // SHARE lock serializes with a concurrent void (which takes FOR UPDATE).
    const locked = await tx.$queryRaw<
      { occurredAt: Date; currency: string }[]
    >`SELECT "occurredAt", "currency" FROM "DistributionAgreement" WHERE id = ${data.agreementId}::uuid AND "contextId" = ${contextId} FOR SHARE`;
    if (!locked.length) throw new NotFoundException('Agreement not found');
    const agreement = locked[0];
    const voided = await tx.distributionAgreementReversal.findFirst({
      where: { agreementId: data.agreementId, contextId },
      select: { id: true },
    });
    if (voided)
      throw new ConflictException({
        code: PAYMENT_ERRORS.agreementVoided,
        message: 'The agreement is voided and cannot receive payments',
      });

    const participant = await tx.distributionAgreementParticipant.findFirst({
      where: {
        agreementId: data.agreementId,
        memberId: data.participantMemberId,
        contextId,
      },
      select: { memberName: true, totalMinor: true },
    });
    if (!participant) throw new NotFoundException('Agreement not found');
    if (participant.totalMinor === 0)
      throw new UnprocessableEntityException({
        code: PAYMENT_ERRORS.nothingAgreed,
        message: 'This participant has nothing agreed to be paid',
      });

    // Serializes every payment and reversal of this participant. READ COMMITTED
    // re-reads committed rows per statement, so the balance below is fresh.
    await tx.$queryRaw`SELECT "memberId" FROM "DistributionAgreementParticipant" WHERE "agreementId" = ${data.agreementId}::uuid AND "memberId" = ${data.participantMemberId}::uuid AND "contextId" = ${contextId} FOR UPDATE`;

    const receivedAt = new Date();
    const occurredAt = new Date(data.occurredAt);
    if (occurredAt < agreement.occurredAt || occurredAt > receivedAt)
      throw new UnprocessableEntityException({
        code: PAYMENT_ERRORS.timeInvalid,
        message:
          'Payment time must be on or after the agreement time and not in the future',
      });

    const paidRows = await tx.$queryRaw<{ paid: bigint }[]>`
      SELECT COALESCE(SUM(p."amountMinor"), 0)::bigint AS paid
      FROM "DistributionPayment" p
      WHERE p."contextId" = ${contextId} AND p."agreementId" = ${data.agreementId}::uuid AND p."participantMemberId" = ${data.participantMemberId}::uuid
        AND NOT EXISTS (SELECT 1 FROM "DistributionPaymentReversal" r WHERE r."paymentId" = p."id" AND r."contextId" = p."contextId")`;
    const agreed = BigInt(participant.totalMinor);
    const paid = paidRows[0].paid;
    if (paid + BigInt(data.amountMinor) > agreed)
      throw new UnprocessableEntityException({
        code: PAYMENT_ERRORS.exceedsPending,
        message: 'The payment exceeds what is pending for this participant',
        agreedMinor: Number(agreed),
        paidMinor: Number(paid),
        pendingMinor: Number(agreed - paid),
      });

    const core: PaymentCore = {
      id: data.id,
      contextId,
      agreementId: data.agreementId,
      participantMemberId: data.participantMemberId,
      participantName: participant.memberName,
      amountMinor: data.amountMinor,
      currency: agreement.currency,
      occurredAt: occurredAt.toISOString(),
      receivedAt: receivedAt.toISOString(),
      note: data.note,
      createdBy: {
        memberId: data.createdByMemberId,
        name: memberName,
        accountId: actor.account.id,
        deviceId: data.deviceId,
      },
    };
    await tx.distributionPayment.create({
      data: {
        id: data.id,
        contextId,
        agreementId: data.agreementId,
        participantMemberId: data.participantMemberId,
        amountMinor: data.amountMinor,
        currency: agreement.currency,
        occurredAt,
        note: data.note,
        createdByMemberId: data.createdByMemberId,
        createdByAccountId: actor.account.id,
        deviceId: data.deviceId,
        receivedAt,
        requestFingerprint,
        creationResponse: core as unknown as Prisma.InputJsonValue,
      },
    });
    const paymentSummary = await loadPaymentSummary(
      tx,
      contextId,
      data.agreementId,
    );
    return {
      created: true as const,
      receipt: {
        ...core,
        status: 'active' as const,
        reversal: null,
        participantSummary: paymentSummary.participants.find(
          (p) => p.memberId === data.participantMemberId,
        ),
        paymentSummary,
      },
    };
  }

  /**
   * Lock order: advisory(reversal id) -> read payment -> participant FOR UPDATE
   * -> payment FOR UPDATE. It never touches the agreement row, so a concurrent
   * void cannot form a cycle with it.
   */
  async reverse(
    actor: Actor,
    paymentId: string,
    dto: ReverseDistributionPaymentDto,
  ) {
    this.agreements.assertOrigin(actor, dto);
    const contextId = actor.account.contextId;
    const id = dto.id.toLowerCase();
    const targetId = paymentId.toLowerCase();
    const data = {
      id,
      paymentId: targetId,
      reason: dto.reason.trim(),
      occurredAt: new Date(dto.occurredAt).toISOString(),
      createdByMemberId: dto.createdByMemberId.toLowerCase(),
      deviceId: dto.deviceId.toLowerCase(),
    };
    const requestFingerprint = canonicalDigest({
      contextId,
      accountId: actor.account.id,
      operation: 'payment:reverse',
      ...data,
    });
    try {
      return await this.prisma.$transaction(async (tx) => {
        const { memberName } = await this.agreements.authorize(tx, actor);
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`distribution-payment-reversal:identity:${contextId}:${id}`}, 0))`;
        const existing = await tx.distributionPaymentReversal.findFirst({
          where: { id, contextId },
          select: { requestFingerprint: true, paymentId: true },
        });
        if (existing) {
          if (existing.requestFingerprint !== requestFingerprint)
            throw new ConflictException({
              code: PAYMENT_ERRORS.idConflict,
              message: 'Reversal ID already has different content',
            });
          const row = await tx.distributionPayment.findFirstOrThrow({
            where: { id: existing.paymentId, contextId },
            select: liveSelect,
          });
          return {
            created: false as const,
            receipt: await this.receipt(tx, row),
          };
        }

        const target = await tx.distributionPayment.findFirst({
          where: { id: targetId, contextId },
          select: {
            agreementId: true,
            participantMemberId: true,
            occurredAt: true,
          },
        });
        if (!target) throw new NotFoundException('Payment not found');
        await tx.$queryRaw`SELECT "memberId" FROM "DistributionAgreementParticipant" WHERE "agreementId" = ${target.agreementId}::uuid AND "memberId" = ${target.participantMemberId}::uuid AND "contextId" = ${contextId} FOR UPDATE`;
        await tx.$queryRaw`SELECT "id" FROM "DistributionPayment" WHERE "id" = ${targetId}::uuid AND "contextId" = ${contextId} FOR UPDATE`;
        const already = await tx.distributionPaymentReversal.findFirst({
          where: { paymentId: targetId, contextId },
          select: { id: true },
        });
        if (already)
          throw new ConflictException({
            code: PAYMENT_ERRORS.alreadyVoided,
            message: 'Payment is already reversed',
          });

        const receivedAt = new Date();
        const occurredAt = new Date(data.occurredAt);
        if (occurredAt < target.occurredAt || occurredAt > receivedAt)
          throw new UnprocessableEntityException({
            code: PAYMENT_ERRORS.reversalTimeInvalid,
            message:
              'Reversal time must be on or after the payment time and not in the future',
          });
        const core: ReversalCore = {
          id,
          paymentId: targetId,
          reason: data.reason,
          occurredAt: occurredAt.toISOString(),
          receivedAt: receivedAt.toISOString(),
          createdBy: {
            memberId: data.createdByMemberId,
            name: memberName,
            accountId: actor.account.id,
            deviceId: data.deviceId,
          },
        };
        await tx.distributionPaymentReversal.create({
          data: {
            id,
            contextId,
            paymentId: targetId,
            reason: data.reason,
            occurredAt,
            receivedAt,
            createdByMemberId: data.createdByMemberId,
            createdByAccountId: actor.account.id,
            deviceId: data.deviceId,
            requestFingerprint,
            creationResponse: core as unknown as Prisma.InputJsonValue,
          },
        });
        const row = await tx.distributionPayment.findFirstOrThrow({
          where: { id: targetId, contextId },
          select: liveSelect,
        });
        return {
          created: true as const,
          receipt: await this.receipt(tx, row),
        };
      }, TX_OPTIONS);
    } catch (error) {
      if (isUniqueViolation(error))
        throw new ConflictException({
          code: PAYMENT_ERRORS.idConflict,
          message: 'Reversal ID is already in use',
        });
      throw error;
    }
  }

  async findOne(contextId: string, id: string) {
    const row = await this.prisma.distributionPayment.findFirst({
      where: { id: id.toLowerCase(), contextId },
      select: liveSelect,
    });
    if (!row) throw new NotFoundException('Payment not found');
    return livePayment(row);
  }

  /** Every payment of the agreement, voided ones included, plus the live summary. */
  async list(contextId: string, agreementId: string) {
    return this.prisma.$transaction(async (tx) => {
      const agreement = await tx.distributionAgreement.findFirst({
        where: { id: agreementId.toLowerCase(), contextId },
        select: { id: true },
      });
      if (!agreement) throw new NotFoundException('Agreement not found');
      const rows = await tx.distributionPayment.findMany({
        where: { agreementId: agreement.id, contextId },
        orderBy: [
          { occurredAt: 'desc' },
          { receivedAt: 'desc' },
          { id: 'desc' },
        ],
        select: liveSelect,
      });
      return {
        items: rows.map(livePayment),
        paymentSummary: await loadPaymentSummary(tx, contextId, agreement.id),
      };
    });
  }
}

import type { Prisma } from '../generated/prisma/client.js';

export type ParticipantPaymentStatus =
  'UNPAID' | 'PARTIALLY_PAID' | 'PAID' | 'NOT_DUE';

export interface ParticipantPaymentLine {
  memberId: string;
  memberName: string;
  agreedMinor: number;
  paidMinor: number;
  /** Payment rows of this participant, voided ones included. */
  paymentCount: number;
  /** Payment rows without a reversal. */
  activePaymentCount: number;
}

/**
 * Derived, never persisted. Overpayment is impossible by construction (the
 * service rejects it under a row lock); seeing it here means corrupted data,
 * which must surface loudly instead of being displayed as "paid".
 */
export function participantPaymentStatus(
  agreedMinor: number,
  paidMinor: number,
): ParticipantPaymentStatus {
  if (paidMinor > agreedMinor)
    throw new Error('Participant is overpaid: invariant violated');
  if (agreedMinor === 0) return 'NOT_DUE';
  if (paidMinor === 0) return 'UNPAID';
  return paidMinor === agreedMinor ? 'PAID' : 'PARTIALLY_PAID';
}

const safe = (value: bigint) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number))
    throw new RangeError('Payment sum exceeds the safe integer range');
  return number;
};

export function buildParticipantSummary(line: ParticipantPaymentLine) {
  return {
    memberId: line.memberId,
    memberName: line.memberName,
    agreedMinor: line.agreedMinor,
    paidMinor: line.paidMinor,
    pendingMinor: line.agreedMinor - line.paidMinor,
    status: participantPaymentStatus(line.agreedMinor, line.paidMinor),
  };
}

export function buildPaymentSummary(lines: ParticipantPaymentLine[]) {
  const participants = lines.map(buildParticipantSummary);
  const due = participants.filter((p) => p.agreedMinor > 0);
  let status: 'UNPAID' | 'PARTIALLY_PAID' | 'PAID' | 'NOT_DUE';
  if (!due.length) status = 'NOT_DUE';
  else if (due.every((p) => p.status === 'PAID')) status = 'PAID';
  else if (due.every((p) => p.status === 'UNPAID')) status = 'UNPAID';
  else status = 'PARTIALLY_PAID';
  const agreed = lines.reduce((sum, l) => sum + BigInt(l.agreedMinor), 0n);
  const paid = lines.reduce((sum, l) => sum + BigInt(l.paidMinor), 0n);
  const paymentCount = lines.reduce((sum, l) => sum + l.paymentCount, 0);
  return {
    status,
    agreedMinor: safe(agreed),
    paidMinor: safe(paid),
    pendingMinor: safe(agreed - paid),
    hasPayments: paymentCount > 0,
    paymentCount,
    activePaymentCount: lines.reduce((sum, l) => sum + l.activePaymentCount, 0),
    participants,
  };
}

export type PaymentSummary = ReturnType<typeof buildPaymentSummary>;

interface SummaryRow {
  memberId: string;
  memberName: string;
  agreedMinor: number;
  paidMinor: bigint;
  paymentCount: number;
  activePaymentCount: number;
}

/**
 * Live summary of one agreement. Must run inside a (tenant-scoped) transaction
 * so the RLS session variable is set. Paid = payments without a reversal.
 */
export async function loadPaymentSummary(
  tx: Prisma.TransactionClient,
  contextId: string,
  agreementId: string,
): Promise<PaymentSummary> {
  const rows = await tx.$queryRaw<SummaryRow[]>`
    SELECT pt."memberId", pt."memberName", pt."totalMinor" AS "agreedMinor",
      COALESCE(SUM(p."amountMinor") FILTER (WHERE r."id" IS NULL), 0)::bigint AS "paidMinor",
      COUNT(p."id")::int AS "paymentCount",
      (COUNT(p."id") FILTER (WHERE r."id" IS NULL))::int AS "activePaymentCount"
    FROM "DistributionAgreementParticipant" pt
    LEFT JOIN "DistributionPayment" p ON p."agreementId" = pt."agreementId" AND p."participantMemberId" = pt."memberId" AND p."contextId" = pt."contextId"
    LEFT JOIN "DistributionPaymentReversal" r ON r."paymentId" = p."id" AND r."contextId" = p."contextId"
    WHERE pt."agreementId" = ${agreementId}::uuid AND pt."contextId" = ${contextId}
    GROUP BY pt."memberId", pt."memberName", pt."totalMinor"
    ORDER BY pt."memberName", pt."memberId"`;
  return buildPaymentSummary(
    rows.map((row) => ({ ...row, paidMinor: safe(row.paidMinor) })),
  );
}

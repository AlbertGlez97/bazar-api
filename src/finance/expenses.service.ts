import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { isUUID } from 'class-validator';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import {
  isValidNatureCategoryPair,
  type CreateExpenseDto,
  type ExpenseListDto,
  type ExpenseSummaryDto,
  type ReverseExpenseDto,
} from './expense.dto.js';
type Actor = Pick<AuthenticatedRequest, 'account' | 'selection'>;

function normalized(dto: CreateExpenseDto) {
  return {
    id: dto.id.toLowerCase(),
    amountMinor: dto.amountMinor,
    occurredAt: new Date(dto.occurredAt).toISOString(),
    nature: dto.nature,
    category: dto.category,
    description: dto.description.trim(),
    paidByMemberId: dto.paidByMemberId.toLowerCase(),
    fundsSource: dto.fundsSource,
    createdByMemberId: dto.createdByMemberId.toLowerCase(),
    deviceId: dto.deviceId.toLowerCase(),
  };
}
function fingerprint(
  actor: Actor,
  dto: CreateExpenseDto,
  operation = 'create',
) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        contextId: actor.account.contextId,
        accountId: actor.account.id,
        operation,
        ...normalized(dto),
      }),
    )
    .digest('hex');
}
function checkRange(from?: string, to?: string) {
  if (from && to && new Date(from) >= new Date(to))
    throw new BadRequestException('from must precede to');
}

@Injectable()
export class ExpensesService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  private checkSelection(
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

  private async authorize(tx: Prisma.TransactionClient, actor: Actor) {
    const contextId = actor.account.contextId;
    // SHARE locks prevent concurrent revocation/role changes until the write finishes.
    const members = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM "Member" WHERE id = ${actor.selection!.memberId}::uuid AND "contextId" = ${contextId} AND active = true AND role = 'socio' FOR SHARE`;
    const devices = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM "Device" WHERE id = ${actor.selection!.deviceId}::uuid AND "contextId" = ${contextId} AND authorized = true FOR SHARE`;
    if (!members.length || !devices.length)
      throw new ForbiddenException('Operation origin is no longer authorized');
  }

  private async lockIdentity(
    tx: Prisma.TransactionClient,
    contextId: string,
    id: string,
  ) {
    // Covers absent rows too, serializing fresh insert and uncertain-response replay.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`expense:${contextId}:${id}`}, 0))`;
  }

  private async insert(
    tx: Prisma.TransactionClient,
    actor: Actor,
    dto: CreateExpenseDto,
    requestFingerprint: string,
  ) {
    const data = normalized(dto);
    if (!isValidNatureCategoryPair(data.nature, data.category))
      throw new BadRequestException(
        "INVENTORY_PURCHASE requires category 'inventory' and no other nature may use it",
      );
    const contextId = actor.account.contextId;
    // Any active member of this business, whatever the role, may be the payer.
    const payers = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM "Member" WHERE id = ${data.paidByMemberId}::uuid AND "contextId" = ${contextId} AND active = true FOR SHARE`;
    if (!payers.length)
      throw new ForbiddenException(
        'Payer must be an active member of this business',
      );
    const receivedAt = new Date();
    const receipt = {
      ...data,
      contextId,
      currency: 'MXN',
      createdByAccountId: actor.account.id,
      receivedAt: receivedAt.toISOString(),
    };
    await tx.expense.create({
      data: {
        ...data,
        contextId,
        currency: 'MXN',
        occurredAt: new Date(data.occurredAt),
        receivedAt,
        createdByAccountId: actor.account.id,
        requestFingerprint,
        creationResponse: receipt,
      },
    });
    return receipt;
  }

  async create(actor: Actor, dto: CreateExpenseDto) {
    this.checkSelection(actor, dto);
    const id = dto.id.toLowerCase();
    const requestFingerprint = fingerprint(actor, dto);
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.authorize(tx, actor);
        await this.lockIdentity(tx, actor.account.contextId, id);
        const existing = await tx.expense.findFirst({
          where: { id, contextId: actor.account.contextId },
        });
        if (existing) {
          if (existing.requestFingerprint !== requestFingerprint)
            throw new ConflictException(
              'Expense ID already has different content',
            );
          return { created: false, receipt: existing.creationResponse };
        }
        return {
          created: true,
          receipt: await this.insert(tx, actor, dto, requestFingerprint),
        };
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      )
        throw new ConflictException('Expense identity already exists');
      throw error;
    }
  }

  async reverse(actor: Actor, expenseId: string, dto: ReverseExpenseDto) {
    this.checkSelection(actor, dto);
    if (dto.replacement) this.checkSelection(actor, dto.replacement);
    const contextId = actor.account.contextId;
    const id = dto.id.toLowerCase();
    const targetId = expenseId.toLowerCase();
    const replacementId = dto.replacement?.id.toLowerCase();
    if (replacementId === targetId || replacementId === id || id === targetId)
      throw new BadRequestException('Correction identities must be distinct');
    const data = {
      id,
      expenseId: targetId,
      createdByMemberId: dto.createdByMemberId.toLowerCase(),
      deviceId: dto.deviceId.toLowerCase(),
      occurredAt: new Date(dto.occurredAt).toISOString(),
      reason: dto.reason,
    };
    const requestFingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          contextId,
          accountId: actor.account.id,
          ...data,
          replacement: dto.replacement ? normalized(dto.replacement) : null,
        }),
      )
      .digest('hex');
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.authorize(tx, actor);
        // Global ordering avoids cycles when different corrections name overlapping IDs.
        for (const identity of [
          id,
          targetId,
          ...(replacementId ? [replacementId] : []),
        ].sort((a, b) => a.localeCompare(b)))
          await this.lockIdentity(tx, contextId, identity);
        const existing = await tx.expenseReversal.findFirst({
          where: { id, contextId },
        });
        if (existing) {
          if (existing.requestFingerprint !== requestFingerprint)
            throw new ConflictException(
              'Reversal ID already has different content',
            );
          return { created: false, receipt: existing.creationResponse };
        }
        const locked = await tx.$queryRaw<
          { id: string }[]
        >`SELECT id FROM "Expense" WHERE id = ${targetId}::uuid AND "contextId" = ${contextId} FOR UPDATE`;
        if (!locked.length) throw new NotFoundException('Expense not found');
        const original = await tx.expense.findFirstOrThrow({
          where: { id: targetId, contextId },
          include: { reversal: true },
        });
        if (original.reversal)
          throw new ConflictException('Expense already reversed');
        let replacement: Prisma.JsonValue = null;
        if (dto.replacement) {
          const used = await tx.expense.findFirst({
            where: { id: replacementId!, contextId },
          });
          if (used)
            throw new ConflictException('Replacement ID already exists');
          replacement = await this.insert(
            tx,
            actor,
            dto.replacement,
            fingerprint(actor, dto.replacement, 'replacement:' + id),
          );
        }
        const receivedAt = new Date();
        const receipt = {
          ...data,
          contextId,
          createdByAccountId: actor.account.id,
          receivedAt: receivedAt.toISOString(),
          replacementExpenseId: replacementId ?? null,
          original: original.creationResponse,
          replacement,
        };
        await tx.expenseReversal.create({
          data: {
            ...data,
            contextId,
            occurredAt: new Date(data.occurredAt),
            receivedAt,
            createdByAccountId: actor.account.id,
            replacementExpenseId: replacementId ?? null,
            requestFingerprint,
            creationResponse: receipt,
          },
        });
        return { created: true, receipt };
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      )
        throw new ConflictException('Correction identity already exists');
      throw error;
    }
  }

  private occurredAtFilter(query: { from?: string; to?: string }) {
    return {
      ...(query.from ? { gte: new Date(query.from) } : {}),
      ...(query.to ? { lt: new Date(query.to) } : {}),
    };
  }

  async list(contextId: string, query: ExpenseListDto) {
    checkRange(query.from, query.to);
    let cursor: { occurredAt: Date; id: string } | undefined;
    if (query.cursor) {
      try {
        const decoded = JSON.parse(
          Buffer.from(query.cursor, 'base64url').toString('utf8'),
        ) as { occurredAt: string; id: string };
        if (
          !isUUID(decoded.id) ||
          !Number.isFinite(Date.parse(decoded.occurredAt))
        )
          throw new Error('Invalid cursor');
        cursor = { id: decoded.id, occurredAt: new Date(decoded.occurredAt) };
      } catch {
        throw new BadRequestException('Invalid cursor');
      }
    }
    const rows = await this.prisma.expense.findMany({
      where: {
        contextId,
        ...(query.paidByMemberId
          ? { paidByMemberId: query.paidByMemberId.toLowerCase() }
          : {}),
        ...(query.nature ? { nature: query.nature } : {}),
        ...(query.category ? { category: query.category } : {}),
        occurredAt: this.occurredAtFilter(query),
        ...(cursor
          ? {
              OR: [
                { occurredAt: { lt: cursor.occurredAt } },
                { occurredAt: cursor.occurredAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      include: {
        paidByMember: { select: { id: true, name: true, active: true } },
        reversal: {
          select: {
            id: true,
            expenseId: true,
            replacementExpenseId: true,
            reason: true,
            occurredAt: true,
            receivedAt: true,
            createdByMemberId: true,
            deviceId: true,
          },
        },
      },
    });
    const items = rows
      .slice(0, query.limit)
      .map(
        ({
          requestFingerprint: _fingerprint,
          creationResponse: _receipt,
          ...row
        }) => row,
      );
    const last = items.at(-1);
    const nextCursor =
      rows.length > query.limit && last
        ? Buffer.from(
            JSON.stringify({
              occurredAt: last.occurredAt.toISOString(),
              id: last.id,
            }),
          ).toString('base64url')
        : null;
    return { items, nextCursor };
  }

  /** Totals of non-reversed expenses; a reversed original never counts. */
  async summary(contextId: string, query: ExpenseSummaryDto) {
    checkRange(query.from, query.to);
    const groups = await this.prisma.expense.groupBy({
      by: ['nature', 'fundsSource'],
      where: {
        contextId,
        reversal: { is: null },
        occurredAt: this.occurredAtFilter(query),
      },
      _sum: { amountMinor: true },
    });
    const total = {
      operatingMinor: 0,
      inventoryMinor: 0,
      personalMinor: 0,
      businessMinor: 0,
    };
    for (const group of groups) {
      const amount = group._sum.amountMinor ?? 0;
      if (group.nature === 'INVENTORY_PURCHASE') total.inventoryMinor += amount;
      else total.operatingMinor += amount;
      if (group.fundsSource === 'PERSONAL') total.personalMinor += amount;
      else total.businessMinor += amount;
    }
    return total;
  }
}

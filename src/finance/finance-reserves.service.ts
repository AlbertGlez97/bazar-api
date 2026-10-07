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
import { isCalendarDate } from './work-shift.dto.js';
import { UUID_V7 } from './contribution.dto.js';
import type {
  CreateFinanceReserveDto,
  FinanceReserveListDto,
  ReverseFinanceReserveDto,
} from './finance-reserve.dto.js';
type Actor = Pick<AuthenticatedRequest, 'account' | 'selection'>;
const date = (value: string) => new Date(value + 'T00:00:00.000Z');
const digest = (value: object) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
function normalized(dto: CreateFinanceReserveDto) {
  return {
    id: dto.id.toLowerCase(),
    name: dto.name.trim(),
    amountMinor: dto.amountMinor,
    currency: dto.currency ?? 'MXN',
    periodFrom: dto.periodFrom,
    periodTo: dto.periodTo,
    note: dto.note?.trim() ?? null,
    occurredAt: new Date(dto.occurredAt).toISOString(),
    createdByMemberId: dto.createdByMemberId.toLowerCase(),
    deviceId: dto.deviceId.toLowerCase(),
  };
}
@Injectable()
export class FinanceReservesService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}
  private async authorize(tx: Prisma.TransactionClient, actor: Actor) {
    const contextId = actor.account.contextId;
    const accounts = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM "Account" WHERE id = ${actor.account.id}::uuid AND "contextId" = ${contextId} AND active = true AND ("memberId" IS NULL OR "memberId" = ${actor.selection!.memberId}::uuid) FOR SHARE`;
    const members = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM "Member" WHERE id = ${actor.selection!.memberId}::uuid AND "contextId" = ${contextId} AND active = true AND role = 'socio' FOR SHARE`;
    const devices = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM "Device" WHERE id = ${actor.selection!.deviceId}::uuid AND "contextId" = ${contextId} AND authorized = true FOR SHARE`;
    if (!accounts.length || !members.length || !devices.length)
      throw new ForbiddenException('Operation origin is no longer authorized');
  }
  async create(actor: Actor, dto: CreateFinanceReserveDto) {
    if (
      dto.createdByMemberId.toLowerCase() !== actor.selection?.memberId ||
      dto.deviceId.toLowerCase() !== actor.selection?.deviceId
    )
      throw new ForbiddenException(
        'Operation origin does not match the selected member and device',
      );
    if (
      !isCalendarDate(dto.periodFrom) ||
      !isCalendarDate(dto.periodTo) ||
      dto.periodFrom >= dto.periodTo
    )
      throw new BadRequestException('Invalid reserve period');
    const data = normalized(dto);
    const contextId = actor.account.contextId;
    const requestFingerprint = digest({
      contextId,
      accountId: actor.account.id,
      operation: 'create',
      ...data,
    });
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.authorize(tx, actor);
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`finance-reserve:identity:${contextId}:${data.id}`}, 0))`;
        const existing = await tx.financeReserve.findFirst({
          where: { contextId, id: data.id },
        });
        if (existing) {
          if (existing.requestFingerprint !== requestFingerprint)
            throw new ConflictException(
              'Reserve ID already has different content',
            );
          return { created: false, receipt: existing.creationResponse };
        }
        const receivedAt = new Date();
        const receipt = {
          ...data,
          contextId,
          createdByAccountId: actor.account.id,
          receivedAt: receivedAt.toISOString(),
        };
        await tx.financeReserve.create({
          data: {
            ...data,
            contextId,
            createdByAccountId: actor.account.id,
            periodFrom: date(data.periodFrom),
            periodTo: date(data.periodTo),
            occurredAt: new Date(data.occurredAt),
            receivedAt,
            requestFingerprint,
            creationResponse: receipt,
          },
        });
        return { created: true, receipt };
      });
    } catch (error) {
      // A same-tenant identity is serialized and handled above. Global UUID
      // collisions invisible under RLS disclose no foreign receipt or ownership.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      )
        throw new NotFoundException('Reserve not found');
      throw error;
    }
  }
  async reverse(
    actor: Actor,
    reserveId: string,
    dto: ReverseFinanceReserveDto,
  ) {
    if (
      dto.createdByMemberId.toLowerCase() !== actor.selection?.memberId ||
      dto.deviceId.toLowerCase() !== actor.selection?.deviceId
    )
      throw new ForbiddenException(
        'Operation origin does not match the selected member and device',
      );
    const contextId = actor.account.contextId;
    const id = dto.id.toLowerCase();
    const targetId = reserveId.toLowerCase();
    if (id === targetId)
      throw new BadRequestException(
        'Cancellation and reserve identities must be distinct',
      );
    const data = {
      id,
      reserveId: targetId,
      reason: dto.reason.trim(),
      occurredAt: new Date(dto.occurredAt).toISOString(),
      createdByMemberId: dto.createdByMemberId.toLowerCase(),
      deviceId: dto.deviceId.toLowerCase(),
    };
    const requestFingerprint = digest({
      contextId,
      accountId: actor.account.id,
      operation: 'reverse',
      ...data,
    });
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.authorize(tx, actor);
        // Same identity namespace as create. Sorted locks precede row locks,
        // preventing cycles between concurrent replays, targets and creates.
        for (const identity of [id, targetId].sort())
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`finance-reserve:identity:${contextId}:${identity}`}, 0))`;
        const existing = await tx.financeReserveReversal.findFirst({
          where: { id, contextId },
        });
        if (existing) {
          if (existing.requestFingerprint !== requestFingerprint)
            throw new ConflictException(
              'Cancellation ID already has different content',
            );
          return { created: false, receipt: existing.creationResponse };
        }
        const locked = await tx.$queryRaw<
          { id: string }[]
        >`SELECT id FROM "FinanceReserve" WHERE id = ${targetId}::uuid AND "contextId" = ${contextId} FOR UPDATE`;
        if (!locked.length) throw new NotFoundException('Reserve not found');
        const original = await tx.financeReserve.findFirstOrThrow({
          where: { id: targetId, contextId },
          include: { reversal: true },
        });
        if (original.reversal)
          throw new ConflictException('Reserve already reversed');
        const receivedAt = new Date();
        const receipt = {
          ...data,
          contextId,
          createdByAccountId: actor.account.id,
          receivedAt: receivedAt.toISOString(),
          original: original.creationResponse,
        };
        await tx.financeReserveReversal.create({
          data: {
            ...data,
            contextId,
            createdByAccountId: actor.account.id,
            occurredAt: new Date(data.occurredAt),
            receivedAt,
            requestFingerprint,
            creationResponse: receipt,
          },
        });
        return { created: true, receipt };
      });
    } catch (error) {
      // Own-context races are resolved under identity and target row locks.
      // An invisible global cancellation ID collision never exposes its receipt.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      )
        throw new NotFoundException('Reserve not found');
      throw error;
    }
  }
  async list(contextId: string, query: FinanceReserveListDto) {
    const { from, to, status, limit } = query;
    if (
      (from !== undefined || to !== undefined) &&
      (!isCalendarDate(from) || !isCalendarDate(to) || from >= to)
    )
      throw new BadRequestException(
        'Both exact-period dates are required with from preceding to',
      );
    const scope = digest({
      contextId,
      from: from ?? null,
      to: to ?? null,
      status,
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
    const rows = await this.prisma.financeReserve.findMany({
      where: {
        contextId,
        ...(from && to ? { periodFrom: date(from), periodTo: date(to) } : {}),
        reversal: status === 'reversed' ? { isNot: null } : { is: null },
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
      include: {
        reversal: {
          select: {
            id: true,
            reserveId: true,
            reason: true,
            occurredAt: true,
            receivedAt: true,
            createdByMemberId: true,
            createdByAccountId: true,
            deviceId: true,
          },
        },
      },
    });
    const items = rows
      .slice(0, limit)
      .map(
        ({
          requestFingerprint: _fingerprint,
          creationResponse: _receipt,
          ...row
        }) => ({
          ...row,
          periodFrom: row.periodFrom.toISOString().slice(0, 10),
          periodTo: row.periodTo.toISOString().slice(0, 10),
          status: row.reversal ? 'reversed' : 'active',
        }),
      );
    const last = items.at(-1);
    const nextCursor =
      rows.length > limit && last
        ? Buffer.from(
            JSON.stringify({
              version: 1,
              scope,
              receivedAt: last.receivedAt.toISOString(),
              id: last.id,
            }),
          ).toString('base64url')
        : null;
    return { items, nextCursor };
  }
}

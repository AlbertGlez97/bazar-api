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
  isCalendarDate,
  type CreateWorkShiftDto,
  type WorkShiftListDto,
  type WorkShiftSummaryDto,
  type ReverseWorkShiftDto,
} from './work-shift.dto.js';

type Actor = Pick<AuthenticatedRequest, 'account' | 'selection'>;
const date = (value: string) => new Date(value + 'T00:00:00.000Z');
const dateOnly = (value: Date) => value.toISOString().slice(0, 10);
function normalized(dto: CreateWorkShiftDto) {
  return {
    id: dto.id.toLowerCase(),
    memberId: dto.memberId.toLowerCase(),
    workDate: dto.workDate,
    minutes: dto.minutes ?? null,
    note: dto.note ?? null,
    createdByMemberId: dto.createdByMemberId.toLowerCase(),
    deviceId: dto.deviceId.toLowerCase(),
  };
}
function fingerprint(actor: Actor, payload: object, operation: string) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        contextId: actor.account.contextId,
        accountId: actor.account.id,
        operation,
        ...payload,
      }),
    )
    .digest('hex');
}

@Injectable()
export class WorkShiftsService {
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
    // Prevent concurrent role/device revocation until the transaction commits.
    const members = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM "Member" WHERE id = ${actor.selection!.memberId}::uuid AND "contextId" = ${contextId} AND active = true AND role = 'socio' FOR SHARE`;
    const devices = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM "Device" WHERE id = ${actor.selection!.deviceId}::uuid AND "contextId" = ${contextId} AND authorized = true FOR SHARE`;
    if (!members.length || !devices.length)
      throw new ForbiddenException('Operation origin is no longer authorized');
  }

  private async lockIdentities(
    tx: Prisma.TransactionClient,
    contextId: string,
    ids: string[],
  ) {
    // Identity locks always precede day locks. Sort each lock class globally.
    for (const id of [...new Set(ids)].sort())
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`work-shift:identity:${contextId}:${id}`}, 0))`;
  }

  private async lockDays(
    tx: Prisma.TransactionClient,
    contextId: string,
    days: { memberId: string; workDate: string }[],
  ) {
    const keys = days.map((day) =>
      JSON.stringify([contextId, day.memberId, day.workDate]),
    );
    for (const key of [...new Set(keys)].sort())
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`work-shift:day:${key}`}, 0))`;
  }

  private async insert(
    tx: Prisma.TransactionClient,
    actor: Actor,
    dto: CreateWorkShiftDto,
    requestFingerprint: string,
    excludedId?: string,
  ) {
    const data = normalized(dto);
    const contextId = actor.account.contextId;
    const workers = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM "Member" WHERE id = ${data.memberId}::uuid AND "contextId" = ${contextId} AND active = true FOR SHARE`;
    if (!workers.length)
      throw new ForbiddenException(
        'Worker must be an active member of this business',
      );
    const existingActiveShiftCount = await tx.workShift.count({
      where: {
        contextId,
        memberId: data.memberId,
        workDate: date(data.workDate),
        reversal: { is: null },
        ...(excludedId ? { id: { not: excludedId } } : {}),
      },
    });
    const warnings = existingActiveShiftCount
      ? [{ code: 'MULTIPLE_SHIFTS_SAME_DAY', existingActiveShiftCount }]
      : [];
    const receivedAt = new Date();
    const receipt = {
      ...data,
      contextId,
      createdByAccountId: actor.account.id,
      receivedAt: receivedAt.toISOString(),
      warnings,
    };
    await tx.workShift.create({
      data: {
        ...data,
        contextId,
        workDate: date(data.workDate),
        receivedAt,
        createdByAccountId: actor.account.id,
        requestFingerprint,
        creationResponse: receipt,
      },
    });
    return receipt;
  }

  private conflict(error: unknown): never {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      ['P2002', 'P2003'].includes(error.code)
    )
      throw new ConflictException(
        'Work shift identity or relationship conflicts',
      );
    throw error;
  }

  async create(actor: Actor, dto: CreateWorkShiftDto) {
    this.checkSelection(actor, dto);
    const data = normalized(dto);
    const requestFingerprint = fingerprint(actor, data, 'create');
    const contextId = actor.account.contextId;
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.authorize(tx, actor);
        await this.lockIdentities(tx, contextId, [data.id]);
        const existing = await tx.workShift.findFirst({
          where: { id: data.id, contextId },
        });
        if (existing) {
          if (existing.requestFingerprint !== requestFingerprint)
            throw new ConflictException(
              'Work shift ID already has different content',
            );
          return { created: false, receipt: existing.creationResponse };
        }
        // A reversal identity cannot be reused as a shift identity.
        if (
          await tx.workShiftReversal.findFirst({
            where: { id: data.id, contextId },
          })
        )
          throw new ConflictException('Work shift identity already exists');
        await this.lockDays(tx, contextId, [data]);
        return {
          created: true,
          receipt: await this.insert(tx, actor, dto, requestFingerprint),
        };
      });
    } catch (error) {
      this.conflict(error);
    }
  }

  async reverse(actor: Actor, target: string, dto: ReverseWorkShiftDto) {
    this.checkSelection(actor, dto);
    if (dto.replacement) this.checkSelection(actor, dto.replacement);
    const contextId = actor.account.contextId;
    const id = dto.id.toLowerCase();
    const workShiftId = target.toLowerCase();
    const replacementWorkShiftId = dto.replacement?.id.toLowerCase() ?? null;
    const identities = [
      id,
      workShiftId,
      ...(replacementWorkShiftId ? [replacementWorkShiftId] : []),
    ];
    if (new Set(identities).size !== identities.length)
      throw new BadRequestException('Correction identities must be distinct');
    const data = {
      id,
      workShiftId,
      createdByMemberId: dto.createdByMemberId.toLowerCase(),
      deviceId: dto.deviceId.toLowerCase(),
      occurredAt: new Date(dto.occurredAt).toISOString(),
      reason: dto.reason,
    };
    const requestFingerprint = fingerprint(
      actor,
      {
        ...data,
        replacement: dto.replacement ? normalized(dto.replacement) : null,
      },
      'reverse',
    );
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.authorize(tx, actor);
        await this.lockIdentities(tx, contextId, identities);
        const existing = await tx.workShiftReversal.findFirst({
          where: { id, contextId },
        });
        if (existing) {
          if (existing.requestFingerprint !== requestFingerprint)
            throw new ConflictException(
              'Reversal ID already has different content',
            );
          return { created: false, receipt: existing.creationResponse };
        }
        if (await tx.workShift.findFirst({ where: { id, contextId } }))
          throw new ConflictException('Correction identity already exists');
        const original = await tx.workShift.findFirst({
          where: { id: workShiftId, contextId },
          include: { reversal: true },
        });
        if (!original) throw new NotFoundException('Work shift not found');
        if (original.reversal)
          throw new ConflictException('Work shift already reversed');
        const days = [
          {
            memberId: original.memberId,
            workDate: dateOnly(original.workDate),
          },
          ...(dto.replacement ? [normalized(dto.replacement)] : []),
        ];
        await this.lockDays(tx, contextId, days);
        let replacement: Prisma.JsonValue = null;
        if (dto.replacement) {
          const usedShift = await tx.workShift.findFirst({
            where: { id: replacementWorkShiftId!, contextId },
          });
          const usedReversal = await tx.workShiftReversal.findFirst({
            where: { id: replacementWorkShiftId!, contextId },
          });
          if (usedShift || usedReversal)
            throw new ConflictException('Replacement identity already exists');
          replacement = await this.insert(
            tx,
            actor,
            dto.replacement,
            fingerprint(
              actor,
              normalized(dto.replacement),
              'replacement:' + id,
            ),
            workShiftId,
          );
        }
        const receivedAt = new Date();
        const receipt = {
          ...data,
          contextId,
          createdByAccountId: actor.account.id,
          receivedAt: receivedAt.toISOString(),
          replacementWorkShiftId,
          original: original.creationResponse,
          replacement,
        };
        await tx.workShiftReversal.create({
          data: {
            ...data,
            contextId,
            occurredAt: new Date(data.occurredAt),
            receivedAt,
            createdByAccountId: actor.account.id,
            replacementWorkShiftId,
            requestFingerprint,
            creationResponse: receipt,
          },
        });
        return { created: true, receipt };
      });
    } catch (error) {
      this.conflict(error);
    }
  }

  private async scope(
    actor: Actor,
    query: WorkShiftSummaryDto,
  ): Promise<Prisma.WorkShiftWhereInput> {
    if (query.from && query.to && query.from >= query.to)
      throw new BadRequestException('from must precede to');
    const member = await this.prisma.member.findFirst({
      where: {
        id: actor.selection!.memberId,
        contextId: actor.account.contextId,
        active: true,
      },
    });
    if (!member)
      throw new ForbiddenException('Selection is no longer authorized');
    let memberId = query.memberId?.toLowerCase();
    if (member.role === 'colaborador') {
      if (memberId && memberId !== member.id)
        throw new ForbiddenException('Only your own work shifts may be read');
      memberId = member.id;
    }
    return {
      contextId: actor.account.contextId,
      ...(memberId ? { memberId } : {}),
      workDate: {
        ...(query.from ? { gte: date(query.from) } : {}),
        ...(query.to ? { lt: date(query.to) } : {}),
      },
      ...(query.duration === 'unknown'
        ? { minutes: null }
        : query.duration === 'known'
          ? { minutes: { not: null } }
          : {}),
    };
  }

  async list(actor: Actor, query: WorkShiftListDto) {
    const where = await this.scope(actor, query);
    if (query.status)
      where.reversal =
        query.status === 'active' ? { is: null } : { isNot: null };
    if (query.cursor !== undefined) {
      try {
        if (!/^[A-Za-z0-9_-]+$/.test(query.cursor)) throw new Error();
        const decoded = JSON.parse(
          Buffer.from(query.cursor, 'base64url').toString('utf8'),
        ) as { workDate: unknown; id: unknown };
        if (
          !isCalendarDate(decoded.workDate) ||
          typeof decoded.id !== 'string' ||
          !isUUID(decoded.id) ||
          Object.keys(decoded).sort().join(',') !== 'id,workDate'
        )
          throw new Error();
        const workDate = date(decoded.workDate);
        where.OR = [
          { workDate: { lt: workDate } },
          { workDate, id: { lt: decoded.id.toLowerCase() } },
        ];
      } catch {
        throw new BadRequestException('Invalid cursor');
      }
    }
    const rows = await this.prisma.workShift.findMany({
      where,
      orderBy: [{ workDate: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      include: {
        member: { select: { id: true, name: true, active: true, role: true } },
        reversal: {
          select: {
            id: true,
            workShiftId: true,
            replacementWorkShiftId: true,
            reason: true,
            occurredAt: true,
            receivedAt: true,
            createdByMemberId: true,
            createdByAccountId: true,
            deviceId: true,
          },
        },
        replacedByReversal: { select: { id: true, workShiftId: true } },
      },
    });
    const items = rows
      .slice(0, query.limit)
      .map(
        ({
          requestFingerprint: _fingerprint,
          creationResponse: _receipt,
          ...row
        }) => ({ ...row, workDate: dateOnly(row.workDate) }),
      );
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        rows.length > query.limit && last
          ? Buffer.from(
              JSON.stringify({ workDate: last.workDate, id: last.id }),
            ).toString('base64url')
          : null,
    };
  }

  async summary(actor: Actor, query: WorkShiftSummaryDto) {
    const where = await this.scope(actor, query);
    const groups = await this.prisma.workShift.groupBy({
      by: ['memberId'],
      where: { ...where, reversal: { is: null } },
      _count: { _all: true, minutes: true },
      _sum: { minutes: true },
    });
    const people = await this.prisma.member.findMany({
      where: {
        contextId: actor.account.contextId,
        id: { in: groups.map((group) => group.memberId) },
      },
      select: { id: true, name: true, role: true, active: true },
    });
    const members = groups
      .map((group) => ({
        memberId: group.memberId,
        member: people.find((person) => person.id === group.memberId)!,
        shiftCount: group._count._all,
        knownMinutes: group._sum.minutes ?? 0,
        unknownDurationCount: group._count._all - group._count.minutes,
      }))
      .sort((a, b) => a.memberId.localeCompare(b.memberId));
    const totals = members.reduce(
      (sum, member) => ({
        shiftCount: sum.shiftCount + member.shiftCount,
        knownMinutes: sum.knownMinutes + member.knownMinutes,
        unknownDurationCount:
          sum.unknownDurationCount + member.unknownDurationCount,
      }),
      { shiftCount: 0, knownMinutes: 0, unknownDurationCount: 0 },
    );
    return { totals, members };
  }
}

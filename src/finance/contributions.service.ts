import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { isUUID } from 'class-validator';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import type {
  CreateContributionDto,
  ContributionListDto,
} from './contribution.dto.js';
type Actor = Pick<AuthenticatedRequest, 'account' | 'selection'>;
function normalized(dto: CreateContributionDto) {
  return {
    id: dto.id.toLowerCase(),
    memberId: dto.memberId.toLowerCase(),
    createdByMemberId: dto.createdByMemberId.toLowerCase(),
    deviceId: dto.deviceId.toLowerCase(),
    amountMinor: dto.amountMinor,
    occurredAt: new Date(dto.occurredAt).toISOString(),
    note: dto.note ?? null,
  };
}
function fingerprint(
  actor: Actor,
  dto: CreateContributionDto,
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
@Injectable()
export class ContributionsService {
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
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`contribution:${contextId}:${id}`}, 0))`;
  }
  private async insert(
    tx: Prisma.TransactionClient,
    actor: Actor,
    dto: CreateContributionDto,
    requestFingerprint: string,
  ) {
    const data = normalized(dto);
    const contextId = actor.account.contextId;
    const contributor = await tx.member.findFirst({
      where: { id: data.memberId, contextId, active: true, role: 'socio' },
    });
    if (!contributor)
      throw new ForbiddenException(
        'Contributor must be an active socio of this business',
      );
    const receivedAt = new Date();
    const receipt = {
      ...data,
      contextId,
      currency: 'MXN',
      createdByAccountId: actor.account.id,
      receivedAt: receivedAt.toISOString(),
    };
    await tx.contribution.create({
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
  async create(actor: Actor, dto: CreateContributionDto) {
    this.checkSelection(actor, dto);
    const id = dto.id.toLowerCase();
    const requestFingerprint = fingerprint(actor, dto);
    return this.prisma.$transaction(async (tx) => {
      await this.authorize(tx, actor);
      await this.lockIdentity(tx, actor.account.contextId, id);
      const existing = await tx.contribution.findFirst({
        where: { id, contextId: actor.account.contextId },
      });
      if (existing) {
        if (existing.requestFingerprint !== requestFingerprint)
          throw new ConflictException(
            'Contribution ID already has different content',
          );
        return { created: false, receipt: existing.creationResponse };
      }
      return {
        created: true,
        receipt: await this.insert(tx, actor, dto, requestFingerprint),
      };
    });
  }
  async list(contextId: string, query: ContributionListDto) {
    if (query.from && query.to && new Date(query.from) >= new Date(query.to))
      throw new BadRequestException('from must precede to');
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
    const rows = await this.prisma.contribution.findMany({
      where: {
        contextId,
        ...(query.memberId ? { memberId: query.memberId.toLowerCase() } : {}),
        occurredAt: {
          ...(query.from ? { gte: new Date(query.from) } : {}),
          ...(query.to ? { lt: new Date(query.to) } : {}),
        },
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
      include: { member: { select: { id: true, name: true, active: true } } },
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
}

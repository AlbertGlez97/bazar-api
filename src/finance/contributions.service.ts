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
import type {
  CreateContributionDto,
  ContributionListDto,
  ReverseContributionDto,
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
    const contributors = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM "Member" WHERE id = ${data.memberId}::uuid AND "contextId" = ${contextId} AND active = true AND role = 'socio' FOR SHARE`;
    if (!contributors.length)
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
    try {
      return await this.prisma.$transaction(async (tx) => {
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
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      )
        throw new ConflictException('Contribution identity already exists');
      throw error;
    }
  }

  async reverse(
    actor: Actor,
    contributionId: string,
    dto: ReverseContributionDto,
  ) {
    this.checkSelection(actor, dto);
    if (dto.replacement) this.checkSelection(actor, dto.replacement);
    const contextId = actor.account.contextId;
    const id = dto.id.toLowerCase();
    const targetId = contributionId.toLowerCase();
    const replacementId = dto.replacement?.id.toLowerCase();
    if (replacementId === targetId || replacementId === id || id === targetId)
      throw new BadRequestException('Correction identities must be distinct');
    const data = {
      id,
      contributionId: targetId,
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
        const existing = await tx.contributionReversal.findFirst({
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
        >`SELECT id FROM "Contribution" WHERE id = ${targetId}::uuid AND "contextId" = ${contextId} FOR UPDATE`;
        if (!locked.length)
          throw new NotFoundException('Contribution not found');
        const original = await tx.contribution.findFirstOrThrow({
          where: { id: targetId, contextId },
          include: { reversal: true },
        });
        if (original.reversal)
          throw new ConflictException('Contribution already reversed');
        let replacement: Prisma.JsonValue = null;
        if (dto.replacement) {
          const used = await tx.contribution.findFirst({
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
          replacementContributionId: replacementId ?? null,
          original: original.creationResponse,
          replacement,
        };
        await tx.contributionReversal.create({
          data: {
            ...data,
            contextId,
            occurredAt: new Date(data.occurredAt),
            receivedAt,
            createdByAccountId: actor.account.id,
            replacementContributionId: replacementId ?? null,
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
      include: {
        member: { select: { id: true, name: true, active: true } },
        reversal: {
          select: {
            id: true,
            contributionId: true,
            replacementContributionId: true,
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
}

import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { v7 } from 'uuid';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { withTestTenant } from './tenant-scope.js';

describe('capital contributions', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let actorId: string;
  let contributorId: string;
  let collaboratorId: string;
  let deviceId: string;
  let foreignMemberId: string;
  const contextId = `contributions-${randomUUID()}`;
  const otherContext = `contributions-other-${randomUUID()}`;
  const endpoint = '/finance/contributions';
  // One account (and token) per person: the token decides who acts.
  const tokens: Record<string, string> = {};
  const auth = (req: request.Test, memberId = actorId) =>
    req.auth(tokens[memberId], { type: 'bearer' }).set('x-device-id', deviceId);
  const body = (overrides: Record<string, unknown> = {}) => ({
    id: v7(),
    memberId: contributorId,
    createdByMemberId: actorId,
    deviceId,
    amountMinor: 800000,
    occurredAt: '2026-10-03T00:00:00-06:00',
    note: 'Initial capital',
    ...overrides,
  });

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    await withTestTenant(contextId, async () => {
      actorId = (
        await prisma.member.create({
          data: { name: 'Recorder', role: 'socio', contextId },
        })
      ).id;
      contributorId = (
        await prisma.member.create({
          data: { name: 'Contributor', role: 'socio', contextId },
        })
      ).id;
      collaboratorId = (
        await prisma.member.create({
          data: { name: 'Collaborator', role: 'colaborador', contextId },
        })
      ).id;
      deviceId = (
        await prisma.device.create({
          data: { name: 'Tablet', authorized: true, contextId },
        })
      ).id;
    });
    for (const memberId of [actorId, collaboratorId]) {
      const account = await prisma.account.create({
        data: {
          username: randomUUID(),
          passwordHash: 'not-a-login-fixture',
          contextId,
          memberId,
        },
      });
      tokens[memberId] = await app
        .get(JwtService)
        .signAsync({ sub: account.id });
    }
    foreignMemberId = await withTestTenant(
      otherContext,
      async () =>
        (
          await prisma.member.create({
            data: { name: 'Other', role: 'socio', contextId: otherContext },
          })
        ).id,
    );
  });

  afterAll(async () => {
    // Test fixtures are isolated by unique context, never reset the database.
    if (prisma) {
      // Accounts first: Account.memberId is ON DELETE RESTRICT.
      await prisma.account.deleteMany({ where: { contextId } });
      await withTestTenant(contextId, async () => {
        if ('contributionReversal' in prisma)
          await prisma.contributionReversal.deleteMany({
            where: { contextId },
          });
        if ('contribution' in prisma)
          await prisma.contribution.deleteMany({ where: { contextId } });
        await prisma.device.deleteMany({ where: { contextId } });
        await prisma.member.deleteMany({ where: { contextId } });
      });
      await withTestTenant(otherContext, async () => {
        await prisma.contribution.deleteMany({
          where: { contextId: otherContext },
        });
        await prisma.device.deleteMany({ where: { contextId: otherContext } });
        await prisma.member.deleteMany({ where: { contextId: otherContext } });
      });
    }
    await app?.close();
  });

  it('records integer MXN capital with contributor distinct from recorder', async () => {
    const dto = body();
    const res = await auth(request(app.getHttpServer()).post(endpoint))
      .send(dto)
      .expect(201);
    expect(res.body).toMatchObject({
      ...dto,
      contextId,
      currency: 'MXN',
      occurredAt: '2026-10-03T06:00:00.000Z',
    });
    expect(res.body.receivedAt).toBeTruthy();
    expect(res.body.requestFingerprint).toBeUndefined();
  });

  it.each([0, -1, 1.5, 2147483648, '800000'])(
    'rejects invalid amount %s',
    async (amountMinor) => {
      await auth(request(app.getHttpServer()).post(endpoint))
        .send(body({ amountMinor }))
        .expect(400);
    },
  );

  it('requires UUID v7, timezone and rejects client context', async () => {
    for (const overrides of [
      { id: randomUUID() },
      { occurredAt: '2026-10-03' },
      { contextId: otherContext },
    ]) {
      await auth(request(app.getHttpServer()).post(endpoint))
        .send(body(overrides))
        .expect(400);
    }
  });

  it('rejects another tenant contributor and a collaborator contributor', async () => {
    for (const memberId of [foreignMemberId, collaboratorId])
      await auth(request(app.getHttpServer()).post(endpoint))
        .send(body({ memberId }))
        .expect(403);
  });

  it('blocks collaborator create and list', async () => {
    await auth(request(app.getHttpServer()).post(endpoint), collaboratorId)
      .send(body({ createdByMemberId: collaboratorId }))
      .expect(403);
    await auth(
      request(app.getHttpServer()).get(endpoint),
      collaboratorId,
    ).expect(403);
  });

  it('binds the original actor and device carried offline', async () => {
    await auth(request(app.getHttpServer()).post(endpoint))
      .send(body({ createdByMemberId: contributorId }))
      .expect(403);
    await auth(request(app.getHttpServer()).post(endpoint))
      .send(body({ deviceId: randomUUID() }))
      .expect(403);
  });

  it('replays normalized exact content and conflicts on changed content', async () => {
    const dto = body();
    const first = await auth(request(app.getHttpServer()).post(endpoint))
      .send(dto)
      .expect(201);
    const replay = await auth(request(app.getHttpServer()).post(endpoint))
      .send({ ...dto, occurredAt: '2026-10-03T06:00:00Z' })
      .expect(200);
    expect(replay.body).toEqual(first.body);
    await auth(request(app.getHttpServer()).post(endpoint))
      .send({ ...dto, amountMinor: 600000 })
      .expect(409);
  });

  it('handles concurrent identical submissions once', async () => {
    const dto = body();
    const results = await Promise.all(
      [0, 1].map(() =>
        auth(request(app.getHttpServer()).post(endpoint)).send(dto),
      ),
    );
    expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([
      200, 201,
    ]);
    expect(results[0].body).toEqual(results[1].body);
  });

  it('filters economic instants, member and stable cursor pagination', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const dto = body({ occurredAt: '2025-01-02T00:00:00-06:00' });
      ids.push(dto.id as string);
      await auth(request(app.getHttpServer()).post(endpoint))
        .send(dto)
        .expect(201);
    }
    const query = {
      from: '2025-01-02T06:00:00Z',
      to: '2025-01-03T06:00:00Z',
      memberId: contributorId,
      limit: 2,
    };
    const first = await auth(request(app.getHttpServer()).get(endpoint))
      .query(query)
      .expect(200);
    expect(first.body.items).toHaveLength(2);
    const second = await auth(request(app.getHttpServer()).get(endpoint))
      .query({ ...query, cursor: first.body.nextCursor })
      .expect(200);
    expect(
      [...first.body.items, ...second.body.items].map(
        (r: { id: string }) => r.id,
      ),
    ).toEqual(ids.sort().reverse());
    expect(second.body.nextCursor).toBeNull();
    const empty = await auth(request(app.getHttpServer()).get(endpoint))
      .query({ ...query, memberId: foreignMemberId })
      .expect(200);
    expect(empty.body.items).toEqual([]);
    await auth(request(app.getHttpServer()).get(endpoint))
      .query({ ...query, from: query.to, to: query.from })
      .expect(400);
  });
  const reversalBody = (overrides: Record<string, unknown> = {}) => ({
    id: v7(),
    createdByMemberId: actorId,
    deviceId,
    occurredAt: '2026-10-03T12:00:00Z',
    reason: 'Incorrect amount',
    ...overrides,
  });
  const createOriginal = async () => {
    const dto = body();
    await auth(request(app.getHttpServer()).post(endpoint))
      .send(dto)
      .expect(201);
    return dto;
  };

  it('reverses without repayment and retains an immutable creation receipt', async () => {
    const original = await createOriginal();
    const dto = reversalBody();
    const reversal = await auth(
      request(app.getHttpServer()).post(
        endpoint + '/' + original.id + '/reversals',
      ),
    )
      .send(dto)
      .expect(201);
    expect(reversal.body).toMatchObject({
      id: dto.id,
      contributionId: original.id,
      reason: dto.reason,
      replacement: null,
    });
    const replay = await auth(
      request(app.getHttpServer()).post(
        endpoint + '/' + original.id + '/reversals',
      ),
    )
      .send(dto)
      .expect(200);
    expect(replay.body).toEqual(reversal.body);
    const receipt = await auth(request(app.getHttpServer()).post(endpoint))
      .send(original)
      .expect(200);
    expect(receipt.body.amountMinor).toBe(800000);
    expect(receipt.body.reversal).toBeUndefined();
    const list = await auth(request(app.getHttpServer()).get(endpoint)).expect(
      200,
    );
    expect(
      list.body.items.find((r: { id: string }) => r.id === original.id).reversal
        .id,
    ).toBe(dto.id);
  });

  it('rejects modified replay, double reversal, blank reason and collaborator', async () => {
    const original = await createOriginal();
    const dto = reversalBody();
    const path = endpoint + '/' + original.id + '/reversals';
    await auth(request(app.getHttpServer()).post(path))
      .send({ ...dto, reason: '   ' })
      .expect(400);
    await auth(request(app.getHttpServer()).post(path), collaboratorId)
      .send({ ...dto, createdByMemberId: collaboratorId })
      .expect(403);
    await auth(request(app.getHttpServer()).post(path)).send(dto).expect(201);
    await auth(request(app.getHttpServer()).post(path))
      .send({ ...dto, reason: 'Changed' })
      .expect(409);
    await auth(request(app.getHttpServer()).post(path))
      .send(reversalBody())
      .expect(409);
  });

  it('atomically corrects with a linked replacement, preserving each operation identity', async () => {
    const original = await createOriginal();
    const replacement = body({ amountMinor: 600000 });
    const dto = reversalBody({ replacement });
    const path = endpoint + '/' + original.id + '/reversals';
    const corrected = await auth(request(app.getHttpServer()).post(path))
      .send(dto)
      .expect(201);
    expect(corrected.body.replacement).toMatchObject({
      id: replacement.id,
      amountMinor: 600000,
    });
    const replay = await auth(request(app.getHttpServer()).post(path))
      .send(dto)
      .expect(200);
    expect(replay.body).toEqual(corrected.body);
    await auth(request(app.getHttpServer()).post(endpoint))
      .send(replacement)
      .expect(409);
  });

  it('rolls back reversal if replacement contributor is invalid or ID already exists', async () => {
    for (const replacement of [
      body({ memberId: foreignMemberId }),
      await createOriginal(),
    ]) {
      const original = await createOriginal();
      const path = endpoint + '/' + original.id + '/reversals';
      await auth(request(app.getHttpServer()).post(path))
        .send(reversalBody({ replacement }))
        .expect(replacement.memberId === foreignMemberId ? 403 : 409);
      await auth(request(app.getHttpServer()).post(path))
        .send(reversalBody())
        .expect(201);
    }
  });

  it('serializes concurrent distinct reversals to exactly one winner', async () => {
    const original = await createOriginal();
    const path = endpoint + '/' + original.id + '/reversals';
    const results = await Promise.all(
      [0, 1].map(() =>
        auth(request(app.getHttpServer()).post(path)).send(reversalBody()),
      ),
    );
    expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([
      201, 409,
    ]);
  });

  it('serializes concurrent identical reversal replay', async () => {
    const original = await createOriginal();
    const path = endpoint + '/' + original.id + '/reversals';
    const dto = reversalBody();
    const results = await Promise.all(
      [0, 1].map(() => auth(request(app.getHttpServer()).post(path)).send(dto)),
    );
    expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([
      200, 201,
    ]);
    expect(results[0].body).toEqual(results[1].body);
  });

  it('isolates Contribution and Reversal in the extension and raw RLS', async () => {
    const original = await createOriginal();
    await auth(
      request(app.getHttpServer()).post(
        endpoint + '/' + original.id + '/reversals',
      ),
    )
      .send(reversalBody())
      .expect(201);
    await withTestTenant(otherContext, async () => {
      expect(
        await prisma.contribution.findMany({
          where: { contextId: otherContext },
        }),
      ).toEqual([]);
      expect(
        await prisma.contributionReversal.findMany({
          where: { contextId: otherContext },
        }),
      ).toEqual([]);
      await prisma.$transaction(async (tx) => {
        expect(
          await tx.$queryRaw`SELECT id FROM "Contribution" WHERE id = ${original.id}::uuid`,
        ).toEqual([]);
        expect(
          await tx.$queryRaw`SELECT id FROM "ContributionReversal" WHERE "contributionId" = ${original.id}::uuid`,
        ).toEqual([]);
      });
    });
    await auth(
      request(app.getHttpServer()).post(endpoint + '/' + v7() + '/reversals'),
    )
      .send(reversalBody())
      .expect(404);
  });
  it('returns a safe conflict for a UUID already owned by another tenant', async () => {
    const dto = body();
    await withTestTenant(otherContext, async () => {
      const device = await prisma.device.create({
        data: {
          name: 'Other device',
          contextId: otherContext,
          authorized: true,
        },
      });
      await prisma.contribution.create({
        data: {
          id: dto.id as string,
          contextId: otherContext,
          memberId: foreignMemberId,
          createdByMemberId: foreignMemberId,
          createdByAccountId: v7(),
          deviceId: device.id,
          amountMinor: 1,
          occurredAt: new Date(),
          requestFingerprint: 'fixture',
          creationResponse: {},
        },
      });
    });
    await auth(request(app.getHttpServer()).post(endpoint))
      .send(dto)
      .expect(409);
  });
});

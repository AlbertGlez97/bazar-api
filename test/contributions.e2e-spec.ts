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
  let token: string;
  let actorId: string;
  let contributorId: string;
  let collaboratorId: string;
  let deviceId: string;
  let foreignMemberId: string;
  const contextId = `contributions-${randomUUID()}`;
  const otherContext = `contributions-other-${randomUUID()}`;
  const endpoint = '/finance/contributions';
  const auth = (req: request.Test, memberId = actorId) =>
    req
      .auth(token, { type: 'bearer' })
      .set('x-member-id', memberId)
      .set('x-device-id', deviceId);
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
    const account = await prisma.account.create({
      data: {
        username: randomUUID(),
        passwordHash: 'not-a-login-fixture',
        contextId,
      },
    });
    token = await app.get(JwtService).signAsync({ sub: account.id });
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
      await withTestTenant(contextId, async () => {
        if ('contribution' in prisma)
          await prisma.contribution.deleteMany({ where: { contextId } });
        await prisma.device.deleteMany({ where: { contextId } });
        await prisma.member.deleteMany({ where: { contextId } });
      });
      await withTestTenant(otherContext, () =>
        prisma.member.deleteMany({ where: { contextId: otherContext } }),
      );
      await prisma.account.deleteMany({ where: { contextId } });
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
    expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([200, 201]);
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
});

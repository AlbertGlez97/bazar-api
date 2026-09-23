import { randomUUID } from 'node:crypto';
import { Controller, Get, INestApplication, UseGuards } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { verify } from 'argon2';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { ContextGuard } from '../src/auth/context.guard.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { DatabaseModule } from '../src/database/database.module.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { seedContext } from '../prisma/seed-data.js';

// This endpoint exists only in the test application, not in the shipped API.
@Controller('test-context')
class ContextProbe {
  @Get()
  @UseGuards(ContextGuard)
  check() {
    return { ok: true };
  }
}

describe('authenticated context', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  const contextId = `be03-${randomUUID()}`;
  const otherContext = `be03-other-${randomUUID()}`;
  const username = `be03-${randomUUID()}`;
  const password = randomUUID();
  let token: string;
  let memberId: string;
  let deviceId: string;
  let otherMemberId: string;
  let otherDeviceId: string;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule, AuthModule, DatabaseModule],
      controllers: [ContextProbe],
    }).compile();
    app = module.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    jwt = app.get(JwtService);
    await seedContext(prisma, { contextId, username, password });
    memberId = (
      await prisma.member.findFirstOrThrow({
        where: { contextId, name: 'Alberto' },
      })
    ).id;
    deviceId = (
      await prisma.device.findUniqueOrThrow({
        where: { identifier: 'shared-tablet' },
      })
    ).id;
    await prisma.member.create({
      data: { name: 'Test collaborator', role: 'colaborador', contextId },
    });
    otherMemberId = (
      await prisma.member.create({
        data: { name: 'Other context', contextId: otherContext },
      })
    ).id;
    otherDeviceId = (
      await prisma.device.create({
        data: {
          name: 'Other device',
          identifier: randomUUID(),
          contextId: otherContext,
          authorized: true,
        },
      })
    ).id;
    const response = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ username, password })
      .expect(200);
    token = response.body.accessToken;
  });

  afterAll(async () => {
    if (prisma) {
      const where = { contextId: { in: [contextId, otherContext] } };
      await prisma.account.deleteMany({ where });
      await prisma.device.deleteMany({ where });
      await prisma.member.deleteMany({ where });
    }
    await app?.close();
  });

  it('seeds twice without duplicates or password reset', async () => {
    const before = await prisma.account.findUniqueOrThrow({
      where: { username },
    });
    expect(before.passwordHash).not.toBe(password);
    expect(await verify(before.passwordHash, password)).toBe(true);
    await seedContext(prisma, {
      contextId,
      username,
      password: 'different-password-ignored',
    });
    expect(await prisma.account.count({ where: { username } })).toBe(1);
    expect(
      await prisma.member.count({ where: { contextId, role: 'socio' } }),
    ).toBe(2);
    expect(await prisma.device.count({ where: { contextId } })).toBe(3);
    expect(
      (await prisma.account.findUniqueOrThrow({ where: { username } }))
        .passwordHash,
    ).toBe(before.passwordHash);
  });
  it('rolls back attempts to move seeded identities to another context', async () => {
    const conflictingUsername = `conflict-${randomUUID()}`;
    await expect(
      seedContext(prisma, {
        contextId: otherContext,
        username: conflictingUsername,
        password,
      }),
    ).rejects.toThrow('context mismatch');
    expect(
      await prisma.account.count({ where: { username: conflictingUsername } }),
    ).toBe(0);
  });
  it('issues a scoped expiring token without secrets', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ username, password })
      .expect(200);
    expect(res.body).toEqual({
      accessToken: expect.any(String),
      tokenType: 'Bearer',
      // 12h (BE-07): see JWT_EXPIRES_IN_SECONDS.
      expiresIn: 43200,
    });
    const payload = await jwt.verifyAsync(res.body.accessToken);
    expect(payload.exp - payload.iat).toBe(43200);
    expect(payload.passwordHash).toBeUndefined();
  });
  it.each([
    { username, password: 'wrong' },
    { username: 'unknown', password },
  ])('rejects invalid credentials identically', async (credentials) => {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send(credentials)
      .expect(401);
    expect(res.body.message).toBe('Invalid credentials');
  });
  it.each([
    { username: 12, password },
    { username, password: 123 },
    { username, password, contextId: otherContext },
  ])('rejects malformed login', async (body) => {
    await request(app.getHttpServer())
      .post('/auth/login')
      .send(body)
      .expect(400);
  });
  it('requires valid, unexpired JWTs', async () => {
    await request(app.getHttpServer()).get('/members').expect(401);
    await request(app.getHttpServer())
      .get('/members')
      .set('Authorization', 'Bearer invalid')
      .expect(401);
    const account = await prisma.account.findUniqueOrThrow({
      where: { username },
    });
    const expired = await jwt.signAsync({ sub: account.id }, { expiresIn: -1 });
    await request(app.getHttpServer())
      .get('/members')
      .set('Authorization', `Bearer ${expired}`)
      .expect(401);
    const wrongAudience = await jwt.signAsync(
      { sub: account.id },
      { audience: 'other-client' },
    );
    await request(app.getHttpServer())
      .get('/members')
      .auth(wrongAudience, { type: 'bearer' })
      .expect(401);
    const malformedSubject = await jwt.signAsync({ sub: 'not-a-uuid' });
    await request(app.getHttpServer())
      .get('/members')
      .auth(malformedSubject, { type: 'bearer' })
      .expect(401);
  });
  it('lists both roles only inside the authenticated context', async () => {
    const res = await request(app.getHttpServer())
      .get('/members')
      .auth(token, { type: 'bearer' })
      .expect(200);
    expect(res.body).toHaveLength(3);
    expect(res.body.map((item: { role: string }) => item.role)).toContain(
      'colaborador',
    );
    expect(res.body.map((item: { id: string }) => item.id)).not.toContain(
      otherMemberId,
    );
  });
  it('identifies only the known authorized device', async () => {
    await request(app.getHttpServer())
      .post('/devices/identify')
      .send({ identifier: 'shared-tablet', name: 'Shared tablet' })
      .expect(401);
    const res = await request(app.getHttpServer())
      .post('/devices/identify')
      .auth(token, { type: 'bearer' })
      .send({ identifier: 'shared-tablet', name: 'Shared tablet' })
      .expect(200);
    expect(res.body).toEqual({ deviceId });
    await request(app.getHttpServer())
      .post('/devices/identify')
      .auth(token, { type: 'bearer' })
      .send({ identifier: 'unknown', name: 'Unknown' })
      .expect(403);
    const foreign = await prisma.device.findUniqueOrThrow({
      where: { id: otherDeviceId },
    });
    await request(app.getHttpServer())
      .post('/devices/identify')
      .auth(token, { type: 'bearer' })
      .send({ identifier: foreign.identifier, name: foreign.name })
      .expect(403);
  });
  it('accepts same-context selection and rejects cross-context or missing selection', async () => {
    const probe = () =>
      request(app.getHttpServer())
        .get('/test-context')
        .auth(token, { type: 'bearer' });
    await probe()
      .set('x-member-id', memberId)
      .set('x-device-id', deviceId)
      .expect(200);
    await probe()
      .set('x-member-id', otherMemberId)
      .set('x-device-id', deviceId)
      .expect(403);
    await probe()
      .set('x-member-id', memberId)
      .set('x-device-id', otherDeviceId)
      .expect(403);
    await probe().expect(403);
  });
  it('respects device revocation, including after seed rerun', async () => {
    await prisma.device.update({
      where: { id: deviceId },
      data: { authorized: false },
    });
    try {
      await seedContext(prisma, { contextId, username, password });
      await request(app.getHttpServer())
        .post('/devices/identify')
        .auth(token, { type: 'bearer' })
        .send({ identifier: 'shared-tablet', name: 'Shared tablet' })
        .expect(403);
      await request(app.getHttpServer())
        .get('/test-context')
        .auth(token, { type: 'bearer' })
        .set('x-member-id', memberId)
        .set('x-device-id', deviceId)
        .expect(403);
    } finally {
      await prisma.device.update({
        where: { id: deviceId },
        data: { authorized: true },
      });
    }
  });
  it('rejects disabled accounts even with an already issued token', async () => {
    await prisma.account.update({
      where: { username },
      data: { active: false },
    });
    try {
      await request(app.getHttpServer())
        .get('/members')
        .auth(token, { type: 'bearer' })
        .expect(401);
    } finally {
      await prisma.account.update({
        where: { username },
        data: { active: true },
      });
    }
  });
  it('uses the current account context instead of trusting stale token claims', async () => {
    await prisma.account.update({
      where: { username },
      data: { contextId: otherContext },
    });
    try {
      await request(app.getHttpServer())
        .get('/test-context')
        .auth(token, { type: 'bearer' })
        .set('x-member-id', memberId)
        .set('x-device-id', deviceId)
        .expect(403);
    } finally {
      await prisma.account.update({ where: { username }, data: { contextId } });
    }
  });
});

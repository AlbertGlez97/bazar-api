import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { withTestTenant } from './tenant-scope.js';

/**
 * Security follow-up of BE-12: `GET /auth/me` tells the frontend which Member
 * (if any) the logged-in account is bound to, so a bound login never gets the
 * person selector (a bound colaborador could otherwise pick "socio" and get
 * the socio UI, even though every data call is refused by ContextGuard).
 *
 * Only `AuthGuard` runs: the frontend calls it right after login, before it
 * has chosen a device or a member, so no `x-member-id` / `x-device-id` header
 * is ever sent here.
 */
describe('auth: who am I (GET /auth/me)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;

  const contextId = `auth-me-${randomUUID()}`;
  const otherContextId = `auth-me-other-${randomUUID()}`;

  let socioId: string;
  let colaboradorId: string;
  let inactiveMemberId: string;
  let foreignMemberId: string;

  const http = () => request(app.getHttpServer());
  const accounts: string[] = [];

  /** Account.memberId is UNIQUE: every bound account needs its own member. */
  const freshMember = (role: 'socio' | 'colaborador', name: string) =>
    withTestTenant(contextId, () =>
      prisma.member.create({ data: { name, role, contextId } }),
    );

  const tokenFor = async (data: {
    username?: string;
    contextId?: string;
    memberId?: string;
    active?: boolean;
  }) => {
    const account = await prisma.account.create({
      data: {
        username: data.username ?? randomUUID(),
        passwordHash: 'not-a-login-fixture',
        contextId: data.contextId ?? contextId,
        ...(data.memberId ? { memberId: data.memberId } : {}),
        ...(data.active === false ? { active: false } : {}),
      },
    });
    accounts.push(account.id);
    return { token: await jwt.signAsync({ sub: account.id }), account };
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    jwt = app.get(JwtService);

    await withTestTenant(contextId, async () => {
      socioId = (
        await prisma.member.create({
          data: { name: 'Me Socio', role: 'socio', contextId },
        })
      ).id;
      colaboradorId = (
        await prisma.member.create({
          data: { name: 'Me Colaborador', role: 'colaborador', contextId },
        })
      ).id;
      inactiveMemberId = (
        await prisma.member.create({
          data: {
            name: 'Me Inactive',
            role: 'colaborador',
            contextId,
            active: false,
          },
        })
      ).id;
    });
    await withTestTenant(otherContextId, async () => {
      foreignMemberId = (
        await prisma.member.create({
          data: {
            name: 'Foreign Secret Name',
            role: 'socio',
            contextId: otherContextId,
          },
        })
      ).id;
    });
  });

  afterAll(async () => {
    if (prisma) {
      // Accounts first: Account.memberId is ON DELETE RESTRICT.
      await prisma.account.deleteMany({ where: { id: { in: accounts } } });
      for (const ctx of [contextId, otherContextId]) {
        await withTestTenant(ctx, () =>
          prisma.member.deleteMany({ where: { contextId: ctx } }),
        );
      }
    }
    await app?.close();
  });

  it('reports the bound colaborador with its own member', async () => {
    const { token, account } = await tokenFor({
      username: `colab-${randomUUID()}`,
      memberId: colaboradorId,
    });
    const res = await http()
      .get('/auth/me')
      .auth(token, { type: 'bearer' })
      .expect(200);
    expect(res.body).toEqual({
      username: account.username,
      memberId: colaboradorId,
      member: {
        id: colaboradorId,
        name: 'Me Colaborador',
        role: 'colaborador',
        active: true,
      },
    });
  });

  it('reports a bound socio with its own member', async () => {
    const { token } = await tokenFor({ memberId: socioId });
    const res = await http()
      .get('/auth/me')
      .auth(token, { type: 'bearer' })
      .expect(200);
    expect(res.body.memberId).toBe(socioId);
    expect(res.body.member).toEqual({
      id: socioId,
      name: 'Me Socio',
      role: 'socio',
      active: true,
    });
  });

  it('reports nulls for the shared business login (it still picks its person)', async () => {
    const { token, account } = await tokenFor({});
    const res = await http()
      .get('/auth/me')
      .auth(token, { type: 'bearer' })
      .expect(200);
    expect(res.body).toEqual({
      username: account.username,
      memberId: null,
      member: null,
    });
  });

  it('reports a deactivated bound member as inactive instead of hiding the binding', async () => {
    const { token } = await tokenFor({ memberId: inactiveMemberId });
    const res = await http()
      .get('/auth/me')
      .auth(token, { type: 'bearer' })
      .expect(200);
    expect(res.body.memberId).toBe(inactiveMemberId);
    expect(res.body.member).toMatchObject({
      id: inactiveMemberId,
      active: false,
    });
  });

  it('answers 401 for a deactivated account, a missing token and an invalid token', async () => {
    const { token } = await tokenFor({ active: false });
    await http().get('/auth/me').auth(token, { type: 'bearer' }).expect(401);
    await http().get('/auth/me').expect(401);
    await http()
      .get('/auth/me')
      .auth('not.a.jwt', { type: 'bearer' })
      .expect(401);
  });

  it('exposes EXACTLY the documented keys and no internal field', async () => {
    const own = await freshMember('colaborador', 'Me Keys Colaborador');
    const { token, account } = await tokenFor({ memberId: own.id });
    const res = await http()
      .get('/auth/me')
      .auth(token, { type: 'bearer' })
      .expect(200);
    expect(Object.keys(res.body).sort()).toEqual([
      'member',
      'memberId',
      'username',
    ]);
    expect(Object.keys(res.body.member).sort()).toEqual([
      'active',
      'id',
      'name',
      'role',
    ]);
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain(contextId);
    expect(raw).not.toContain(account.id);
    expect(raw).not.toContain('passwordHash');
    expect(raw).not.toContain('not-a-login-fixture');
  });

  it('works without any x-member-id / x-device-id header and ignores them when sent', async () => {
    const own = await freshMember('colaborador', 'Me Headers Colaborador');
    const { token } = await tokenFor({ memberId: own.id });
    const withHeaders = await http()
      .get('/auth/me')
      .auth(token, { type: 'bearer' })
      .set('x-member-id', socioId)
      .set('x-device-id', randomUUID())
      .expect(200);
    // The header a client sends never changes what the API says about the
    // account: the binding comes from the account row alone.
    expect(withHeaders.body.memberId).toBe(own.id);
    expect(withHeaders.body.member.role).toBe('colaborador');
  });

  it('never reads a member of ANOTHER business, even if a bound account points at one', async () => {
    // The schema does not forbid an Account.memberId pointing at a Member of
    // another context (no composite FK); the lookup must stay scoped to the
    // account's own context so nothing about that member leaks.
    const { token } = await tokenFor({ memberId: foreignMemberId });
    const res = await http()
      .get('/auth/me')
      .auth(token, { type: 'bearer' })
      .expect(200);
    expect(res.body.member).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain('Foreign Secret Name');
  });
});

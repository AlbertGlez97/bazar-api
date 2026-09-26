import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/database/prisma.service.js';
import {
  generateDeviceToken,
  hashDeviceToken,
} from '../src/common/device-secret.js';
import { withTestTenant } from './tenant-scope.js';

/**
 * BE-12 (task T3): what ContextGuard trusts.
 *
 * 1. Member binding. An Account with `memberId` set may only act as THAT
 *    Member; an Account without one (the shared business login every
 *    business has today) keeps choosing any Member of its context.
 * 2. Device token. A device with a `tokenHash` must present the matching
 *    `x-device-token`; a device without one is LEGACY and keeps working with
 *    `x-device-id` alone.
 *
 * `POST /sales` with an empty body is the probe for "did the guard let the
 * request through": guards run before body validation, so a request that
 * passes ContextGuard reaches the validation pipe and answers 400, and one
 * the guard rejects answers 403.
 */
describe('ContextGuard: member binding and device tokens (BE-12)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const contextId = `be12-guard-${randomUUID()}`;

  let sharedToken: string; // unbound account (the legacy shared login)
  let boundColaboradorToken: string; // account bound to the colaborador
  let boundSocioToken: string; // account bound to the socio
  let socioId: string;
  let colaboradorId: string;
  let inactiveMemberId: string;

  let legacyDeviceId: string;
  let deviceAId: string;
  let deviceBId: string;
  let revokedDeviceId: string;
  const tokenA = generateDeviceToken();
  const tokenB = generateDeviceToken();
  const tokenRevoked = generateDeviceToken();

  const GENERIC_403 = 'Selection is not authorized for this context';

  const probe = (
    token: string,
    memberId: string,
    deviceId: string,
    deviceToken?: string | string[],
  ) => {
    const req = request(app.getHttpServer())
      .post('/sales')
      .auth(token, { type: 'bearer' })
      .set('x-member-id', memberId)
      .set('x-device-id', deviceId)
      .send({});
    // superagent's typings only allow a string here, but it accepts an array
    // at runtime and then sends the header once per element. The
    // repeated-header test below relies on exactly that, so the cast is
    // deliberate and not a way to hide a type error.
    if (deviceToken !== undefined) req.set('x-device-token', deviceToken as string);
    return req;
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    const jwt = app.get(JwtService);

    await withTestTenant(contextId, async () => {
      socioId = (
        await prisma.member.create({
          data: { name: 'Guard Socio', role: 'socio', contextId },
        })
      ).id;
      colaboradorId = (
        await prisma.member.create({
          data: { name: 'Guard Colaborador', role: 'colaborador', contextId },
        })
      ).id;
      inactiveMemberId = (
        await prisma.member.create({
          data: {
            name: 'Guard Inactive',
            role: 'colaborador',
            contextId,
            active: false,
          },
        })
      ).id;

      const device = (
        name: string,
        extra: Record<string, unknown> = {},
      ) =>
        prisma.device
          .create({
            data: {
              name,
              identifier: randomUUID(),
              contextId,
              authorized: true,
              ...extra,
            },
          })
          .then((d) => d.id);

      legacyDeviceId = await device('legacy'); // tokenHash null
      deviceAId = await device('tokened A', { tokenHash: hashDeviceToken(tokenA) });
      deviceBId = await device('tokened B', { tokenHash: hashDeviceToken(tokenB) });
      revokedDeviceId = await device('revoked', {
        tokenHash: hashDeviceToken(tokenRevoked),
        authorized: false,
        status: 'revocado',
        revokedAt: new Date(),
      });
    });

    const account = (memberId?: string) =>
      prisma.account
        .create({
          data: {
            username: randomUUID(),
            passwordHash: 'not-a-login-fixture',
            contextId,
            ...(memberId ? { memberId } : {}),
          },
        })
        .then((a) => jwt.signAsync({ sub: a.id }));
    sharedToken = await account();
    boundColaboradorToken = await account(colaboradorId);
    boundSocioToken = await account(socioId);
  });

  afterAll(async () => {
    if (prisma) {
      // Accounts first: Account.memberId is ON DELETE RESTRICT.
      await prisma.account.deleteMany({ where: { contextId } });
      await withTestTenant(contextId, async () => {
        await prisma.product.deleteMany({ where: { contextId } });
        await prisma.device.deleteMany({ where: { contextId } });
        await prisma.member.deleteMany({ where: { contextId } });
      });
    }
    await app?.close();
  });

  describe('member binding', () => {
    it('a bound colaborador account acting as its own member passes', async () => {
      await probe(boundColaboradorToken, colaboradorId, legacyDeviceId).expect(400);
    });

    it('a bound socio account acting as its own member passes', async () => {
      await probe(boundSocioToken, socioId, legacyDeviceId).expect(400);
    });

    it("a bound colaborador account sending a socio's member id is refused with the generic 403", async () => {
      const res = await probe(boundColaboradorToken, socioId, legacyDeviceId).expect(403);
      expect(res.body.message).toBe(GENERIC_403);
    });

    it('a bound account cannot even reach a socio-only route as the socio', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/members/${colaboradorId}`)
        .auth(boundColaboradorToken, { type: 'bearer' })
        .set('x-member-id', socioId)
        .set('x-device-id', legacyDeviceId)
        .send({ name: 'Renamed by an impostor' })
        .expect(403);
      // The refusal must come from the binding check (the generic message),
      // not from any other 403 source on this route, and nothing was written.
      expect(res.body.message).toBe(GENERIC_403);
      await withTestTenant(contextId, async () => {
        const unchanged = await prisma.member.findUniqueOrThrow({
          where: { id: colaboradorId },
        });
        expect(unchanged.name).toBe('Guard Colaborador');
      });
    });

    it('the shared (unbound) account keeps choosing any member of its context', async () => {
      await probe(sharedToken, socioId, legacyDeviceId).expect(400);
      await probe(sharedToken, colaboradorId, legacyDeviceId).expect(400);
    });

    it('GET /members?includeInactive=true: a bound colaborador naming a socio is NOT treated as that socio', async () => {
      const res = await request(app.getHttpServer())
        .get('/members')
        .query({ includeInactive: 'true' })
        .auth(boundColaboradorToken, { type: 'bearer' })
        .set('x-member-id', socioId)
        .expect(200);
      const ids = res.body.map((m: { id: string }) => m.id);
      expect(ids).toContain(socioId);
      expect(ids).not.toContain(inactiveMemberId);
    });

    it('GET /members?includeInactive=true: a bound socio acting as itself sees inactive members', async () => {
      const res = await request(app.getHttpServer())
        .get('/members')
        .query({ includeInactive: 'true' })
        .auth(boundSocioToken, { type: 'bearer' })
        .set('x-member-id', socioId)
        .expect(200);
      expect(res.body.map((m: { id: string }) => m.id)).toContain(inactiveMemberId);
    });

    it('GET /members?includeInactive=true: the shared account naming a socio still sees inactive members (legacy pinned)', async () => {
      const res = await request(app.getHttpServer())
        .get('/members')
        .query({ includeInactive: 'true' })
        .auth(sharedToken, { type: 'bearer' })
        .set('x-member-id', socioId)
        .expect(200);
      expect(res.body.map((m: { id: string }) => m.id)).toContain(inactiveMemberId);
    });

    it('GET /products?includeInactive=true honors the binding the same way', async () => {
      const inactive = await withTestTenant(contextId, () =>
        prisma.product.create({
          data: {
            name: `Guard hidden ${randomUUID()}`,
            tipo: 'cantidad',
            unitPriceMinor: 100,
            initialStock: 1,
            stock: 1,
            contextId,
            active: false,
          },
        }),
      );
      const list = (token: string, memberId: string) =>
        request(app.getHttpServer())
          .get('/products')
          .query({ includeInactive: 'true' })
          .auth(token, { type: 'bearer' })
          .set('x-member-id', memberId)
          .expect(200);
      const has = (body: { items: Array<{ id: string }> }) =>
        body.items.some((p) => p.id === inactive.id);

      expect(has((await list(boundColaboradorToken, socioId)).body)).toBe(false);
      expect(has((await list(boundSocioToken, socioId)).body)).toBe(true);
      expect(has((await list(sharedToken, socioId)).body)).toBe(true);
    });
  });

  describe('device token', () => {
    it('a legacy device (no token hash) works with x-device-id alone', async () => {
      await probe(sharedToken, socioId, legacyDeviceId).expect(400);
    });

    it('a legacy device ignores a token header it does not need', async () => {
      await probe(sharedToken, socioId, legacyDeviceId, 'whatever').expect(400);
    });

    it('a tokened device without its token is refused with the generic 403', async () => {
      const res = await probe(sharedToken, socioId, deviceAId).expect(403);
      expect(res.body.message).toBe(GENERIC_403);
    });

    it('a tokened device with a wrong token is refused', async () => {
      await probe(sharedToken, socioId, deviceAId, generateDeviceToken()).expect(403);
    });

    it('a tokened device with an empty token is refused', async () => {
      await probe(sharedToken, socioId, deviceAId, '').expect(403);
    });

    it('a tokened device with its right token passes', async () => {
      await probe(sharedToken, socioId, deviceAId, tokenA).expect(400);
    });

    it("device A's token does not open device B", async () => {
      await probe(sharedToken, socioId, deviceBId, tokenA).expect(403);
      await probe(sharedToken, socioId, deviceBId, tokenB).expect(400);
    });

    it('a repeated x-device-token header is refused', async () => {
      await probe(sharedToken, socioId, deviceAId, [tokenA, tokenA]).expect(403);
    });

    it('a revoked device is refused even with its right token', async () => {
      const res = await probe(sharedToken, socioId, revokedDeviceId, tokenRevoked).expect(403);
      expect(res.body.message).toBe(GENERIC_403);
    });

    it('the binding and the token are both required when both apply', async () => {
      await probe(boundColaboradorToken, colaboradorId, deviceAId, tokenA).expect(400);
      await probe(boundColaboradorToken, socioId, deviceAId, tokenA).expect(403);
      await probe(boundColaboradorToken, colaboradorId, deviceAId).expect(403);
    });
  });
});

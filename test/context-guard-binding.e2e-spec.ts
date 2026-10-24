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
 * One account per person: what ContextGuard trusts.
 *
 * 1. The person comes ONLY from `account.memberId`. The `x-member-id` header
 *    is ignored, so it cannot be used to act as someone else.
 * 2. An account with no person assigned is refused with a clear message.
 * 3. Device token. A device with a `tokenHash` must present the matching
 *    `x-device-token`; a device without one is LEGACY and keeps working with
 *    `x-device-id` alone.
 *
 * `POST /sales` with an empty body is the probe for "did the guard let the
 * request through": guards run before body validation, so a request that
 * passes ContextGuard reaches the validation pipe and answers 400, and one
 * the guard rejects answers 403.
 */
describe('ContextGuard: one account per person', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const contextId = `one-acct-guard-${randomUUID()}`;

  let unassignedToken: string; // account without a person
  let colaboradorToken: string; // account of the colaborador
  let socioToken: string; // account of the socio
  let inactiveToken: string; // account of a deactivated person
  let socioId: string;
  let colaboradorId: string;

  let legacyDeviceId: string;
  let deviceAId: string;
  let deviceBId: string;
  let revokedDeviceId: string;
  const tokenA = generateDeviceToken();
  const tokenB = generateDeviceToken();
  const tokenRevoked = generateDeviceToken();

  const GENERIC_403 = 'Selection is not authorized for this context';
  const NO_PERSON = 'Tu cuenta no tiene una persona asignada';

  const probe = (
    token: string,
    deviceId: string,
    deviceToken?: string | string[],
    memberHeader?: string,
  ) => {
    const req = request(app.getHttpServer())
      .post('/sales')
      .auth(token, { type: 'bearer' })
      .set('x-device-id', deviceId)
      .send({});
    if (memberHeader !== undefined) req.set('x-member-id', memberHeader);
    // superagent's typings only allow a string here, but it accepts an array
    // at runtime and then sends the header once per element. The
    // repeated-header test below relies on exactly that, so the cast is
    // deliberate and not a way to hide a type error.
    if (deviceToken !== undefined)
      req.set('x-device-token', deviceToken as string);
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

    let inactiveMemberId = '';
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

      const device = (name: string, extra: Record<string, unknown> = {}) =>
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
      deviceAId = await device('tokened A', {
        tokenHash: hashDeviceToken(tokenA),
      });
      deviceBId = await device('tokened B', {
        tokenHash: hashDeviceToken(tokenB),
      });
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
    unassignedToken = await account();
    colaboradorToken = await account(colaboradorId);
    socioToken = await account(socioId);
    inactiveToken = await account(inactiveMemberId);
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

  describe('the person comes from the account', () => {
    it('a colaborador account passes without sending any member header', async () => {
      await probe(colaboradorToken, legacyDeviceId).expect(400);
    });

    it('a socio account passes without sending any member header', async () => {
      await probe(socioToken, legacyDeviceId).expect(400);
    });

    it('an account with no person is refused with a clear message', async () => {
      const res = await probe(unassignedToken, legacyDeviceId).expect(403);
      expect(res.body.message).toBe(NO_PERSON);
    });

    it('an account with no person is refused even if it names a valid member', async () => {
      const res = await probe(
        unassignedToken,
        legacyDeviceId,
        undefined,
        socioId,
      ).expect(403);
      expect(res.body.message).toBe(NO_PERSON);
    });

    it("a colaborador sending a socio's x-member-id is still the colaborador", async () => {
      // The guard ignores the header, so the request passes as the colaborador.
      await probe(colaboradorToken, legacyDeviceId, undefined, socioId).expect(
        400,
      );
    });

    it('a manipulated x-member-id never reaches a socio-only route', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/members/${colaboradorId}`)
        .auth(colaboradorToken, { type: 'bearer' })
        .set('x-member-id', socioId)
        .set('x-device-id', legacyDeviceId)
        .send({ name: 'Renamed by an impostor' })
        .expect(403);
      expect(res.body.message).not.toBe(NO_PERSON);
      await withTestTenant(contextId, async () => {
        const unchanged = await prisma.member.findUniqueOrThrow({
          where: { id: colaboradorId },
        });
        expect(unchanged.name).toBe('Guard Colaborador');
      });
    });

    it('a malformed x-member-id does not matter either', async () => {
      await probe(socioToken, legacyDeviceId, undefined, 'not-a-uuid').expect(
        400,
      );
    });

    it('the account of a deactivated person is refused with the generic 403', async () => {
      const res = await probe(inactiveToken, legacyDeviceId).expect(403);
      expect(res.body.message).toBe(GENERIC_403);
    });

    it('a missing device is still refused', async () => {
      await request(app.getHttpServer())
        .post('/sales')
        .auth(socioToken, { type: 'bearer' })
        .send({})
        .expect(403);
    });

    it('GET /members?includeInactive=true: a colaborador naming a socio is NOT treated as that socio', async () => {
      const res = await request(app.getHttpServer())
        .get('/members')
        .query({ includeInactive: 'true' })
        .auth(colaboradorToken, { type: 'bearer' })
        .set('x-member-id', socioId)
        .expect(200);
      const ids = res.body.map((m: { id: string }) => m.id);
      expect(ids).toContain(socioId);
      expect(ids).toHaveLength(2);
    });

    it('GET /members?includeInactive=true: a socio sees inactive members with no header', async () => {
      const res = await request(app.getHttpServer())
        .get('/members')
        .query({ includeInactive: 'true' })
        .auth(socioToken, { type: 'bearer' })
        .expect(200);
      expect(res.body).toHaveLength(3);
    });

    it('GET /products?includeInactive=true follows the account, not the header', async () => {
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
      const list = (token: string, header?: string) => {
        const req = request(app.getHttpServer())
          .get('/products')
          .query({ includeInactive: 'true' })
          .auth(token, { type: 'bearer' });
        if (header) req.set('x-member-id', header);
        return req.expect(200);
      };
      const has = (body: { items: Array<{ id: string }> }) =>
        body.items.some((p) => p.id === inactive.id);

      expect(has((await list(colaboradorToken, socioId)).body)).toBe(false);
      expect(has((await list(socioToken)).body)).toBe(true);
      expect(has((await list(unassignedToken, socioId)).body)).toBe(false);
    });
  });

  describe('device token', () => {
    it('a legacy device (no token hash) works with x-device-id alone', async () => {
      await probe(socioToken, legacyDeviceId).expect(400);
    });

    it('a legacy device ignores a token header it does not need', async () => {
      await probe(socioToken, legacyDeviceId, 'whatever').expect(400);
    });

    it('a tokened device without its token is refused with the generic 403', async () => {
      const res = await probe(socioToken, deviceAId).expect(403);
      expect(res.body.message).toBe(GENERIC_403);
    });

    it('a tokened device with a wrong token is refused', async () => {
      await probe(socioToken, deviceAId, generateDeviceToken()).expect(403);
    });

    it('a tokened device with an empty token is refused', async () => {
      await probe(socioToken, deviceAId, '').expect(403);
    });

    it('a tokened device with its right token passes', async () => {
      await probe(socioToken, deviceAId, tokenA).expect(400);
    });

    it("device A's token does not open device B", async () => {
      await probe(socioToken, deviceBId, tokenA).expect(403);
      await probe(socioToken, deviceBId, tokenB).expect(400);
    });

    it('a repeated x-device-token header is refused', async () => {
      await probe(socioToken, deviceAId, [tokenA, tokenA]).expect(403);
    });

    it('a revoked device is refused even with its right token', async () => {
      const res = await probe(socioToken, revokedDeviceId, tokenRevoked).expect(
        403,
      );
      expect(res.body.message).toBe(GENERIC_403);
    });
  });
});

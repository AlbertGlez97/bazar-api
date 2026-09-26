import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { EmailService } from '../src/email/email.service.js';
import {
  generateDeviceToken,
  hashDeviceToken,
} from '../src/common/device-secret.js';
import { withTestTenant } from './tenant-scope.js';
import { expectUuidV7 } from './uuid-v7.js';

/**
 * BE-12 (task T4): device management with one-time activation.
 *
 * A socio creates a device (`POST /devices`): it starts as
 * `pendiente_activacion` with a one-time `identifier`. The person types the
 * identifier and the exact name in the app (`POST /devices/identify`), which
 * activates it ONCE and hands out a `deviceToken` (only its hash is stored).
 * A socio can `revoke` or `reissue` it. Devices that existed before BE-12
 * (no `tokenHash`) are LEGACY: they keep identifying with `x-device-id` alone
 * until a socio reissues them.
 *
 * `POST /sales` with an empty body is the probe for "did ContextGuard let the
 * request through": it answers 400 when the guard passes and 403 when it does
 * not (guards run before body validation).
 */
describe('devices: management and one-time activation (BE-12)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const sendActivation = vi.fn();

  const contextId = `be12-devices-${randomUUID()}`;
  const otherContextId = `be12-devices-other-${randomUUID()}`;

  let sharedToken: string; // unbound login (the shared business login)
  let boundColaboradorToken: string; // login bound to the colaborador
  let otherToken: string; // login of the other business
  let socioId: string;
  let colaboradorId: string;
  let otherSocioId: string;
  let actingDeviceId: string; // a legacy device used as x-device-id by the socio
  let otherActingDeviceId: string;
  let otherContextDeviceId: string;

  const NOT_FOUND_403 = 'Device is unknown or unauthorized';
  const USED_409 =
    'Este identificador ya fue usado. Pide a un socio que te genere uno nuevo.';

  const asSocio = (req: request.Test) =>
    req
      .auth(sharedToken, { type: 'bearer' })
      .set('x-member-id', socioId)
      .set('x-device-id', actingDeviceId);

  const asSharedColaborador = (req: request.Test) =>
    req
      .auth(sharedToken, { type: 'bearer' })
      .set('x-member-id', colaboradorId)
      .set('x-device-id', actingDeviceId);

  const asBoundColaborador = (req: request.Test) =>
    req
      .auth(boundColaboradorToken, { type: 'bearer' })
      .set('x-member-id', colaboradorId)
      .set('x-device-id', actingDeviceId);

  const http = () => request(app.getHttpServer());

  const probe = (deviceId: string, deviceToken?: string) => {
    const req = http()
      .post('/sales')
      .auth(sharedToken, { type: 'bearer' })
      .set('x-member-id', socioId)
      .set('x-device-id', deviceId)
      .send({});
    if (deviceToken !== undefined) req.set('x-device-token', deviceToken);
    return req;
  };

  const identify = (identifier: string, name: string, token = sharedToken) =>
    http()
      .post('/devices/identify')
      .auth(token, { type: 'bearer' })
      .send({ identifier, name });

  const row = (id: string) =>
    withTestTenant(contextId, () =>
      prisma.device.findUniqueOrThrow({ where: { id } }),
    );

  const create = async (name: string) => {
    const res = await asSocio(http().post('/devices')).send({ name }).expect(201);
    return res.body as {
      id: string;
      name: string;
      status: string;
      identifier: string;
    };
  };

  /** Creates and activates a device through the API; returns its credentials. */
  const activated = async (name: string) => {
    const device = await create(name);
    const res = await identify(device.identifier, name).expect(200);
    return {
      id: device.id as string,
      name,
      identifier: device.identifier,
      token: res.body.deviceToken as string,
    };
  };

  /** Raw fixture, outside the API (used for legacy and inconsistent rows). */
  const fixtureDevice = (data: Record<string, unknown>) =>
    withTestTenant(contextId, () =>
      prisma.device.create({
        data: {
          name: `fixture ${randomUUID()}`,
          identifier: randomUUID(),
          contextId,
          authorized: true,
          ...data,
        },
      }),
    );

  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EmailService)
      .useValue({ sendDeviceActivationEmail: sendActivation })
      .compile();
    app = module.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    const jwt = app.get(JwtService);

    await withTestTenant(contextId, async () => {
      socioId = (
        await prisma.member.create({
          data: { name: 'Devices Socio', role: 'socio', contextId },
        })
      ).id;
      colaboradorId = (
        await prisma.member.create({
          data: { name: 'Devices Colaborador', role: 'colaborador', contextId },
        })
      ).id;
      actingDeviceId = (
        await prisma.device.create({
          data: {
            name: 'acting legacy',
            identifier: randomUUID(),
            contextId,
            authorized: true,
          },
        })
      ).id;
    });
    await withTestTenant(otherContextId, async () => {
      otherSocioId = (
        await prisma.member.create({
          data: { name: 'Other Socio', role: 'socio', contextId: otherContextId },
        })
      ).id;
      otherActingDeviceId = (
        await prisma.device.create({
          data: {
            name: 'other acting',
            identifier: randomUUID(),
            contextId: otherContextId,
            authorized: true,
          },
        })
      ).id;
      otherContextDeviceId = (
        await prisma.device.create({
          data: {
            name: 'other business device',
            identifier: randomUUID(),
            contextId: otherContextId,
            authorized: true,
          },
        })
      ).id;
    });

    const account = (ctx: string, memberId?: string) =>
      prisma.account
        .create({
          data: {
            username: randomUUID(),
            passwordHash: 'not-a-login-fixture',
            contextId: ctx,
            ...(memberId ? { memberId } : {}),
          },
        })
        .then((a) => jwt.signAsync({ sub: a.id }));
    sharedToken = await account(contextId);
    boundColaboradorToken = await account(contextId, colaboradorId);
    otherToken = await account(otherContextId);
  });

  beforeEach(() => {
    sendActivation.mockReset();
    sendActivation.mockResolvedValue({ deliveredTo: 'recipient' });
  });

  afterAll(async () => {
    if (prisma) {
      // Accounts first: Account.memberId is ON DELETE RESTRICT.
      await prisma.account.deleteMany({
        where: { contextId: { in: [contextId, otherContextId] } },
      });
      for (const ctx of [contextId, otherContextId]) {
        await withTestTenant(ctx, async () => {
          await prisma.product.deleteMany({ where: { contextId: ctx } });
          await prisma.device.deleteMany({ where: { contextId: ctx } });
          await prisma.member.deleteMany({ where: { contextId: ctx } });
        });
      }
    }
    await app?.close();
  });

  describe('POST /devices', () => {
    it('creates a pending device with a one-time identifier and returns it when nothing is emailed', async () => {
      const res = await asSocio(http().post('/devices'))
        .send({ name: 'Tablet mostrador' })
        .expect(201);

      expect(res.body).toMatchObject({
        name: 'Tablet mostrador',
        status: 'pendiente_activacion',
        legacy: false,
      });
      expectUuidV7(res.body.id);
      expectUuidV7(res.body.identifier);
      expect(res.body).not.toHaveProperty('deviceToken');
      expect(res.body).not.toHaveProperty('tokenHash');
      expect(sendActivation).not.toHaveBeenCalled();

      const stored = await row(res.body.id);
      expect(stored).toMatchObject({
        name: 'Tablet mostrador',
        identifier: res.body.identifier,
        status: 'pendiente_activacion',
        authorized: false,
        tokenHash: null,
        activatedAt: null,
        revokedAt: null,
      });
    });

    it('emails the code and does NOT return the identifier when correoEnvio is given', async () => {
      const res = await asSocio(http().post('/devices'))
        .send({ name: 'Telefono de Ana', correoEnvio: 'ana@example.test' })
        .expect(201);

      expect(res.body).toMatchObject({
        name: 'Telefono de Ana',
        status: 'pendiente_activacion',
        deliveredTo: 'recipient',
      });
      expect(res.body).not.toHaveProperty('identifier');
      expect(sendActivation).toHaveBeenCalledTimes(1);
      const sent = sendActivation.mock.calls[0][0] as {
        to: string;
        deviceName: string;
        identifier: string;
      };
      const stored = await row(res.body.id);
      expect(sent).toMatchObject({
        to: 'ana@example.test',
        deviceName: 'Telefono de Ana',
        identifier: stored.identifier,
      });
      expect(JSON.stringify(res.body)).not.toContain(stored.identifier);
    });

    it('reports when the code went to the approver as a backup', async () => {
      sendActivation.mockResolvedValue({ deliveredTo: 'approver-fallback' });

      const res = await asSocio(http().post('/devices'))
        .send({ name: 'Telefono con respaldo', correoEnvio: 'x@example.test' })
        .expect(201);

      expect(res.body.deliveredTo).toBe('approver-fallback');
    });

    it('rolls the device back and answers 502 when the email cannot be sent', async () => {
      sendActivation.mockRejectedValue(new Error('Resend is down'));

      const res = await asSocio(http().post('/devices'))
        .send({ name: 'Nunca se crea', correoEnvio: 'ana@example.test' })
        .expect(502);

      expect(JSON.stringify(res.body)).not.toContain('Resend is down');
      const leftovers = await withTestTenant(contextId, () =>
        prisma.device.count({ where: { name: 'Nunca se crea' } }),
      );
      expect(leftovers).toBe(0);
    });

    it('trims the name so the person types exactly what the email shows', async () => {
      const res = await asSocio(http().post('/devices'))
        .send({ name: '  Con espacios  ' })
        .expect(201);
      expect(res.body.name).toBe('Con espacios');
    });

    it.each([
      ['a missing name', {}],
      ['a blank name', { name: '   ' }],
      ['a name over 100 characters', { name: 'x'.repeat(101) }],
      ['a malformed correoEnvio', { name: 'ok', correoEnvio: 'not-an-email' }],
      ['an unknown field', { name: 'ok', identifier: 'chosen-by-client' }],
      ['a client-chosen status', { name: 'ok', status: 'activo' }],
    ])('rejects %s with 400', async (_label, body) => {
      await asSocio(http().post('/devices')).send(body).expect(400);
      expect(sendActivation).not.toHaveBeenCalled();
    });
  });

  describe('POST /devices/identify', () => {
    it('activates a pending device once and returns the token only in that response', async () => {
      const device = await create('Activacion feliz');

      const res = await identify(device.identifier, 'Activacion feliz').expect(200);

      expect(res.body.deviceId).toBe(device.id);
      expect(typeof res.body.deviceToken).toBe('string');
      expect(res.body.deviceToken.length).toBeGreaterThanOrEqual(43);
      const stored = await row(device.id);
      expect(stored).toMatchObject({
        status: 'activo',
        authorized: true,
        tokenHash: hashDeviceToken(res.body.deviceToken),
      });
      expect(stored.tokenHash).not.toBe(res.body.deviceToken);
      expect(stored.activatedAt).not.toBeNull();
      expect(stored.revokedAt).toBeNull();
    });

    it('the returned token authenticates a ContextGuard route; x-device-id alone no longer does', async () => {
      const { id, token } = await activated('Token funciona');

      await probe(id, token).expect(400); // passed the guard
      await probe(id).expect(403);
      await probe(id, generateDeviceToken()).expect(403);
    });

    it('a used identifier answers 409 with the exact message, different from wrong credentials', async () => {
      const { identifier, name } = await activated('Uso unico');

      const reused = await identify(identifier, name).expect(409);
      expect(reused.body.message).toBe(USED_409);

      const wrong = await identify(identifier, 'Otro nombre').expect(403);
      expect(wrong.body.message).toBe(NOT_FOUND_403);
      expect(reused.body).not.toEqual(wrong.body);
    });

    it('a wrong name, an unknown identifier and another business identifier all answer the same 403', async () => {
      const device = await create('Nombre exacto');
      const foreign = await withTestTenant(otherContextId, () =>
        prisma.device.findUniqueOrThrow({ where: { id: otherContextDeviceId } }),
      );

      const wrongName = await identify(device.identifier, 'nombre exacto').expect(403);
      const unknown = await identify(randomUUID(), 'Nombre exacto').expect(403);
      const foreignOne = await identify(foreign.identifier, foreign.name).expect(403);

      for (const res of [wrongName, unknown, foreignOne])
        expect(res.body.message).toBe(NOT_FOUND_403);
      // The failed attempts burned nothing.
      expect((await row(device.id)).status).toBe('pendiente_activacion');
    });

    it('exactly one of several concurrent activations wins; the others get the 409', async () => {
      const device = await create('Carrera');

      const results = await Promise.all(
        [1, 2, 3].map(() => identify(device.identifier, 'Carrera')),
      );

      const winners = results.filter((r) => r.status === 200);
      const losers = results.filter((r) => r.status === 409);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(2);
      for (const loser of losers) expect(loser.body.message).toBe(USED_409);
      // Only the winner's token is the stored one.
      expect((await row(device.id)).tokenHash).toBe(
        hashDeviceToken(winners[0].body.deviceToken),
      );
    });

    it('keeps the legacy behavior for a device that existed before BE-12: 200 with the id only', async () => {
      const legacy = await fixtureDevice({ name: 'Legacy', identifier: 'legacy-id' });

      const res = await identify('legacy-id', 'Legacy').expect(200);

      expect(res.body).toEqual({ deviceId: legacy.id });
      expect((await row(legacy.id)).tokenHash).toBeNull();
    });

    it('an unauthorized legacy device is still the plain 403', async () => {
      await fixtureDevice({
        name: 'Off',
        identifier: 'legacy-off',
        authorized: false,
      });

      const res = await identify('legacy-off', 'Off').expect(403);

      expect(res.body.message).toBe(NOT_FOUND_403);
    });

    it('a revoked device answers 409 saying it was revoked', async () => {
      const { id, identifier, name } = await activated('Revocado y usado');
      await asSocio(http().patch(`/devices/${id}/revoke`)).expect(200);

      const res = await identify(identifier, name).expect(409);

      expect(res.body.message).toMatch(/revocado/i);
      expect(res.body.message).not.toBe(USED_409);
    });

    it('requires a login', async () => {
      await http()
        .post('/devices/identify')
        .send({ identifier: 'x', name: 'y' })
        .expect(401);
    });

    it('rejects unknown fields with 400', async () => {
      await http()
        .post('/devices/identify')
        .auth(sharedToken, { type: 'bearer' })
        .send({ identifier: 'x', name: 'y', status: 'activo' })
        .expect(400);
    });
  });

  describe('PATCH /devices/:id/revoke', () => {
    it('invalidates the token on the very next request and keeps the token hash', async () => {
      const { id, token } = await activated('A revocar');
      await probe(id, token).expect(400);

      const res = await asSocio(http().patch(`/devices/${id}/revoke`)).expect(200);

      expect(res.body).toMatchObject({ id, status: 'revocado', legacy: false });
      await probe(id, token).expect(403);
      const stored = await row(id);
      expect(stored).toMatchObject({ status: 'revocado', authorized: false });
      expect(stored.revokedAt).not.toBeNull();
      // Nulling it would make the device look LEGACY and open the x-device-id path.
      expect(stored.tokenHash).toBe(hashDeviceToken(token));
      await probe(id).expect(403);
    });

    it('is idempotent', async () => {
      const { id } = await activated('Idempotente');
      await asSocio(http().patch(`/devices/${id}/revoke`)).expect(200);
      const first = await row(id);

      await asSocio(http().patch(`/devices/${id}/revoke`)).expect(200);

      const second = await row(id);
      expect(second.status).toBe('revocado');
      expect(second.revokedAt).toEqual(first.revokedAt);
    });

    it('revokes a legacy device too', async () => {
      const legacy = await fixtureDevice({ name: 'Legacy a revocar' });
      await probe(legacy.id).expect(400);

      await asSocio(http().patch(`/devices/${legacy.id}/revoke`)).expect(200);

      await probe(legacy.id).expect(403);
    });

    it('cancels a pending code', async () => {
      const device = await create('Pendiente cancelado');

      await asSocio(http().patch(`/devices/${device.id}/revoke`)).expect(200);

      expect((await row(device.id)).status).toBe('revocado');
      await identify(device.identifier, 'Pendiente cancelado').expect(409);
    });

    it('answers 404 for a device of another business and 400 for a malformed id', async () => {
      await asSocio(http().patch(`/devices/${otherContextDeviceId}/revoke`)).expect(404);
      await asSocio(http().patch(`/devices/${randomUUID()}/revoke`)).expect(404);
      await asSocio(http().patch('/devices/not-a-uuid/revoke')).expect(400);
      const untouched = await withTestTenant(otherContextId, () =>
        prisma.device.findUniqueOrThrow({ where: { id: otherContextDeviceId } }),
      );
      expect(untouched.status).toBe('activo');
    });
  });

  describe('PATCH /devices/:id/reissue', () => {
    it('gives a new working identifier and kills the old token and the old identifier', async () => {
      const { id, token, identifier, name } = await activated('A reemitir');
      await probe(id, token).expect(400);

      const res = await asSocio(http().patch(`/devices/${id}/reissue`)).expect(200);

      expect(res.body).toMatchObject({ id, status: 'pendiente_activacion' });
      expectUuidV7(res.body.identifier);
      expect(res.body.identifier).not.toBe(identifier);
      const stored = await row(id);
      expect(stored).toMatchObject({
        status: 'pendiente_activacion',
        authorized: false,
        tokenHash: null,
        activatedAt: null,
        revokedAt: null,
        identifier: res.body.identifier,
      });
      // Old token and old identifier are dead immediately.
      await probe(id, token).expect(403);
      await probe(id).expect(403);
      await identify(identifier, name).expect(403);

      // The new identifier works once and yields a different token.
      const again = await identify(res.body.identifier, name).expect(200);
      expect(again.body.deviceToken).not.toBe(token);
      await probe(id, token).expect(403);
      await probe(id, again.body.deviceToken).expect(400);
    });

    it('moves a LEGACY device to the token model', async () => {
      const legacy = await fixtureDevice({ name: 'Legacy a migrar' });
      await probe(legacy.id).expect(400);

      const res = await asSocio(http().patch(`/devices/${legacy.id}/reissue`)).expect(200);

      await probe(legacy.id).expect(403); // pending: cannot operate any more
      const activation = await identify(res.body.identifier, legacy.name).expect(200);
      await probe(legacy.id).expect(403); // x-device-id alone is over
      await probe(legacy.id, activation.body.deviceToken).expect(400);
      const list = await asSocio(http().get('/devices')).expect(200);
      const listed = list.body.find((d: { id: string }) => d.id === legacy.id);
      expect(listed).toMatchObject({ status: 'activo', legacy: false });
    });

    it('brings a revoked device back as pending', async () => {
      const { id } = await activated('Revocado y reemitido');
      await asSocio(http().patch(`/devices/${id}/revoke`)).expect(200);

      const res = await asSocio(http().patch(`/devices/${id}/reissue`)).expect(200);

      expect(res.body.status).toBe('pendiente_activacion');
      expect((await row(id)).revokedAt).toBeNull();
    });

    it('emails the new code without returning it when correoEnvio is given', async () => {
      const { id } = await activated('Reemision por correo');

      const res = await asSocio(http().patch(`/devices/${id}/reissue`))
        .send({ correoEnvio: 'nuevo@example.test' })
        .expect(200);

      expect(res.body).not.toHaveProperty('identifier');
      expect(res.body.deliveredTo).toBe('recipient');
      expect(sendActivation).toHaveBeenCalledTimes(1);
      const stored = await row(id);
      expect(sendActivation.mock.calls[0][0]).toMatchObject({
        to: 'nuevo@example.test',
        identifier: stored.identifier,
      });
    });

    it('leaves the device exactly as it was when the email cannot be sent', async () => {
      const { id, token } = await activated('Reemision fallida');
      const before = await row(id);
      sendActivation.mockRejectedValue(new Error('Resend is down'));

      await asSocio(http().patch(`/devices/${id}/reissue`))
        .send({ correoEnvio: 'nuevo@example.test' })
        .expect(502);

      expect(await row(id)).toEqual(before);
      await probe(id, token).expect(400); // the old token still works
    });

    it('rejects a malformed correoEnvio and unknown fields with 400', async () => {
      const { id } = await activated('Reemision invalida');
      await asSocio(http().patch(`/devices/${id}/reissue`))
        .send({ correoEnvio: 'nope' })
        .expect(400);
      await asSocio(http().patch(`/devices/${id}/reissue`))
        .send({ identifier: 'chosen' })
        .expect(400);
    });

    it('answers 404 for a device of another business and 400 for a malformed id', async () => {
      await asSocio(http().patch(`/devices/${otherContextDeviceId}/reissue`)).expect(404);
      await asSocio(http().patch('/devices/not-a-uuid/reissue')).expect(400);
    });
  });

  describe('GET /devices', () => {
    it('lists the business devices with status and the legacy flag, and no secrets', async () => {
      const pending = await create('Listado pendiente');
      const active = await activated('Listado activo');
      await asSocio(http().patch(`/devices/${active.id}/revoke`)).expect(200);
      const legacy = await fixtureDevice({ name: 'Listado legacy' });

      const res = await asSocio(http().get('/devices')).expect(200);

      const byId = new Map<string, Record<string, unknown>>(
        res.body.map((d: { id: string }) => [d.id, d]),
      );
      expect(byId.get(pending.id)).toMatchObject({
        name: 'Listado pendiente',
        status: 'pendiente_activacion',
        legacy: false,
        identifier: pending.identifier,
      });
      expect(byId.get(active.id)).toMatchObject({ status: 'revocado', legacy: false });
      expect(byId.get(active.id)).not.toHaveProperty('identifier');
      expect(byId.get(legacy.id)).toMatchObject({ status: 'activo', legacy: true });
      expect(byId.get(legacy.id)).not.toHaveProperty('identifier');
      for (const device of res.body) {
        expect(device).toEqual(
          expect.objectContaining({
            id: expect.any(String),
            name: expect.any(String),
            status: expect.any(String),
            legacy: expect.any(Boolean),
            createdAt: expect.any(String),
          }),
        );
        expect(device).not.toHaveProperty('tokenHash');
        expect(device).not.toHaveProperty('deviceToken');
        expect(device).not.toHaveProperty('authorized');
      }
      // A consumed identifier is never listed again.
      expect(JSON.stringify(res.body)).not.toContain(active.identifier);
      expect(JSON.stringify(res.body)).not.toContain(active.token);
    });

    it('is ordered by creation time and isolated per business', async () => {
      const res = await asSocio(http().get('/devices')).expect(200);
      const times = res.body.map((d: { createdAt: string }) => Date.parse(d.createdAt));
      expect([...times].sort((a, b) => a - b)).toEqual(times);
      expect(
        res.body.map((d: { id: string }) => d.id),
      ).not.toContain(otherContextDeviceId);

      const other = await http()
        .get('/devices')
        .auth(otherToken, { type: 'bearer' })
        .set('x-member-id', otherSocioId)
        .set('x-device-id', otherActingDeviceId)
        .expect(200);
      const otherIds = other.body.map((d: { id: string }) => d.id);
      expect(otherIds).toContain(otherContextDeviceId);
      expect(otherIds).not.toContain(actingDeviceId);
    });
  });

  describe('who may manage devices', () => {
    it.each([
      ['a colaborador on the shared login', asSharedColaborador],
      ['a colaborador with their own bound login', asBoundColaborador],
    ])('%s gets 403 on every management endpoint', async (_label, as) => {
      const device = await create(`Vedado ${randomUUID()}`);
      await as(http().post('/devices')).send({ name: 'no' }).expect(403);
      await as(http().get('/devices')).expect(403);
      await as(http().patch(`/devices/${device.id}/revoke`)).expect(403);
      await as(http().patch(`/devices/${device.id}/reissue`)).expect(403);
      // Nothing changed.
      expect((await row(device.id)).status).toBe('pendiente_activacion');
    });

    it('answers 401 without a login', async () => {
      await http().post('/devices').send({ name: 'x' }).expect(401);
      await http().get('/devices').expect(401);
      await http().patch(`/devices/${randomUUID()}/revoke`).expect(401);
      await http().patch(`/devices/${randomUUID()}/reissue`).expect(401);
    });
  });

  describe('status and authorized never drift', () => {
    const pair = async (id: string) => {
      const { status, authorized } = await row(id);
      return [status, authorized];
    };

    it('every endpoint leaves one of the three allowed pairs', async () => {
      const device = await create('Invariante');
      expect(await pair(device.id)).toEqual(['pendiente_activacion', false]);

      await identify(device.identifier, 'Invariante').expect(200);
      expect(await pair(device.id)).toEqual(['activo', true]);

      await asSocio(http().patch(`/devices/${device.id}/revoke`)).expect(200);
      expect(await pair(device.id)).toEqual(['revocado', false]);

      await asSocio(http().patch(`/devices/${device.id}/reissue`)).expect(200);
      expect(await pair(device.id)).toEqual(['pendiente_activacion', false]);
    });

    it.each([
      ['active, unauthorized, legacy', { status: 'activo', authorized: false }],
      [
        'active, unauthorized, tokened',
        { status: 'activo', authorized: false, tokenHash: hashDeviceToken('t') },
      ],
      [
        'pending',
        { status: 'pendiente_activacion', authorized: false },
      ],
      [
        'revoked, tokened',
        {
          status: 'revocado',
          authorized: false,
          tokenHash: hashDeviceToken('t'),
        },
      ],
    ])('ContextGuard rejects a device with authorized=false whatever the rest says (%s)', async (_label, data) => {
      const device = await fixtureDevice(data);
      await probe(device.id).expect(403);
      await probe(device.id, 't').expect(403);
    });
  });
});

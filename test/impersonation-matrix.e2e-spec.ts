import { Test } from '@nestjs/testing';
import { ModulesContainer } from '@nestjs/core';
import { RequestMethod, type INestApplication } from '@nestjs/common';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { EmailService } from '../src/email/email.service.js';
import { withTestTenant } from './tenant-scope.js';

/**
 * Security regression matrix for the reported privilege escalation: a
 * colaborador's own login (created through the REAL `POST /members`, so
 * `Account.memberId` is set by the product code, not by a fixture) must never
 * be able to act as a socio by sending a socio's `x-member-id`.
 *
 * The route lists below are COMPLETE and SELF-CHECKING: the set of handlers
 * guarded by SocioGuard / ContextGuard, the set that only runs AuthGuard and
 * the set with no guard are all derived from Nest's own guard metadata and
 * compared with the lists in this file. A new route added without a matrix
 * entry (or one whose guard changed) FAILS this suite until somebody reviews
 * it here, so a future socio-only route cannot silently escape the matrix.
 */

/** Handlers protected by SocioGuard: only an active socio may call them. */
const SOCIO_ROUTES = [
  'PATCH /settings/commission-rate',
  'GET /commissions',
  'GET /reports/sales-by-period',
  'GET /reports/sales-by-member',
  'GET /incidencias',
  'GET /incidencias/:id',
  'PATCH /incidencias/:id/resolver',
  'POST /devices',
  'GET /devices',
  'PATCH /devices/:id/revoke',
  'PATCH /devices/:id/reissue',
  'POST /deudas',
  'GET /deudas',
  'GET /deudas/:id',
  'POST /members',
  'PATCH /members/:id/commission-rate',
  'PATCH /members/:id',
  'DELETE /members/:id',
  'PATCH /members/:id/reactivate',
  'GET /sales',
  'POST /products',
  'PATCH /products/:id',
  'POST /products/:id/image',
  'DELETE /products/:id',
  'PATCH /products/:id/reactivate',
];

/** Handlers protected by ContextGuard only: any active member of the context. */
const CONTEXT_ROUTES = ['POST /sales', 'POST /deudas/:id/abonos'];

/**
 * Handlers that only run AuthGuard. None reads `x-member-id` to authorize
 * anything except `GET /members` and `GET /products` (the soft socio check for
 * `includeInactive`, covered below). `GET /sales/:id` and the product reads
 * are documented as open to any account of the business.
 */
const AUTH_ONLY_ROUTES = [
  'GET /auth/me',
  'POST /auth/change-password',
  'POST /devices/identify',
  'GET /members',
  'GET /products',
  'GET /products/:id',
  'GET /products/:id/audit',
  'GET /sales/:id',
];

/** Handlers with no guard at all. */
const PUBLIC_ROUTES = [
  'GET /',
  'POST /auth/login',
  'POST /business-registration',
  'GET /business-registration/approve',
  'GET /business-registration/reject',
];

const GENERIC_403 = 'Selection is not authorized for this context';
const SOCIO_ONLY_403 = 'Only socios may access this resource';

interface DiscoveredRoute {
  key: string;
  guards: string[];
}

const joinPath = (...parts: unknown[]) =>
  '/' +
  parts
    .flatMap((part) => (Array.isArray(part) ? part : [part]))
    .filter((part): part is string => typeof part === 'string')
    .map((part) => part.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');

/** Every route handler of every controller with the guards Nest will run. */
function discoverRoutes(app: INestApplication): DiscoveredRoute[] {
  const routes: DiscoveredRoute[] = [];
  const wrappers = [...app.get(ModulesContainer, { strict: false }).values()]
    .flatMap((nestModule) => [...nestModule.controllers.values()]);
  for (const wrapper of wrappers) {
    const controller = wrapper.metatype as (new (...args: never[]) => unknown) | null;
    if (!controller) continue;
    const base: unknown = Reflect.getMetadata(PATH_METADATA, controller);
    const classGuards: { name: string }[] =
      Reflect.getMetadata(GUARDS_METADATA, controller) ?? [];
    for (const name of Object.getOwnPropertyNames(controller.prototype)) {
      if (name === 'constructor') continue;
      const handler = (controller.prototype as Record<string, unknown>)[name];
      if (typeof handler !== 'function') continue;
      const method: number | undefined = Reflect.getMetadata(
        METHOD_METADATA,
        handler,
      );
      if (method === undefined) continue;
      const path: unknown = Reflect.getMetadata(PATH_METADATA, handler);
      const handlerGuards: { name: string }[] =
        Reflect.getMetadata(GUARDS_METADATA, handler) ?? [];
      routes.push({
        key: `${RequestMethod[method]} ${joinPath(base, path)}`,
        guards: [...classGuards, ...handlerGuards].map((guard) => guard.name),
      });
    }
  }
  return routes;
}

const keysWhere = (
  routes: DiscoveredRoute[],
  predicate: (guards: string[]) => boolean,
) => routes.filter((route) => predicate(route.guards)).map((r) => r.key).sort();

describe('impersonation matrix: a bound login can only act as its own member', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let routes: DiscoveredRoute[];
  const sendMemberCredentials = vi.fn();

  const contextId = `matrix-${randomUUID()}`;

  let socioId: string; // fixture socio (acts through the shared login)
  let inactiveMemberId: string;
  let deviceId: string;
  let activeProductId: string;
  let inactiveProductId: string;

  let sharedToken: string; // the unbound shared business login
  let colaboradorId: string; // created THROUGH POST /members
  let colaboradorToken: string;
  let boundSocioId: string; // a second socio created THROUGH POST /members
  let boundSocioToken: string;

  const http = () => request(app.getHttpServer());
  const login = (username: string, password: string) =>
    http().post('/auth/login').send({ username, password });

  const lastEmail = () =>
    sendMemberCredentials.mock.calls.at(-1)?.[0] as {
      username: string;
      temporaryPassword: string;
    };

  /** Replaces every `:param` with a random UUID: guards run before pipes. */
  const concrete = (path: string) =>
    path.replace(/:[A-Za-z]+/g, () => randomUUID());

  const call = (
    route: string,
    token: string,
    memberId: string | null,
    query = '',
  ) => {
    const [method, path] = route.split(' ') as [string, string];
    const url = concrete(path) + query;
    const builder = (() => {
      switch (method) {
        case 'GET':
          return http().get(url);
        case 'POST':
          return http().post(url).send({});
        case 'PATCH':
          return http().patch(url).send({});
        case 'DELETE':
          return http().delete(url);
        default:
          throw new Error(`Unsupported method in matrix: ${method}`);
      }
    })();
    builder.auth(token, { type: 'bearer' }).set('x-device-id', deviceId);
    if (memberId) builder.set('x-member-id', memberId);
    return builder;
  };

  /** Creates a person through the real endpoint and logs into the new account. */
  const createThroughApi = async (role: 'colaborador' | 'socio') => {
    const res = await http()
      .post('/members')
      .auth(sharedToken, { type: 'bearer' })
      .set('x-member-id', socioId)
      .set('x-device-id', deviceId)
      .send({
        nombre: `Matrix ${role}`,
        apellidos: 'Persona',
        correo: `${randomUUID()}@example.test`,
        role,
      })
      .expect(201);
    const { username, temporaryPassword } = lastEmail();
    const session = await login(username, temporaryPassword).expect(200);
    return { id: res.body.id as string, token: session.body.accessToken as string };
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EmailService)
      .useValue({ sendMemberCredentialsEmail: sendMemberCredentials })
      .compile();
    app = module.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    const jwt = app.get(JwtService);
    routes = discoverRoutes(app);

    sendMemberCredentials.mockResolvedValue({ deliveredTo: 'member' });

    await withTestTenant(contextId, async () => {
      socioId = (
        await prisma.member.create({
          data: { name: 'Matrix Socio', role: 'socio', contextId },
        })
      ).id;
      inactiveMemberId = (
        await prisma.member.create({
          data: {
            name: 'Matrix Inactive Person',
            role: 'colaborador',
            contextId,
            active: false,
          },
        })
      ).id;
      deviceId = (
        await prisma.device.create({
          data: {
            name: 'matrix legacy device',
            identifier: randomUUID(),
            contextId,
            authorized: true,
          },
        })
      ).id;
      activeProductId = (
        await prisma.product.create({
          data: {
            name: 'Matrix Active Product',
            tipo: 'cantidad',
            unitPriceMinor: 1000,
            initialStock: 5,
            stock: 5,
            contextId,
          },
        })
      ).id;
      inactiveProductId = (
        await prisma.product.create({
          data: {
            name: 'Matrix Inactive Product',
            tipo: 'cantidad',
            unitPriceMinor: 1000,
            initialStock: 5,
            stock: 5,
            contextId,
            active: false,
          },
        })
      ).id;
    });

    const shared = await prisma.account.create({
      data: {
        username: randomUUID(),
        passwordHash: 'not-a-login-fixture',
        contextId,
      },
    });
    sharedToken = await jwt.signAsync({ sub: shared.id });

    ({ id: colaboradorId, token: colaboradorToken } =
      await createThroughApi('colaborador'));
    ({ id: boundSocioId, token: boundSocioToken } =
      await createThroughApi('socio'));
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

  describe('the route lists are complete (derived from Nest guard metadata)', () => {
    it('SocioGuard handlers are exactly the ones this matrix covers', () => {
      expect(keysWhere(routes, (g) => g.includes('SocioGuard'))).toEqual(
        [...SOCIO_ROUTES].sort(),
      );
    });

    it('ContextGuard-only handlers are exactly the ones this matrix covers', () => {
      expect(
        keysWhere(
          routes,
          (g) => g.includes('ContextGuard') && !g.includes('SocioGuard'),
        ),
      ).toEqual([...CONTEXT_ROUTES].sort());
    });

    it('AuthGuard-only handlers are exactly the reviewed ones', () => {
      expect(
        keysWhere(
          routes,
          (g) =>
            g.includes('AuthGuard') &&
            !g.includes('SocioGuard') &&
            !g.includes('ContextGuard'),
        ),
      ).toEqual([...AUTH_ONLY_ROUTES].sort());
    });

    it('unguarded handlers are exactly the reviewed public ones', () => {
      expect(keysWhere(routes, (g) => g.length === 0)).toEqual(
        [...PUBLIC_ROUTES].sort(),
      );
    });

    it('every discovered handler falls in one of the four lists', () => {
      const covered = new Set([
        ...SOCIO_ROUTES,
        ...CONTEXT_ROUTES,
        ...AUTH_ONLY_ROUTES,
        ...PUBLIC_ROUTES,
      ]);
      const missing = routes.map((r) => r.key).filter((k) => !covered.has(k));
      expect(missing).toEqual([]);
    });
  });

  describe('the colaborador exists because POST /members created it', () => {
    it('its account is bound to its own member (Account.memberId is set by the product code)', async () => {
      const account = await prisma.account.findFirst({
        where: { memberId: colaboradorId },
      });
      expect(account).not.toBeNull();
      expect(account?.contextId).toBe(contextId);
    });

    it('GET /auth/me tells the frontend the binding, so the selector is skipped', async () => {
      const res = await http()
        .get('/auth/me')
        .auth(colaboradorToken, { type: 'bearer' })
        .expect(200);
      expect(res.body.memberId).toBe(colaboradorId);
      expect(res.body.member).toMatchObject({
        id: colaboradorId,
        role: 'colaborador',
        active: true,
      });
    });
  });

  describe.each(SOCIO_ROUTES)('%s (SocioGuard)', (route) => {
    it('a bound colaborador naming a socio is refused with the generic 403', async () => {
      for (const target of [socioId, boundSocioId]) {
        const res = await call(route, colaboradorToken, target);
        expect(res.status).toBe(403);
        expect(res.body.message).toBe(GENERIC_403);
      }
    });

    it('a bound colaborador using its own member is refused: only socios', async () => {
      const res = await call(route, colaboradorToken, colaboradorId);
      expect(res.status).toBe(403);
      expect(res.body.message).toBe(SOCIO_ONLY_403);
    });

    it('a bound colaborador naming an inactive or unknown member is refused too', async () => {
      for (const target of [inactiveMemberId, randomUUID()]) {
        const res = await call(route, colaboradorToken, target);
        expect(res.status).toBe(403);
      }
    });

    it('with no x-member-id at all it is refused', async () => {
      const res = await call(route, colaboradorToken, null);
      expect(res.status).toBe(403);
    });

    it('CONTROL bound socio: its own member passes the guard, another socio is refused', async () => {
      const own = await call(route, boundSocioToken, boundSocioId);
      expect([401, 403]).not.toContain(own.status);
      const other = await call(route, boundSocioToken, socioId);
      expect(other.status).toBe(403);
      expect(other.body.message).toBe(GENERIC_403);
    });

    it('CONTROL shared (unbound) login: still picks a socio, and a colaborador is still refused', async () => {
      const asSocio = await call(route, sharedToken, socioId);
      expect([401, 403]).not.toContain(asSocio.status);
      const asColaborador = await call(route, sharedToken, colaboradorId);
      expect(asColaborador.status).toBe(403);
      expect(asColaborador.body.message).toBe(SOCIO_ONLY_403);
    });
  });

  describe.each(CONTEXT_ROUTES)('%s (ContextGuard)', (route) => {
    it('a bound colaborador naming a socio is refused with the generic 403', async () => {
      const res = await call(route, colaboradorToken, socioId);
      expect(res.status).toBe(403);
      expect(res.body.message).toBe(GENERIC_403);
    });

    it('a bound colaborador acting as itself passes the guard (any active member may)', async () => {
      const res = await call(route, colaboradorToken, colaboradorId);
      // The empty probe body fails validation or finds nothing: what matters
      // is that ContextGuard did NOT refuse it.
      expect([401, 403]).not.toContain(res.status);
    });
  });

  describe('soft checks that read x-member-id without ContextGuard', () => {
    it('GET /members?includeInactive=true never lists inactive people to a bound colaborador', async () => {
      for (const target of [socioId, boundSocioId, colaboradorId]) {
        const res = await call(
          'GET /members',
          colaboradorToken,
          target,
          '?includeInactive=true',
        ).expect(200);
        expect(JSON.stringify(res.body)).not.toContain(inactiveMemberId);
      }
    });

    it('GET /members?includeInactive=true lists them to the shared login choosing a socio (control)', async () => {
      const res = await call(
        'GET /members',
        sharedToken,
        socioId,
        '?includeInactive=true',
      ).expect(200);
      expect(JSON.stringify(res.body)).toContain(inactiveMemberId);
    });

    it('GET /products?includeInactive=true never lists inactive products to a bound colaborador', async () => {
      for (const target of [socioId, boundSocioId, colaboradorId]) {
        const res = await call(
          'GET /products',
          colaboradorToken,
          target,
          '?includeInactive=true',
        ).expect(200);
        expect(JSON.stringify(res.body)).toContain(activeProductId);
        expect(JSON.stringify(res.body)).not.toContain(inactiveProductId);
      }
    });

    it('GET /products?includeInactive=true lists them to the shared login choosing a socio (control)', async () => {
      const res = await call(
        'GET /products',
        sharedToken,
        socioId,
        '?includeInactive=true',
      ).expect(200);
      expect(JSON.stringify(res.body)).toContain(inactiveProductId);
    });

    it.each(['GET /products/:id', 'GET /products/:id/audit', 'GET /sales/:id'])(
      '%s ignores x-member-id entirely: naming a socio changes nothing for a bound colaborador',
      async (route) => {
        // These handlers only ask for a valid login (documented as open to any
        // account of the business); the point is that the member header can
        // NEVER upgrade what a bound colaborador gets.
        const id = route.includes('/products/')
          ? activeProductId
          : randomUUID();
        const path = route.replace(':id', id);
        const answers = [];
        for (const target of [null, colaboradorId, socioId, boundSocioId]) {
          const res = await call(`GET ${path.split(' ')[1]}`, colaboradorToken, target);
          answers.push({ status: res.status, body: JSON.stringify(res.body) });
        }
        expect(new Set(answers.map((a) => a.status)).size).toBe(1);
        expect(new Set(answers.map((a) => a.body)).size).toBe(1);
      },
    );
  });
});

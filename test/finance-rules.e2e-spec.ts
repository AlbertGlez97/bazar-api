import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { Logger, type INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { v7 } from 'uuid';
import { vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { EmailService } from '../src/email/email.service.js';
import { hashSingleUseToken } from '../src/common/single-use-token.js';
import { RULES_SCHEMA_VERSION } from '../src/finance/finance-rules.config.js';
import { withTestTenant } from './tenant-scope.js';
import { purgeRuleData } from './rules-cleanup.js';

const config = (reserve = 10) => ({
  schemaVersion: RULES_SCHEMA_VERSION,
  profitBase: { partnerPct: 50, capitalPct: 30, workPct: 20 },
  reinvestment: {
    currentPhase: 'operacion',
    arranquePct: 100,
    operacionPct: 50,
    cierrePct: 0,
    untilAmountMinor: null,
  },
  capitalRecovery: { mode: 'por_diferencia', timing: 'durante' },
  work: { payHours: false, order: 'antes', pay: { kind: 'por_hora', rateMinorPerHour: 5000 } },
  partnerExpenses: 'reembolsar',
  reserves: { kind: 'porcentaje', pct: reserve },
  partnerLoans: { repayBeforeCapital: true },
});

/** The database guards raise `restrict_violation`, which Prisma reports as a constraint error. */
const TRIGGER_REFUSAL = /Foreign key constraint violated/;
const INVALID_LINK = 'Este enlace no sirve. Pide a un socio que te lo envíe de nuevo.';
const IN_REVIEW = 'Esta propuesta está en revisión; recibirás la versión nueva por correo.';
const DAY = 24 * 3600_000;

interface Who {
  memberId: string;
  token: string;
  name: string;
  correo: string | null;
}
interface Scenario {
  contextId: string;
  deviceId: string;
  socios: Who[];
  colaborador: Who;
}

describe('finance rules: approval by email', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const sendApproval = vi.fn().mockResolvedValue(undefined);
  const contexts: string[] = [];

  /** A business with `count` socios, each with an account to sign in with and an address (unless listed). */
  const scenario = async (label: string, count: number, withoutCorreo: number[] = []): Promise<Scenario> => {
    const contextId = `rules-${label}-${randomUUID()}`;
    contexts.push(contextId);
    const jwt = app.get(JwtService);
    return withTestTenant(contextId, async () => {
      const deviceId = (await prisma.device.create({ data: { contextId, name: 'Tablet', authorized: true } })).id;
      const make = async (name: string, role: 'socio' | 'colaborador', correo: string | null): Promise<Who> => {
        const member = await prisma.member.create({ data: { contextId, name, role, correo } });
        const account = await prisma.account.create({
          data: { username: `login-${randomUUID()}@example.test`, passwordHash: 'x', contextId, memberId: member.id },
        });
        return { memberId: member.id, token: await jwt.signAsync({ sub: account.id }), name, correo };
      };
      const socios: Who[] = [];
      const names = ['Ana', 'Beto', 'Carla', 'Diego'];
      for (let i = 0; i < count; i++)
        socios.push(await make(names[i]!, 'socio', withoutCorreo.includes(i) ? null : `${names[i]!.toLowerCase()}-${randomUUID()}@example.test`));
      return { contextId, deviceId, socios, colaborador: await make('Colaborador', 'colaborador', null) };
    });
  };

  const as = (s: Scenario, who: Who, req: request.Test) =>
    req.auth(who.token, { type: 'bearer' }).set('x-member-id', who.memberId).set('x-device-id', s.deviceId);
  const call = (s: Scenario, who: Who, method: 'get' | 'put' | 'post', path: string, body?: object) => {
    const req = as(s, who, request(app.getHttpServer())[method](`/api/v1/finance/rules${path}`));
    return body === undefined ? req : req.send(body);
  };
  const overview = async (s: Scenario, who: Who) => (await call(s, who, 'get', '').expect(200)).body;
  const inspect = (token: string) => request(app.getHttpServer()).post('/api/v1/agreements/inspect').send({ token });
  const respond = (token: string, decision: 'approve' | 'object', reason?: string) =>
    request(app.getHttpServer()).post('/api/v1/agreements/respond').send({ token, decision, ...(reason === undefined ? {} : { reason }) });

  /** Who received a link in the most recent `count` emails, and the token each one carried. */
  const lastLinks = (count: number) =>
    Object.fromEntries(
      sendApproval.mock.calls.slice(-count).map(([mail]: [{ to: string; reviewUrl: string }]) => [mail.to, mail.reviewUrl.split('/acuerdo/')[1]!]),
    ) as Record<string, string>;
  const tokenOf = (who: Who, links: Record<string, string>) => links[who.correo!]!;

  /** Draft → submit, as `who`; returns the pending rule set and the links the emails carried. */
  const propose = async (s: Scenario, who: Who, reserve = 10) => {
    const draft = (await call(s, who, 'put', '/draft', { config: config(reserve) }).expect(200)).body;
    const sent = (await call(s, who, 'post', `/${draft.id}/submit`).expect(200)).body;
    return { set: sent, links: lastLinks(s.socios.filter((p) => p.correo).length) };
  };
  /** Everyone approves with their own link; returns the outcome of each. */
  const approveAll = async (s: Scenario, links: Record<string, string>) =>
    Promise.all(s.socios.map(async (p) => (await respond(tokenOf(p, links), 'approve').expect(200)).body.outcome as string));
  const row = (s: Scenario, id: string) =>
    withTestTenant(s.contextId, () => prisma.financeRuleSet.findFirstOrThrow({ where: { id } }));

  beforeAll(async () => {
    process.env.PUBLIC_SITE_URL = 'https://site.test';
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EmailService)
      .useValue({ sendFinanceRulesApprovalEmail: sendApproval })
      .compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
    prisma = app.get(PrismaService);
  });
  afterAll(async () => {
    if (prisma) {
      await purgeRuleData(contexts);
      for (const contextId of contexts) {
        await prisma.account.deleteMany({ where: { contextId } });
        await withTestTenant(contextId, async () => {
          await prisma.device.deleteMany({ where: { contextId } });
          await prisma.member.deleteMany({ where: { contextId } });
        });
      }
    }
    await app?.close();
  });
  beforeEach(() => {
    sendApproval.mockReset();
    sendApproval.mockResolvedValue(undefined);
  });

  describe('a business that never configured rules', () => {
    it('starts without rules and the finance overview is unchanged', async () => {
      const s = await scenario('none', 2);
      const body = await overview(s, s.socios[0]!);
      expect(body).toMatchObject({ state: 'sin_aprobar', inForce: null, proposal: null, draft: null, history: [] });
      expect(body.disclaimer).toContain('No es asesoría contable ni legal');
      expect(body.me).toMatchObject({ hasCorreo: true, pendingCorreo: null });
      const finance = await as(s, s.socios[0]!, request(app.getHttpServer()).get('/api/v1/finance/overview').query({ from: '2026-10-01', to: '2026-11-01' }));
      expect(finance.status).toBe(200);
      expect(JSON.stringify(finance.body)).not.toContain('ruleSet');
    });

    it('a colaborador is refused on every route, even naming a socio', async () => {
      const s = await scenario('colab', 2);
      const draft = (await call(s, s.socios[0]!, 'put', '/draft', { config: config() }).expect(200)).body;
      const colab = s.colaborador;
      await call(s, colab, 'get', '').expect(403);
      await call(s, colab, 'put', '/draft', { config: config() }).expect(403);
      for (const action of ['discard', 'submit', 'modify', 'resend'])
        await call(s, colab, 'post', `/${draft.id}/${action}`).expect(403);
      await as(s, colab, request(app.getHttpServer()).get('/api/v1/members/me/email')).expect(403);
      await as(s, colab, request(app.getHttpServer()).put('/api/v1/members/me/email').send({ correo: 'x@example.test' })).expect(403);
      // The routes of the old mechanism are gone.
      for (const action of ['approve', 'withdraw', 'remind'])
        await call(s, s.socios[0]!, 'post', `/${draft.id}/${action}`).expect(404);
    });
  });

  describe('draft', () => {
    it('rejects invalid rules listing every problem, and creates nothing', async () => {
      const s = await scenario('invalid', 1);
      const bad = config();
      bad.profitBase = { partnerPct: 50, capitalPct: 30, workPct: 10 };
      (bad as Record<string, unknown>).partnerExpenses = 'nunca';
      const res = await call(s, s.socios[0]!, 'put', '/draft', { config: bad }).expect(400);
      expect(res.body.code).toBe('FINANCE_RULES_INVALID');
      expect(res.body.message).toContain('deben sumar 100');
      expect((await overview(s, s.socios[0]!)).draft).toBeNull();
    });

    it('creates version 1, then keeps editing the same draft; unusual values only warn', async () => {
      const s = await scenario('draft', 2);
      const first = (await call(s, s.socios[0]!, 'put', '/draft', { config: config(10) }).expect(200)).body;
      expect(first).toMatchObject({ version: 1, status: 'borrador', basedOn: null });
      const second = (await call(s, s.socios[0]!, 'put', '/draft', { config: config(80) }).expect(200)).body;
      expect(second.id).toBe(first.id);
      expect(second.warnings.map((w: { code: string }) => w.code)).toContain('RESERVES_HIGH');
    });

    it('another socio cannot take over an open draft, but can discard it', async () => {
      const s = await scenario('owned', 2);
      const draft = (await call(s, s.socios[0]!, 'put', '/draft', { config: config() }).expect(200)).body;
      const res = await call(s, s.socios[1]!, 'put', '/draft', { config: config() }).expect(409);
      expect(res.body.code).toBe('FINANCE_RULES_DRAFT_OWNED');
      const discarded = (await call(s, s.socios[1]!, 'post', `/${draft.id}/discard`).expect(200)).body;
      expect(discarded).toMatchObject({ status: 'descartada', closedNote: 'Descartada por Beto.' });
      expect((await call(s, s.socios[1]!, 'put', '/draft', { config: config() }).expect(200)).body.version).toBe(2);
    });

    it('rejects extra properties in the body', async () => {
      const s = await scenario('extra', 1);
      await call(s, s.socios[0]!, 'put', '/draft', { config: config(), contextId: 'other' }).expect(400);
    });
  });

  describe('sending', () => {
    it('is refused while a socio has no address, naming who, and nothing is created or emailed', async () => {
      const s = await scenario('missing', 3, [1, 2]);
      const draft = (await call(s, s.socios[0]!, 'put', '/draft', { config: config() }).expect(200)).body;
      const res = await call(s, s.socios[0]!, 'post', `/${draft.id}/submit`).expect(422);
      expect(res.body).toMatchObject({ code: 'FINANCE_RULES_MISSING_EMAIL', message: 'No se puede enviar. Falta el correo de Beto y Carla.' });
      expect(res.body.missing.map((m: { name: string }) => m.name)).toEqual(['Beto', 'Carla']);
      expect(sendApproval).not.toHaveBeenCalled();
      expect((await overview(s, s.socios[0]!)).draft.status).toBe('borrador');
      expect(await withTestTenant(s.contextId, () => prisma.financeRuleLink.count({ where: { contextId: s.contextId } }))).toBe(0);
    });

    it('emails EVERY socio, the proposer included, each at their own address with their own link', async () => {
      const s = await scenario('send', 3);
      const { set, links } = await propose(s, s.socios[0]!);
      expect(set).toMatchObject({ status: 'pendiente', emails: { sent: ['Ana', 'Beto', 'Carla'], failed: [] } });
      expect(sendApproval).toHaveBeenCalledTimes(3);
      expect(Object.keys(links).sort()).toEqual(s.socios.map((p) => p.correo!).sort());
      expect(new Set(Object.values(links)).size).toBe(3);
      const first = sendApproval.mock.calls[0]![0];
      expect(first).toMatchObject({ proposerName: 'Ana', businessName: 'tu negocio', version: 1, expiresInDays: 7, changes: null });
      expect(first.summary).toHaveLength(7);
      expect(first.reviewUrl).toMatch(/^https:\/\/site\.test\/acuerdo\/[A-Za-z0-9_-]{43}$/);
    });

    it('stores only the hash of each token, never the token', async () => {
      const s = await scenario('hash', 2);
      const { links } = await propose(s, s.socios[0]!);
      const stored = await withTestTenant(s.contextId, () => prisma.financeRuleLink.findMany({ where: { contextId: s.contextId } }));
      expect(stored.map((l) => l.tokenHash).sort()).toEqual(Object.values(links).map(hashSingleUseToken).sort());
      expect(JSON.stringify(stored)).not.toContain(Object.values(links)[0]);
      expect(stored.every((l) => l.emailSent && l.kind === 'envio' && l.expiresAt.getTime() - l.createdAt.getTime() === 7 * DAY)).toBe(true);
    });

    it('only the proposer sends, and a second open proposal is refused', async () => {
      const s = await scenario('submit', 2);
      const draft = (await call(s, s.socios[0]!, 'put', '/draft', { config: config() }).expect(200)).body;
      const res = await call(s, s.socios[1]!, 'post', `/${draft.id}/submit`).expect(403);
      expect(res.body.code).toBe('FINANCE_RULES_NOT_PROPOSER');
      await call(s, s.socios[0]!, 'post', `/${draft.id}/submit`).expect(200);
      const other = (await call(s, s.socios[0]!, 'put', '/draft', { config: config(20) }).expect(200)).body;
      const clash = await call(s, s.socios[0]!, 'post', `/${other.id}/submit`).expect(409);
      expect(clash.body.code).toBe('FINANCE_RULES_PENDING_EXISTS');
    });

    it('a failed email retires that link only, reports who, and the others still go out', async () => {
      const s = await scenario('fail', 3);
      sendApproval.mockImplementation(async (mail: { to: string }) => {
        if (mail.to === s.socios[1]!.correo) throw new Error('boom');
      });
      const draft = (await call(s, s.socios[0]!, 'put', '/draft', { config: config() }).expect(200)).body;
      const sent = (await call(s, s.socios[0]!, 'post', `/${draft.id}/submit`).expect(200)).body;
      expect(sent.emails).toEqual({ sent: ['Ana', 'Carla'], failed: ['Beto'] });
      const links = lastLinks(3);
      expect((await inspect(links[s.socios[1]!.correo!]!)).status).toBe(404);
      expect((await inspect(links[s.socios[0]!.correo!]!)).status).toBe(200);
      // The failed one can be re-sent at once: only links that really went out count for the 24 hours.
      sendApproval.mockResolvedValue(undefined);
      const again = (await call(s, s.socios[0]!, 'post', `/${sent.id}/resend`).expect(200)).body;
      expect(again.resent).toContainEqual({ memberId: s.socios[1]!.memberId, name: 'Beto', emailSent: true });
      expect(again.skipped).toEqual([]);
    });

    it('a submitted rule set cannot be edited, even straight at the database', async () => {
      const s = await scenario('frozen', 1);
      const { set } = await propose(s, s.socios[0]!);
      await expect(
        withTestTenant(s.contextId, () =>
          prisma.financeRuleSet.update({ where: { id: set.id }, data: { config: config(99), configHash: 'a'.repeat(64) } }),
        ),
      ).rejects.toThrow(TRIGGER_REFUSAL);
      await expect(
        withTestTenant(s.contextId, () => prisma.financeRuleSet.deleteMany({ where: { id: set.id } })),
      ).rejects.toThrow(TRIGGER_REFUSAL);
      expect((await overview(s, s.socios[0]!)).proposal.config.reserves.pct).toBe(10);
    });

    it('status only moves along the allowed paths', async () => {
      const s = await scenario('paths', 1);
      const { set, links } = await propose(s, s.socios[0]!);
      const move = (id: string, status: string) =>
        withTestTenant(s.contextId, () => prisma.financeRuleSet.update({ where: { id }, data: { status } }));
      // The old "withdraw" path (waiting -> draft) no longer exists.
      await expect(move(set.id, 'borrador')).rejects.toThrow(TRIGGER_REFUSAL);
      await respond(tokenOf(s.socios[0]!, links), 'approve').expect(200);
      await expect(move(set.id, 'en_revision')).rejects.toThrow(TRIGGER_REFUSAL);
      await expect(move(set.id, 'descartada')).rejects.toThrow(TRIGGER_REFUSAL);
      expect((await overview(s, s.socios[0]!)).inForce.id).toBe(set.id);
    });
  });

  describe('the public page', () => {
    it('GET does not exist: opening the link in a browser or a scanner cannot consume anything', async () => {
      const s = await scenario('get', 1);
      const { links } = await propose(s, s.socios[0]!);
      const token = tokenOf(s.socios[0]!, links);
      await request(app.getHttpServer()).get('/api/v1/agreements/inspect').expect(404);
      await request(app.getHttpServer()).get(`/api/v1/agreements/inspect/${token}`).expect(404);
      await request(app.getHttpServer()).get(`/api/v1/agreements/respond?token=${token}`).expect(404);
    });

    it('inspect shows the proposal in plain words, never consumes the link, and is never cached', async () => {
      const s = await scenario('inspect', 2);
      const { links } = await propose(s, s.socios[0]!);
      const token = tokenOf(s.socios[1]!, links);
      const first = await inspect(token).expect(200);
      expect(first.headers['cache-control']).toBe('no-store');
      expect(first.headers['referrer-policy']).toBe('no-referrer');
      expect(first.body).toMatchObject({
        state: 'pendiente',
        message: null,
        memberName: 'Beto',
        proposerName: 'Ana',
        version: 1,
        changes: null,
        approvedBy: [],
        waitingFor: ['Ana', 'Beto'],
      });
      expect(first.body.rules).toContain('La utilidad va 50 % por ser socio, 30 % por capital y 20 % por trabajo.');
      const second = await inspect(token).expect(200);
      expect(second.body).toEqual(first.body);
      expect((await respond(token, 'approve').expect(200)).body.outcome).toBe('aprobada');
    });

    it('rejects shapes it does not understand', async () => {
      const post = (path: string, body: object) => request(app.getHttpServer()).post(`/api/v1/agreements/${path}`).send(body);
      expect((await post('inspect', {})).status).toBe(400);
      expect((await post('inspect', { token: 'corto' })).status).toBe(400);
      expect((await post('inspect', { token: 'A'.repeat(43), extra: 1 })).status).toBe(400);
      expect((await post('respond', { token: 'A'.repeat(43) })).status).toBe(400);
      expect((await post('respond', { token: 'A'.repeat(43), decision: 'maybe' })).status).toBe(400);
    });

    it('limits the attempts per link', async () => {
      const token = 'B'.repeat(43);
      const statuses: number[] = [];
      for (let i = 0; i < 14; i++) statuses.push((await inspect(token)).status);
      expect(statuses.slice(0, 10).every((code) => code === 404)).toBe(true);
      expect(statuses.at(-1)).toBe(429);
    });

    it('unknown, used, replaced, expired and discarded links all get the SAME answer', async () => {
      const s = await scenario('same', 2);
      const { set, links } = await propose(s, s.socios[0]!);
      const [ana, beto] = s.socios as [Who, Who];
      const answers: unknown[] = [];
      const record = async (token: string, via: 'inspect' | 'respond') =>
        answers.push((await (via === 'inspect' ? inspect(token) : respond(token, 'approve'))).body);

      // unknown
      await record('C'.repeat(43), 'inspect');
      // used
      await respond(tokenOf(ana, links), 'approve').expect(200);
      await record(tokenOf(ana, links), 'inspect');
      await record(tokenOf(ana, links), 'respond');
      // replaced by a re-send
      await call(s, ana, 'post', `/${set.id}/resend`).expect(200);
      await record(tokenOf(beto, links), 'inspect');
      // expired
      const fresh = lastLinks(1)[beto.correo!]!;
      await withTestTenant(s.contextId, () =>
        prisma.financeRuleLink.updateMany({
          where: { tokenHash: hashSingleUseToken(fresh) },
          data: { createdAt: new Date(Date.now() - 8 * DAY), expiresAt: new Date(Date.now() - DAY) },
        }),
      );
      await record(fresh, 'inspect');
      await record(fresh, 'respond');
      // discarded
      const t = await scenario('same-discarded', 1);
      const other = await propose(t, t.socios[0]!);
      await call(t, t.socios[0]!, 'post', `/${other.set.id}/discard`).expect(200);
      await record(tokenOf(t.socios[0]!, other.links), 'inspect');

      for (const body of answers) expect(body).toMatchObject({ code: 'AGREEMENT_LINK_INVALID', message: INVALID_LINK });
      expect(answers).toHaveLength(7);
    });
  });

  describe('approving', () => {
    it('a single socio approves by email too, and the rules are in force at once', async () => {
      const s = await scenario('solo', 1);
      const { set, links } = await propose(s, s.socios[0]!);
      expect(Object.keys(links)).toEqual([s.socios[0]!.correo]);
      const res = await respond(tokenOf(s.socios[0]!, links), 'approve').expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toEqual({ outcome: 'vigente' });
      const view = await overview(s, s.socios[0]!);
      expect(view).toMatchObject({ state: 'vigente', proposal: null });
      expect(view.inForce).toMatchObject({ id: set.id, status: 'vigente' });
      expect(view.inForce.approvals).toEqual([
        expect.objectContaining({ memberId: s.socios[0]!.memberId, via: 'correo', correo: expect.stringMatching(/^a\*\*\*@e\*\*\*\.test$/) }),
      ]);
    });

    it('records the complete address and the hash that was approved, and uses the link once', async () => {
      const s = await scenario('record', 2);
      const { set, links } = await propose(s, s.socios[0]!);
      await respond(tokenOf(s.socios[1]!, links), 'approve').expect(200);
      const [approval] = await withTestTenant(s.contextId, () => prisma.financeRuleApproval.findMany({ where: { contextId: s.contextId } }));
      expect(approval).toMatchObject({
        memberId: s.socios[1]!.memberId,
        correo: s.socios[1]!.correo,
        approvedHash: set.configHash,
        approvedByAccountId: null,
      });
      expect((await respond(tokenOf(s.socios[1]!, links), 'approve')).status).toBe(404);
      expect(await withTestTenant(s.contextId, () => prisma.financeRuleApproval.count({ where: { contextId: s.contextId } }))).toBe(1);
    });

    it('needs every active socio and activates only with the last one', async () => {
      const s = await scenario('all', 3);
      const { set, links } = await propose(s, s.socios[0]!);
      expect((await respond(tokenOf(s.socios[0]!, links), 'approve').expect(200)).body.outcome).toBe('aprobada');
      expect((await respond(tokenOf(s.socios[1]!, links), 'approve').expect(200)).body.outcome).toBe('aprobada');
      const view = await overview(s, s.socios[0]!);
      expect(view.state).toBe('pendiente');
      expect(view.proposal.missing.map((m: { name: string }) => m.name)).toEqual(['Carla']);
      expect(view.partners.map((p: { name: string; response: string | null }) => [p.name, p.response])).toEqual([
        ['Ana', 'aprobo'],
        ['Beto', 'aprobo'],
        ['Carla', null],
      ]);
      expect((await respond(tokenOf(s.socios[2]!, links), 'approve').expect(200)).body.outcome).toBe('vigente');
      expect((await row(s, set.id)).status).toBe('vigente');
    });

    it('the last approvals at the same moment activate the rules exactly once and replace the old ones once', async () => {
      const s = await scenario('race', 3);
      const first = await propose(s, s.socios[0]!);
      await approveAll(s, first.links);
      const second = await propose(s, s.socios[1]!, 20);
      const outcomes = await approveAll(s, second.links);

      expect(outcomes.filter((o) => o === 'vigente')).toHaveLength(1);
      expect(outcomes.filter((o) => o === 'aprobada')).toHaveLength(2);
      const statuses = await withTestTenant(s.contextId, () =>
        prisma.financeRuleSet.findMany({ where: { contextId: s.contextId }, orderBy: { version: 'asc' } }),
      );
      expect(statuses.map((r) => r.status)).toEqual(['reemplazada', 'vigente']);
      expect(await withTestTenant(s.contextId, () => prisma.financeRuleApproval.count({ where: { ruleSetId: second.set.id } }))).toBe(3);
    });

    it('answering the same link twice at the same moment records one answer', async () => {
      const s = await scenario('twice', 2);
      const { set, links } = await propose(s, s.socios[0]!);
      const token = tokenOf(s.socios[1]!, links);
      const statuses = (await Promise.all([respond(token, 'approve'), respond(token, 'approve'), respond(token, 'approve')])).map((r) => r.status);
      expect(statuses.filter((code) => code === 200)).toHaveLength(1);
      expect(statuses.filter((code) => code === 404)).toHaveLength(2);
      expect(await withTestTenant(s.contextId, () => prisma.financeRuleApproval.count({ where: { ruleSetId: set.id } }))).toBe(1);
    });

    it('an approval for a stale hash cannot be recorded', async () => {
      const s = await scenario('stale', 1);
      const { set } = await propose(s, s.socios[0]!);
      const record = (approvedHash: string) =>
        withTestTenant(s.contextId, () =>
          prisma.financeRuleApproval.create({
            data: { id: v7(), contextId: s.contextId, ruleSetId: set.id, memberId: s.socios[0]!.memberId, approvedHash },
          }),
        );
      await expect(record('b'.repeat(64))).rejects.toThrow(TRIGGER_REFUSAL);
      await expect(record(set.configHash)).resolves.toMatchObject({ approvedHash: set.configHash });
    });

    it('a socio who joins while a proposal is pending must answer too, and gets a link by re-sending', async () => {
      const s = await scenario('joins', 2);
      const { set, links } = await propose(s, s.socios[0]!);
      const newcomer = await withTestTenant(s.contextId, () =>
        prisma.member.create({ data: { contextId: s.contextId, name: 'Nueva', role: 'socio', correo: `nueva-${randomUUID()}@example.test` } }),
      );
      await respond(tokenOf(s.socios[0]!, links), 'approve').expect(200);
      expect((await respond(tokenOf(s.socios[1]!, links), 'approve').expect(200)).body.outcome).toBe('aprobada');
      expect((await row(s, set.id)).status).toBe('pendiente');
      const resent = (await call(s, s.socios[0]!, 'post', `/${set.id}/resend`).expect(200)).body;
      expect(resent.resent).toEqual([{ memberId: newcomer.id, name: 'Nueva', emailSent: true }]);
      expect((await respond(lastLinks(1)[newcomer.correo!]!, 'approve').expect(200)).body.outcome).toBe('vigente');
    });

    it('a socio who leaves stops counting: their link no longer works and the rest can finish', async () => {
      const s = await scenario('leaves', 3);
      const [a, b, c] = s.socios as [Who, Who, Who];
      const { set, links } = await propose(s, a);
      await respond(tokenOf(a, links), 'approve').expect(200);
      await withTestTenant(s.contextId, () => prisma.member.update({ where: { id: c.memberId }, data: { active: false } }));
      expect((await inspect(tokenOf(c, links))).status).toBe(404);
      expect((await respond(tokenOf(c, links), 'approve')).status).toBe(404);
      expect((await respond(tokenOf(b, links), 'approve').expect(200)).body.outcome).toBe('vigente');
      expect(await withTestTenant(s.contextId, () => prisma.financeRuleApproval.count({ where: { ruleSetId: set.id } }))).toBe(2);
    });

    it('when the last one missing leaves, re-sending settles the proposal', async () => {
      const s = await scenario('leaves-last', 2);
      const [a, b] = s.socios as [Who, Who];
      const { set, links } = await propose(s, a);
      await respond(tokenOf(a, links), 'approve').expect(200);
      await withTestTenant(s.contextId, () => prisma.member.update({ where: { id: b.memberId }, data: { active: false } }));
      const res = (await call(s, a, 'post', `/${set.id}/resend`).expect(200)).body;
      expect(res).toMatchObject({ activated: true, resent: [] });
      expect((await row(s, set.id)).status).toBe('vigente');
    });
  });

  describe('objecting', () => {
    it('needs a reason: nothing is recorded without one, and 500 characters at most', async () => {
      const s = await scenario('reason', 2);
      const { set, links } = await propose(s, s.socios[0]!);
      const token = tokenOf(s.socios[1]!, links);
      const blank = await respond(token, 'object').expect(400);
      expect(blank.body.code).toBe('AGREEMENT_REASON_REQUIRED');
      expect((await respond(token, 'object', '   ').expect(400)).body.code).toBe('AGREEMENT_REASON_REQUIRED');
      expect((await respond(token, 'object', 'x'.repeat(501)).expect(400)).body).toBeDefined();
      expect((await row(s, set.id)).status).toBe('pendiente');
      expect(await withTestTenant(s.contextId, () => prisma.financeRuleObjection.count({ where: { contextId: s.contextId } }))).toBe(0);
      expect((await respond(token, 'object', 'x'.repeat(500)).expect(200)).body.outcome).toBe('objetada');
    });

    it('puts the proposal in review, sends NO email, and shows the reason with the address masked', async () => {
      const s = await scenario('object', 3);
      const { set, links } = await propose(s, s.socios[0]!);
      sendApproval.mockClear();
      const res = await respond(tokenOf(s.socios[1]!, links), 'object', '  Quiero  más <b>reservas</b>.\u0000  ').expect(200);
      expect(res.body).toEqual({ outcome: 'objetada' });
      expect(sendApproval).not.toHaveBeenCalled();
      const view = await overview(s, s.socios[0]!);
      expect(view).toMatchObject({ state: 'en_revision' });
      expect(view.proposal).toMatchObject({ status: 'en_revision', id: set.id });
      expect(view.proposal.objections).toEqual([
        { memberId: s.socios[1]!.memberId, name: 'Beto', correo: expect.stringMatching(/^b\*\*\*@/), reason: 'Quiero más <b>reservas</b>.', createdAt: expect.any(String) },
      ]);
      const [stored] = await withTestTenant(s.contextId, () => prisma.financeRuleObjection.findMany({ where: { contextId: s.contextId } }));
      expect(stored!.correo).toBe(s.socios[1]!.correo);
      expect(view.partners.map((p: { response: string | null }) => p.response)).toEqual([null, 'objeto', null]);
    });

    it('the other links stop accepting approvals and say so; nothing is recorded', async () => {
      const s = await scenario('review', 3);
      const { set, links } = await propose(s, s.socios[0]!);
      await respond(tokenOf(s.socios[1]!, links), 'object', 'No me convence').expect(200);

      const page = await inspect(tokenOf(s.socios[2]!, links)).expect(200);
      expect(page.body).toMatchObject({ state: 'en_revision', message: IN_REVIEW });
      const late = await respond(tokenOf(s.socios[2]!, links), 'approve').expect(200);
      expect(late.body).toEqual({ outcome: 'en_revision' });
      expect(await withTestTenant(s.contextId, () => prisma.financeRuleApproval.count({ where: { ruleSetId: set.id } }))).toBe(0);
      expect((await row(s, set.id)).status).toBe('en_revision');
      // The rules that were in force stay in force.
      expect((await call(s, s.socios[0]!, 'post', `/${set.id}/resend`)).status).toBe(409);
    });

    it('an approval and an objection at the same moment leave one consistent state', async () => {
      const s = await scenario('mix', 2);
      const { set, links } = await propose(s, s.socios[0]!);
      const [a, b] = await Promise.all([
        respond(tokenOf(s.socios[0]!, links), 'approve'),
        respond(tokenOf(s.socios[1]!, links), 'object', 'Pausa'),
      ]);
      expect([a.status, b.status]).toEqual([200, 200]);
      const final = await row(s, set.id);
      expect(final.status).toBe('en_revision');
      expect(await withTestTenant(s.contextId, () => prisma.financeRuleObjection.count({ where: { ruleSetId: set.id } }))).toBe(1);
    });

    it('objections cannot be edited or deleted, even straight at the database', async () => {
      const s = await scenario('immutable', 2);
      const { links } = await propose(s, s.socios[0]!);
      await respond(tokenOf(s.socios[1]!, links), 'object', 'Motivo').expect(200);
      await expect(
        withTestTenant(s.contextId, () => prisma.financeRuleObjection.updateMany({ where: { contextId: s.contextId }, data: { reason: 'otro' } })),
      ).rejects.toThrow(TRIGGER_REFUSAL);
      await expect(
        withTestTenant(s.contextId, () => prisma.financeRuleObjection.deleteMany({ where: { contextId: s.contextId } })),
      ).rejects.toThrow(TRIGGER_REFUSAL);
    });
  });

  describe('modifying and discarding', () => {
    it('Modify copies the proposal into a draft the caller owns, with the objections on top', async () => {
      const s = await scenario('modify', 3);
      const { set, links } = await propose(s, s.socios[0]!);
      await respond(tokenOf(s.socios[1]!, links), 'object', 'Más reservas').expect(200);

      const draft = (await call(s, s.socios[2]!, 'post', `/${set.id}/modify`).expect(200)).body;
      expect(draft).toMatchObject({ status: 'borrador', version: 2, config: set.config, proposedBy: { name: 'Carla' } });
      expect(draft.basedOn).toMatchObject({ id: set.id, version: 1 });
      expect(draft.basedOn.objections).toEqual([expect.objectContaining({ name: 'Beto', reason: 'Más reservas' })]);
      // The proposal it comes from is untouched until the new one is sent.
      expect((await row(s, set.id)).status).toBe('en_revision');
      // Only one draft at a time.
      expect((await call(s, s.socios[0]!, 'post', `/${set.id}/modify`).expect(409)).body.code).toBe('FINANCE_RULES_DRAFT_EXISTS');
    });

    it('sending the new version emails EVERYONE with "what changed", closes the old one, and carries no approvals over', async () => {
      const s = await scenario('resubmit', 3);
      const first = await propose(s, s.socios[0]!, 10);
      await respond(tokenOf(s.socios[0]!, first.links), 'approve').expect(200);
      await respond(tokenOf(s.socios[1]!, first.links), 'object', 'Más reservas').expect(200);

      const draft = (await call(s, s.socios[1]!, 'post', `/${first.set.id}/modify`).expect(200)).body;
      await call(s, s.socios[1]!, 'put', '/draft', { config: config(25) }).expect(200);
      sendApproval.mockClear();
      const sent = (await call(s, s.socios[1]!, 'post', `/${draft.id}/submit`).expect(200)).body;

      expect(sent).toMatchObject({ status: 'pendiente', version: 2, emails: { sent: ['Ana', 'Beto', 'Carla'], failed: [] } });
      expect(sendApproval).toHaveBeenCalledTimes(3);
      for (const [mail] of sendApproval.mock.calls)
        expect(mail.changes).toEqual([
          { topic: 'Reservas', before: 'Se aparta 10 % para reservas antes de repartir.', after: 'Se aparta 25 % para reservas antes de repartir.' },
        ]);
      expect(sent.changes).toHaveLength(1);
      expect(sent.approvals).toEqual([]);
      const old = await row(s, first.set.id);
      expect(old).toMatchObject({ status: 'descartada', closedNote: 'Reemplazada por la versión 2.' });
      // The old links no longer work; the new ones do, and everyone answers again.
      expect((await inspect(tokenOf(s.socios[2]!, first.links))).status).toBe(404);
      const links = lastLinks(3);
      expect((await inspect(tokenOf(s.socios[2]!, links))).body).toMatchObject({ version: 2, changes: [expect.objectContaining({ topic: 'Reservas' })] });
      expect(await approveAll(s, links)).toContain('vigente');
    });

    it('a new proposal is compared with the rules in force when it is not a modification', async () => {
      const s = await scenario('vs-force', 1);
      const first = await propose(s, s.socios[0]!, 10);
      await approveAll(s, first.links);
      const second = await propose(s, s.socios[0]!, 30);
      expect(second.set.changes).toEqual([expect.objectContaining({ topic: 'Reservas' })]);
      const sameAgain = await scenario('vs-none', 1);
      expect((await propose(sameAgain, sameAgain.socios[0]!)).set.changes).toBeNull();
    });

    it('any socio can discard an open proposal; it leaves the history as descartada and its links die', async () => {
      const s = await scenario('discard', 3);
      const { set, links } = await propose(s, s.socios[0]!);
      const discarded = (await call(s, s.socios[2]!, 'post', `/${set.id}/discard`).expect(200)).body;
      expect(discarded).toMatchObject({ status: 'descartada', closedNote: 'Descartada por Carla.', discardedAt: expect.any(String) });
      expect((await inspect(tokenOf(s.socios[1]!, links))).status).toBe(404);
      expect((await overview(s, s.socios[0]!)).history.map((h: { status: string }) => h.status)).toEqual(['descartada']);
      // A new proposal can be made at once.
      await propose(s, s.socios[0]!, 15);
    });

    it('an in-review proposal can also be discarded, and rules in force cannot', async () => {
      const s = await scenario('discard-review', 2);
      const forced = await propose(s, s.socios[0]!);
      await approveAll(s, forced.links);
      const next = await propose(s, s.socios[0]!, 40);
      await respond(tokenOf(s.socios[1]!, next.links), 'object', 'No').expect(200);
      await call(s, s.socios[0]!, 'post', `/${next.set.id}/discard`).expect(200);
      expect((await call(s, s.socios[0]!, 'post', `/${forced.set.id}/discard`).expect(409)).body.code).toBe('FINANCE_RULES_WRONG_STATE');
      expect((await call(s, s.socios[0]!, 'post', `/${forced.set.id}/modify`).expect(409)).body.code).toBe('FINANCE_RULES_WRONG_STATE');
      expect((await overview(s, s.socios[0]!)).inForce.id).toBe(forced.set.id);
    });
  });

  describe('re-sending', () => {
    it('reaches only who is missing, replaces their link, and at most once every 24 hours each', async () => {
      const s = await scenario('resend', 3);
      const { set, links } = await propose(s, s.socios[0]!);
      await respond(tokenOf(s.socios[0]!, links), 'approve').expect(200);
      sendApproval.mockClear();

      const first = (await call(s, s.socios[1]!, 'post', `/${set.id}/resend`).expect(200)).body;
      expect(first.resent.map((r: { name: string }) => r.name)).toEqual(['Beto', 'Carla']);
      expect(first.skipped).toEqual([]);
      expect(sendApproval).toHaveBeenCalledTimes(2);
      const fresh = lastLinks(2);
      // The previous links stop working; the new ones work.
      expect((await inspect(tokenOf(s.socios[1]!, links))).status).toBe(404);
      expect((await inspect(tokenOf(s.socios[1]!, fresh))).status).toBe(200);

      sendApproval.mockClear();
      const second = (await call(s, s.socios[0]!, 'post', `/${set.id}/resend`).expect(200)).body;
      expect(second.resent).toEqual([]);
      expect(second.skipped.map((r: { name: string }) => r.name)).toEqual(['Beto', 'Carla']);
      expect(sendApproval).not.toHaveBeenCalled();
      const view = await overview(s, s.socios[0]!);
      expect(view.partners.find((p: { name: string }) => p.name === 'Beto').link.canResendAt).toEqual(expect.any(String));

      // After 24 hours it can go again.
      await withTestTenant(s.contextId, () =>
        prisma.financeRuleLink.updateMany({
          where: { contextId: s.contextId },
          data: { createdAt: new Date(Date.now() - 2 * DAY), expiresAt: new Date(Date.now() + 5 * DAY) },
        }),
      );
      const third = (await call(s, s.socios[2]!, 'post', `/${set.id}/resend`).expect(200)).body;
      expect(third.resent.map((r: { name: string }) => r.name)).toEqual(['Beto', 'Carla']);
    });

    it('simultaneous re-sends send one email per socio', async () => {
      const s = await scenario('resend-race', 2);
      const { set } = await propose(s, s.socios[0]!);
      sendApproval.mockClear();
      const results = await Promise.all([
        call(s, s.socios[0]!, 'post', `/${set.id}/resend`),
        call(s, s.socios[1]!, 'post', `/${set.id}/resend`),
      ]);
      expect(results.map((r) => r.status)).toEqual([200, 200]);
      expect(sendApproval).toHaveBeenCalledTimes(2);
    });

    it('an expired link leaves the proposal pending, and any socio can re-send', async () => {
      const s = await scenario('expired', 2);
      const { set, links } = await propose(s, s.socios[0]!);
      await withTestTenant(s.contextId, () =>
        prisma.financeRuleLink.updateMany({
          where: { contextId: s.contextId },
          data: { createdAt: new Date(Date.now() - 9 * DAY), expiresAt: new Date(Date.now() - 2 * DAY) },
        }),
      );
      expect((await respond(tokenOf(s.socios[0]!, links), 'approve')).status).toBe(404);
      const view = await overview(s, s.socios[1]!);
      expect(view.state).toBe('pendiente');
      expect(view.partners[0].link).toMatchObject({ expired: true });
      const resent = (await call(s, s.socios[1]!, 'post', `/${set.id}/resend`).expect(200)).body;
      expect(resent.resent).toHaveLength(2);
      expect((await respond(lastLinks(2)[s.socios[0]!.correo!]!, 'approve').expect(200)).body.outcome).toBe('aprobada');
    });

    it('is refused for a proposal in review or one that is not open', async () => {
      const s = await scenario('resend-state', 2);
      const draft = (await call(s, s.socios[0]!, 'put', '/draft', { config: config() }).expect(200)).body;
      expect((await call(s, s.socios[0]!, 'post', `/${draft.id}/resend`).expect(409)).body.code).toBe('FINANCE_RULES_WRONG_STATE');
      const sent = (await call(s, s.socios[0]!, 'post', `/${draft.id}/submit`).expect(200)).body;
      await respond(lastLinks(2)[s.socios[1]!.correo!]!, 'object', 'No').expect(200);
      const res = await call(s, s.socios[0]!, 'post', `/${sent.id}/resend`).expect(409);
      expect(res.body).toMatchObject({ code: 'FINANCE_RULES_IN_REVIEW', message: 'Esta propuesta está en revisión. Modifícala o descártala.' });
    });

    it('skips a socio who has no address and says so', async () => {
      const s = await scenario('resend-noemail', 2);
      const { set } = await propose(s, s.socios[0]!);
      await withTestTenant(s.contextId, () => prisma.member.update({ where: { id: s.socios[1]!.memberId }, data: { correo: null } }));
      const res = (await call(s, s.socios[0]!, 'post', `/${set.id}/resend`).expect(200)).body;
      expect(res.noEmail).toEqual([{ memberId: s.socios[1]!.memberId, name: 'Beto' }]);
      expect(res.resent.map((r: { name: string }) => r.name)).toEqual(['Ana']);
    });
  });

  describe('what stays out of logs and responses', () => {
    it('no token appears in any log line while sending, re-sending, reading and answering', async () => {
      const logged: string[] = [];
      const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map((level) =>
        vi.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => void logged.push(JSON.stringify(args))),
      );
      const out = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => (logged.push(String(chunk)), true)) as never);
      try {
        const s = await scenario('logs', 2);
        const { set, links } = await propose(s, s.socios[0]!);
        await call(s, s.socios[0]!, 'post', `/${set.id}/resend`).expect(200);
        const fresh = lastLinks(2);
        await inspect(fresh[s.socios[1]!.correo!]!).expect(200);
        await respond(fresh[s.socios[1]!.correo!]!, 'approve').expect(200);
        await inspect(Object.values(links)[0]!);
        const tokens = [...Object.values(links), ...Object.values(fresh)];
        for (const token of tokens) expect(logged.join('\n')).not.toContain(token);
      } finally {
        spies.forEach((spy) => spy.mockRestore());
        out.mockRestore();
      }
    });

    it('the overview never carries a complete address of anyone but the caller\'s masked one', async () => {
      const s = await scenario('masked', 2);
      const { links } = await propose(s, s.socios[0]!);
      await respond(tokenOf(s.socios[1]!, links), 'object', 'Hola').expect(200);
      const body = JSON.stringify(await overview(s, s.socios[0]!));
      for (const socio of s.socios) expect(body).not.toContain(socio.correo!);
    });
  });

  describe('isolation between businesses', () => {
    it('another business never sees or touches these rules', async () => {
      const s = await scenario('iso-a', 1);
      const t = await scenario('iso-b', 1);
      const { set } = await propose(s, s.socios[0]!);
      expect((await overview(t, t.socios[0]!)).history).toEqual([]);
      for (const action of ['discard', 'submit', 'modify', 'resend'])
        await call(t, t.socios[0]!, 'post', `/${set.id}/${action}`).expect(404);
      expect((await overview(s, s.socios[0]!)).proposal.approvals).toEqual([]);
    });

    it('versions are numbered per business', async () => {
      const s = await scenario('ver-a', 1);
      const t = await scenario('ver-b', 1);
      const one = (await call(s, s.socios[0]!, 'put', '/draft', { config: config() }).expect(200)).body;
      const other = (await call(t, t.socios[0]!, 'put', '/draft', { config: config() }).expect(200)).body;
      expect([one.version, other.version]).toEqual([1, 1]);
    });

    it('the link tables are not readable or writable without the business, nor from another business', async () => {
      const s = await scenario('rls', 2);
      await propose(s, s.socios[0]!);
      const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
      await client.connect();
      try {
        for (const table of ['FinanceRuleLink', 'FinanceRuleObjection', 'MemberEmailConfirmation'])
          expect((await client.query(`SELECT * FROM "${table}"`)).rowCount).toBe(0);
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.context_id', 'otro-negocio', true)");
        expect((await client.query('SELECT * FROM "FinanceRuleLink"')).rowCount).toBe(0);
        await client.query('ROLLBACK');
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.context_id', $1, true)", [s.contextId]);
        expect((await client.query('SELECT * FROM "FinanceRuleLink"')).rowCount).toBe(2);
        await client.query('ROLLBACK');
      } finally {
        await client.end();
      }
    });
  });
});

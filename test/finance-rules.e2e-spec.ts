import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { v7 } from 'uuid';
import { vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { EmailService } from '../src/email/email.service.js';
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

interface Who {
  memberId: string;
  token: string;
}
interface Scenario {
  contextId: string;
  deviceId: string;
  shared: Who[]; // login without a bound member, one entry per socio
  bound: Who[]; // login bound to its own socio
  colaborador: Who;
}

describe('finance rules: versions and approvals', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const sendReminder = vi.fn().mockResolvedValue(undefined);
  const contexts: string[] = [];

  const newContext = (label: string) => {
    const id = `rules-${label}-${randomUUID()}`;
    contexts.push(id);
    return id;
  };

  /** A business with `bound` socios that have their own login, `unbound` that use a shared one. */
  const scenario = async (label: string, bound: number, unbound = 0): Promise<Scenario> => {
    const contextId = newContext(label);
    const jwt = app.get(JwtService);
    const login = async (memberId: string | null, username = randomUUID()) => {
      const account = await prisma.account.create({
        data: { username, passwordHash: 'x', contextId, memberId },
      });
      return jwt.signAsync({ sub: account.id });
    };
    const sharedAccount = unbound
      ? await prisma.account.create({
          data: { username: randomUUID(), passwordHash: 'x', contextId },
        })
      : null;
    const sharedToken = sharedAccount ? await jwt.signAsync({ sub: sharedAccount.id }) : '';
    return withTestTenant(contextId, async () => {
      const deviceId = (
        await prisma.device.create({ data: { contextId, name: 'Tablet', authorized: true } })
      ).id;
      const make = (name: string, role: 'socio' | 'colaborador' = 'socio') =>
        prisma.member.create({ data: { contextId, name, role } });
      const sharedWho: Who[] = [];
      for (let i = 0; i < unbound; i++)
        sharedWho.push({ memberId: (await make(`Compartido ${i}`)).id, token: sharedToken });
      const boundWho: Who[] = [];
      for (let i = 0; i < bound; i++) {
        const member = await make(`Socio ${i}`);
        boundWho.push({ memberId: member.id, token: await login(member.id, `socio${i}-${randomUUID()}@example.test`) });
      }
      const colab = await make('Colaborador', 'colaborador');
      return {
        contextId,
        deviceId,
        shared: sharedWho,
        bound: boundWho,
        colaborador: { memberId: colab.id, token: await login(colab.id) },
      };
    });
  };

  const call = (s: Scenario, who: Who, method: 'get' | 'put' | 'post', path: string, body?: object) => {
    const req = request(app.getHttpServer())[method](`/api/v1/finance/rules${path}`)
      .auth(who.token, { type: 'bearer' })
      .set('x-member-id', who.memberId)
      .set('x-device-id', s.deviceId);
    return body === undefined ? req : req.send(body);
  };
  const overview = async (s: Scenario, who: Who) => (await call(s, who, 'get', '').expect(200)).body;

  /** Draft → submit, as `who`; returns the pending rule set. */
  const propose = async (s: Scenario, who: Who, reserve = 10) => {
    const draft = (await call(s, who, 'put', '/draft', { config: config(reserve) }).expect(200)).body;
    return (await call(s, who, 'post', `/${draft.id}/submit`).expect(200)).body;
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EmailService)
      .useValue({ sendFinanceRulesReminderEmail: sendReminder })
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
        // Logins bound to a member reference it, so they go first.
        await prisma.account.deleteMany({ where: { contextId } });
        await withTestTenant(contextId, async () => {
          await prisma.device.deleteMany({ where: { contextId } });
          await prisma.member.deleteMany({ where: { contextId } });
        });
      }
    }
    await app?.close();
  });
  beforeEach(() => sendReminder.mockClear());

  describe('a business that never configured rules', () => {
    it('starts without rules and the finance overview is unchanged', async () => {
      const s = await scenario('none', 2);
      const body = await overview(s, s.bound[0]!);
      expect(body).toMatchObject({ state: 'sin_aprobar', inForce: null, pending: null, draft: null, history: [] });
      expect(body.disclaimer).toContain('No es asesoría contable ni legal');
      const finance = await request(app.getHttpServer())
        .get('/api/v1/finance/overview')
        .query({ from: '2026-10-01', to: '2026-11-01' })
        .auth(s.bound[0]!.token, { type: 'bearer' })
        .set('x-member-id', s.bound[0]!.memberId)
        .set('x-device-id', s.deviceId);
      expect(finance.status).toBe(200);
      expect(JSON.stringify(finance.body)).not.toContain('ruleSet');
    });
  });

  describe('draft', () => {
    it('rejects invalid rules listing every problem, and creates nothing', async () => {
      const s = await scenario('invalid', 1);
      const bad = config();
      bad.profitBase = { partnerPct: 50, capitalPct: 30, workPct: 10 };
      (bad as Record<string, unknown>).partnerExpenses = 'nunca';
      const res = await call(s, s.bound[0]!, 'put', '/draft', { config: bad }).expect(400);
      expect(res.body.code).toBe('FINANCE_RULES_INVALID');
      expect(res.body.message).toContain('deben sumar 100');
      expect(res.body.message).toContain('partnerExpenses');
      expect((await overview(s, s.bound[0]!)).draft).toBeNull();
    });

    it('creates version 1, then keeps editing the same draft; unusual values only warn', async () => {
      const s = await scenario('draft', 2);
      const first = (await call(s, s.bound[0]!, 'put', '/draft', { config: config(10) }).expect(200)).body;
      expect(first).toMatchObject({ version: 1, status: 'borrador' });
      const second = (await call(s, s.bound[0]!, 'put', '/draft', { config: config(80) }).expect(200)).body;
      expect(second.id).toBe(first.id);
      expect(second.version).toBe(1);
      expect(second.config.reserves).toEqual({ kind: 'porcentaje', pct: 80 });
      expect(second.configHash).not.toBe(first.configHash);
      expect(second.warnings.map((w: { code: string }) => w.code)).toContain('RESERVES_HIGH');
    });

    it('another socio cannot take over an open draft', async () => {
      const s = await scenario('owned', 2);
      await call(s, s.bound[0]!, 'put', '/draft', { config: config() }).expect(200);
      const res = await call(s, s.bound[1]!, 'put', '/draft', { config: config() }).expect(409);
      expect(res.body.code).toBe('FINANCE_RULES_DRAFT_OWNED');
    });

    it('a discarded draft becomes retirada and a new one gets the next version', async () => {
      const s = await scenario('discard', 1);
      const draft = (await call(s, s.bound[0]!, 'put', '/draft', { config: config() }).expect(200)).body;
      const discarded = (await call(s, s.bound[0]!, 'post', `/${draft.id}/discard`).expect(200)).body;
      expect(discarded.status).toBe('retirada');
      const next = (await call(s, s.bound[0]!, 'put', '/draft', { config: config() }).expect(200)).body;
      expect(next.version).toBe(2);
      const history = (await overview(s, s.bound[0]!)).history;
      expect(history.map((h: { status: string }) => h.status)).toEqual(['retirada']);
    });

    it('rejects extra properties in the body', async () => {
      const s = await scenario('extra', 1);
      await call(s, s.bound[0]!, 'put', '/draft', { config: config(), contextId: 'other' }).expect(400);
    });
  });

  describe('submitting freezes the rules', () => {
    it('only the proposer submits; a second pending proposal is refused', async () => {
      const s = await scenario('submit', 2);
      const draft = (await call(s, s.bound[0]!, 'put', '/draft', { config: config() }).expect(200)).body;
      const res = await call(s, s.bound[1]!, 'post', `/${draft.id}/submit`).expect(403);
      expect(res.body.code).toBe('FINANCE_RULES_NOT_PROPOSER');
      const pending = (await call(s, s.bound[0]!, 'post', `/${draft.id}/submit`).expect(200)).body;
      expect(pending).toMatchObject({ status: 'pendiente' });
      expect(pending.missing).toHaveLength(2);
      const other = (await call(s, s.bound[0]!, 'put', '/draft', { config: config(20) }).expect(200)).body;
      const clash = await call(s, s.bound[0]!, 'post', `/${other.id}/submit`).expect(409);
      expect(clash.body.code).toBe('FINANCE_RULES_PENDING_EXISTS');
    });

    it('a submitted rule set cannot be edited, even straight at the database', async () => {
      const s = await scenario('frozen', 1);
      const pending = await propose(s, s.bound[0]!);
      await expect(
        withTestTenant(s.contextId, () =>
          prisma.financeRuleSet.update({
            where: { id: pending.id },
            data: { config: config(99), configHash: 'a'.repeat(64) },
          }),
        ),
      ).rejects.toThrow(TRIGGER_REFUSAL);
      await expect(
        withTestTenant(s.contextId, () => prisma.financeRuleSet.deleteMany({ where: { id: pending.id } })),
      ).rejects.toThrow(TRIGGER_REFUSAL);
      const draftAgain = await call(s, s.bound[0]!, 'put', '/draft', { config: config(55) }).expect(200);
      expect(draftAgain.body.id).not.toBe(pending.id);
      expect((await overview(s, s.bound[0]!)).pending.config.reserves.pct).toBe(10);
    });

    it('status only moves along the allowed paths', async () => {
      const s = await scenario('paths', 1);
      const pending = await propose(s, s.bound[0]!);
      await call(s, s.bound[0]!, 'post', `/${pending.id}/approve`).expect(200);
      await expect(
        withTestTenant(s.contextId, () =>
          prisma.financeRuleSet.update({ where: { id: pending.id }, data: { status: 'borrador' } }),
        ),
      ).rejects.toThrow(TRIGGER_REFUSAL);
      expect((await overview(s, s.bound[0]!)).inForce.id).toBe(pending.id);
    });
  });

  describe('approval', () => {
    it('a single socio approves and the rules are in force at once', async () => {
      const s = await scenario('solo', 1);
      const pending = await propose(s, s.bound[0]!);
      const done = (await call(s, s.bound[0]!, 'post', `/${pending.id}/approve`).expect(200)).body;
      expect(done.status).toBe('vigente');
      expect(done.activatedAt).toEqual(expect.any(String));
      expect(done.approvals).toHaveLength(1);
      expect((await overview(s, s.bound[0]!)).state).toBe('vigente');
    });

    it('a lone socio on a shared login may approve (no one else to speak for)', async () => {
      const s = await scenario('solo-shared', 0, 1);
      const pending = await propose(s, s.shared[0]!);
      const who = s.shared[0]!;
      expect((await overview(s, who)).me.canApprove).toBe(true);
      const done = (await call(s, who, 'post', `/${pending.id}/approve`).expect(200)).body;
      expect(done.status).toBe('vigente');
    });

    it('with several socios a shared login is told why it cannot approve, in Spanish', async () => {
      const s = await scenario('shared-many', 1, 1);
      const pending = await propose(s, s.bound[0]!);
      const who = s.shared[0]!;
      const view = await overview(s, who);
      expect(view.me.canApprove).toBe(false);
      expect(view.me.cannotApproveReason).toContain('Cada socio necesita su propia cuenta');
      const res = await call(s, who, 'post', `/${pending.id}/approve`).expect(403);
      expect(res.body).toMatchObject({ code: 'FINANCE_RULES_SHARED_LOGIN' });
      expect(res.body.message).toBe(view.me.cannotApproveReason);
      expect((await overview(s, who)).pending.approvals).toEqual([]);
      for (const sentence of (res.body.message as string).split(/(?<=\.)\s+/))
        expect(sentence.split(/\s+/).length).toBeLessThanOrEqual(20);
    });

    it('needs every active socio and activates only with the last one', async () => {
      const s = await scenario('all', 3);
      const [a, b, c] = s.bound as [Who, Who, Who];
      const pending = await propose(s, a);
      const afterA = (await call(s, a, 'post', `/${pending.id}/approve`).expect(200)).body;
      expect(afterA.status).toBe('pendiente');
      expect(afterA.missing.map((m: { memberId: string }) => m.memberId).sort()).toEqual(
        [b.memberId, c.memberId].sort(),
      );
      await call(s, b, 'post', `/${pending.id}/approve`).expect(200);
      expect((await overview(s, a)).state).toBe('pendiente');
      const last = (await call(s, c, 'post', `/${pending.id}/approve`).expect(200)).body;
      expect(last.status).toBe('vigente');
      expect(last.approvals).toHaveLength(3);
      expect(last.approvals.every((x: { name: string }) => x.name.length > 0)).toBe(true);
    });

    it('approving twice changes nothing and is not an error', async () => {
      const s = await scenario('twice', 2);
      const pending = await propose(s, s.bound[0]!);
      await call(s, s.bound[0]!, 'post', `/${pending.id}/approve`).expect(200);
      const again = (await call(s, s.bound[0]!, 'post', `/${pending.id}/approve`).expect(200)).body;
      expect(again.approvals).toHaveLength(1);
      expect(again.status).toBe('pendiente');
    });

    it('a colaborador is refused on every route, even naming a socio', async () => {
      const s = await scenario('colab', 1);
      const pending = await propose(s, s.bound[0]!);
      const intruder = { token: s.colaborador.token, memberId: s.bound[0]!.memberId };
      await call(s, intruder, 'post', `/${pending.id}/approve`).expect(403);
      await call(s, s.colaborador, 'post', `/${pending.id}/approve`).expect(403);
      await call(s, s.colaborador, 'get', '').expect(403);
      expect((await overview(s, s.bound[0]!)).pending.approvals).toEqual([]);
    });

    it('guarda cómo se creó la cuenta de quien aprueba y lo muestra en el historial y en el aviso de vigencia', async () => {
      const s = await scenario('origin', 2);
      const [a, b] = s.bound as [Who, Who];
      const account = await prisma.account.findFirstOrThrow({ where: { memberId: b.memberId } });
      const acceptedAt = new Date(Date.now() - 2 * 24 * 3600_000);
      await withTestTenant(s.contextId, () =>
        prisma.accountInvitation.create({
          data: {
            id: v7(), contextId: s.contextId, memberId: b.memberId, email: `inv-${randomUUID()}@example.test`,
            tokenHash: randomUUID().replaceAll('-', '').repeat(2), invitedByMemberId: a.memberId,
            createdAt: new Date(acceptedAt.getTime() - 60_000), expiresAt: new Date(Date.now() + 3600_000),
            usedAt: acceptedAt, accountId: account.id,
          },
        }),
      );
      const pending = await propose(s, a);
      await call(s, a, 'post', `/${pending.id}/approve`).expect(200);
      const done = (await call(s, b, 'post', `/${pending.id}/approve`).expect(200)).body;

      const byName = (name: string) => done.approvals.find((x: { name: string }) => x.name === name);
      expect(byName('Socio 0').origin).toMatchObject({ kind: 'own_account' });
      expect(byName('Socio 1').origin).toMatchObject({
        kind: 'invited', invitedByName: 'Socio 0', recent: true, acceptedAt: acceptedAt.toISOString(),
      });
      expect(done.status).toBe('vigente');
      expect(done.recentInvitedApprovers).toEqual([
        { memberId: b.memberId, name: 'Socio 1', invitedByName: 'Socio 0', acceptedAt: acceptedAt.toISOString() },
      ]);
      const stored = await withTestTenant(s.contextId, () =>
        prisma.financeRuleApproval.findMany({ where: { ruleSetId: pending.id }, orderBy: { approvedAt: 'asc' } }),
      );
      expect(stored.map((r) => (r.accountOrigin as { kind: string }).kind)).toEqual(['own_account', 'invited']);
      // The invitation can change later; what the approval recorded does not.
      await withTestTenant(s.contextId, () => prisma.accountInvitation.deleteMany({ where: { contextId: s.contextId } }));
      const view = await overview(s, a);
      expect(view.inForce.recentInvitedApprovers).toHaveLength(1);
      expect(view.history[0].approvals.map((x: { origin: { kind: string } }) => x.origin.kind)).toEqual(['own_account', 'invited']);
    });

    it('the replaced rules stay in the history and exactly one set is in force', async () => {
      const s = await scenario('replace', 2);
      const [a, b] = s.bound as [Who, Who];
      const v1 = await propose(s, a, 10);
      await call(s, a, 'post', `/${v1.id}/approve`).expect(200);
      await call(s, b, 'post', `/${v1.id}/approve`).expect(200);
      const v2 = await propose(s, b, 15);
      expect(v2.version).toBe(2);
      const during = await overview(s, a);
      expect(during.state).toBe('pendiente');
      expect(during.inForce.version).toBe(1);
      await call(s, a, 'post', `/${v2.id}/approve`).expect(200);
      expect((await overview(s, a)).inForce.version).toBe(1);
      await call(s, b, 'post', `/${v2.id}/approve`).expect(200);
      const end = await overview(s, a);
      expect(end.inForce).toMatchObject({ version: 2, status: 'vigente' });
      expect(end.history.map((h: { version: number; status: string }) => [h.version, h.status])).toEqual([
        [2, 'vigente'],
        [1, 'reemplazada'],
      ]);
    });

    it('two last approvals at the same moment activate the rules exactly once', async () => {
      const s = await scenario('race', 2);
      const [a, b] = s.bound as [Who, Who];
      for (let round = 1; round <= 4; round++) {
        const pending = await propose(s, a, round);
        const results = await Promise.all([
          call(s, a, 'post', `/${pending.id}/approve`),
          call(s, b, 'post', `/${pending.id}/approve`),
        ]);
        expect(results.map((r) => r.status)).toEqual([200, 200]);
        const sets = await withTestTenant(s.contextId, () =>
          prisma.financeRuleSet.findMany({ where: { contextId: s.contextId }, orderBy: { version: 'asc' } }),
        );
        expect(sets.filter((x) => x.status === 'vigente')).toHaveLength(1);
        expect(sets.at(-1)).toMatchObject({ version: round, status: 'vigente' });
        expect(sets.filter((x) => x.status === 'reemplazada')).toHaveLength(round - 1);
        const approvals = await withTestTenant(s.contextId, () =>
          prisma.financeRuleApproval.count({ where: { ruleSetId: pending.id } }),
        );
        expect(approvals).toBe(2);
      }
    });

    it('a socio who joins while a proposal is pending must approve it too', async () => {
      const s = await scenario('joins', 2);
      const [a, b] = s.bound as [Who, Who];
      const pending = await propose(s, a);
      await call(s, a, 'post', `/${pending.id}/approve`).expect(200);
      const newcomer = await withTestTenant(s.contextId, async () => {
        const member = await prisma.member.create({ data: { contextId: s.contextId, name: 'Nuevo', role: 'socio' } });
        const account = await prisma.account.create({
          data: { username: `${randomUUID()}@example.test`, passwordHash: 'x', contextId: s.contextId, memberId: member.id },
        });
        return { memberId: member.id, token: await app.get(JwtService).signAsync({ sub: account.id }) };
      });
      expect((await call(s, b, 'post', `/${pending.id}/approve`).expect(200)).body.status).toBe('pendiente');
      const last = (await call(s, newcomer, 'post', `/${pending.id}/approve`).expect(200)).body;
      expect(last.status).toBe('vigente');
    });

    it('a socio who leaves stops counting', async () => {
      const s = await scenario('leaves', 3);
      const [a, b, c] = s.bound as [Who, Who, Who];
      const pending = await propose(s, a);
      await call(s, a, 'post', `/${pending.id}/approve`).expect(200);
      await call(s, b, 'post', `/${pending.id}/approve`).expect(200);
      await withTestTenant(s.contextId, () =>
        prisma.member.update({ where: { id: c.memberId }, data: { active: false } }),
      );
      const settled = (await call(s, a, 'post', `/${pending.id}/approve`).expect(200)).body;
      expect(settled.status).toBe('vigente');
      expect(settled.approvals).toHaveLength(2);
    });

    it('an approval for a stale hash cannot be recorded', async () => {
      const s = await scenario('hash', 1);
      const pending = await propose(s, s.bound[0]!);
      const account = await prisma.account.findFirstOrThrow({ where: { memberId: s.bound[0]!.memberId } });
      const record = (approvedHash: string) =>
        withTestTenant(s.contextId, () =>
          prisma.financeRuleApproval.create({
            data: {
              id: v7(),
              contextId: s.contextId,
              ruleSetId: pending.id,
              memberId: s.bound[0]!.memberId,
              approvedByAccountId: account.id,
              approvedHash,
            },
          }),
        );
      await expect(record('b'.repeat(64))).rejects.toThrow(TRIGGER_REFUSAL);
      await expect(record(pending.configHash)).resolves.toMatchObject({ approvedHash: pending.configHash });
    });
  });

  describe('withdrawing', () => {
    it('returns the proposal to draft and erases the approvals', async () => {
      const s = await scenario('withdraw', 2);
      const [a, b] = s.bound as [Who, Who];
      const pending = await propose(s, a);
      await call(s, b, 'post', `/${pending.id}/approve`).expect(200);
      const denied = await call(s, b, 'post', `/${pending.id}/withdraw`).expect(403);
      expect(denied.body.code).toBe('FINANCE_RULES_NOT_PROPOSER');
      const back = (await call(s, a, 'post', `/${pending.id}/withdraw`).expect(200)).body;
      expect(back).toMatchObject({ id: pending.id, status: 'borrador', submittedAt: null, approvals: [] });
      const view = await overview(s, a);
      expect(view.state).toBe('sin_aprobar');
      expect(view.draft.id).toBe(pending.id);
      await call(s, b, 'post', `/${pending.id}/approve`).expect(409);
    });

    it('cannot withdraw rules that are already in force', async () => {
      const s = await scenario('withdraw-late', 1);
      const pending = await propose(s, s.bound[0]!);
      await call(s, s.bound[0]!, 'post', `/${pending.id}/approve`).expect(200);
      await call(s, s.bound[0]!, 'post', `/${pending.id}/withdraw`).expect(409);
    });
  });

  describe('reminders', () => {
    it('reaches only who is missing, by email and in the app, at most once every 24 hours', async () => {
      const s = await scenario('remind', 3);
      const [a, b, c] = s.bound as [Who, Who, Who];
      const pending = await propose(s, a);
      await call(s, b, 'post', `/${pending.id}/approve`).expect(200);

      const first = (await call(s, a, 'post', `/${pending.id}/remind`).expect(200)).body;
      expect(first.reminded.map((r: { memberId: string }) => r.memberId).sort()).toEqual(
        [a.memberId, c.memberId].sort(),
      );
      expect(first.reminded.every((r: { emailSent: boolean }) => r.emailSent)).toBe(true);
      expect(sendReminder).toHaveBeenCalledTimes(2);
      expect(sendReminder.mock.calls.map((x) => x[0].proposerName)).toEqual(['Socio 0', 'Socio 0']);

      const second = (await call(s, a, 'post', `/${pending.id}/remind`).expect(200)).body;
      expect(second.reminded).toEqual([]);
      expect(second.skipped).toHaveLength(2);
      expect(sendReminder).toHaveBeenCalledTimes(2);

      const noticed = await overview(s, c);
      expect(noticed.me.reminderReceivedAt).toEqual(expect.any(String));
      expect((await overview(s, b)).me.reminderReceivedAt).toBeNull();
    });

    it('after 24 hours a partner can be reminded again; never before', async () => {
      const s = await scenario('remind-clock', 2);
      const [a] = s.bound as [Who, Who];
      const pending = await propose(s, a);
      await call(s, a, 'post', `/${pending.id}/remind`).expect(200);
      await withTestTenant(s.contextId, () =>
        prisma.financeRuleReminder.updateMany({
          where: { ruleSetId: pending.id },
          data: { sentAt: new Date(Date.now() - 23 * 3600_000 - 59 * 60_000) },
        }),
      );
      expect((await call(s, a, 'post', `/${pending.id}/remind`).expect(200)).body.reminded).toEqual([]);
      await withTestTenant(s.contextId, () =>
        prisma.financeRuleReminder.updateMany({
          where: { ruleSetId: pending.id },
          data: { sentAt: new Date(Date.now() - 24 * 3600_000 - 1000) },
        }),
      );
      expect((await call(s, a, 'post', `/${pending.id}/remind`).expect(200)).body.reminded).toHaveLength(2);
    });

    it('simultaneous reminders send one email per partner', async () => {
      const s = await scenario('remind-race', 2);
      const [a] = s.bound as [Who, Who];
      const pending = await propose(s, a);
      await Promise.all([
        call(s, a, 'post', `/${pending.id}/remind`),
        call(s, a, 'post', `/${pending.id}/remind`),
        call(s, a, 'post', `/${pending.id}/remind`),
      ]);
      expect(sendReminder).toHaveBeenCalledTimes(2);
    });

    it('a failed email does not lose the in-app reminder', async () => {
      const s = await scenario('remind-fail', 2);
      const [a, b] = s.bound as [Who, Who];
      const pending = await propose(s, a);
      sendReminder.mockRejectedValueOnce(new Error('resend down'));
      const res = (await call(s, a, 'post', `/${pending.id}/remind`).expect(200)).body;
      expect(res.reminded).toHaveLength(2);
      expect(res.reminded.filter((r: { emailSent: boolean }) => !r.emailSent)).toHaveLength(1);
      expect((await overview(s, b)).me.reminderReceivedAt).toEqual(expect.any(String));
    });

    it('only the proposer reminds, and only while pending', async () => {
      const s = await scenario('remind-who', 2);
      const [a, b] = s.bound as [Who, Who];
      const pending = await propose(s, a);
      await call(s, b, 'post', `/${pending.id}/remind`).expect(403);
      await call(s, a, 'post', `/${pending.id}/approve`).expect(200);
      await call(s, b, 'post', `/${pending.id}/approve`).expect(200);
      await call(s, a, 'post', `/${pending.id}/remind`).expect(409);
    });
  });

  describe('isolation between businesses', () => {
    it('another business never sees or touches these rules', async () => {
      const s = await scenario('iso-a', 1);
      const t = await scenario('iso-b', 1);
      const pending = await propose(s, s.bound[0]!);
      expect((await overview(t, t.bound[0]!)).history).toEqual([]);
      await call(t, t.bound[0]!, 'post', `/${pending.id}/approve`).expect(404);
      await call(t, t.bound[0]!, 'post', `/${pending.id}/withdraw`).expect(404);
      await call(t, t.bound[0]!, 'post', `/${pending.id}/remind`).expect(404);
      expect((await overview(s, s.bound[0]!)).pending.approvals).toEqual([]);
    });

    it('versions are numbered per business', async () => {
      const s = await scenario('ver-a', 1);
      const t = await scenario('ver-b', 1);
      const one = (await call(s, s.bound[0]!, 'put', '/draft', { config: config() }).expect(200)).body;
      const other = (await call(t, t.bound[0]!, 'put', '/draft', { config: config() }).expect(200)).body;
      expect([one.version, other.version]).toEqual([1, 1]);
    });
  });
});

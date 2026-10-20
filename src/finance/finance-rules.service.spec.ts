import { describe, expect, it, vi } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  FinanceRulesService,
  REMINDER_COOLDOWN_MS,
  SHARED_LOGIN_MESSAGE,
} from './finance-rules.service.js';
import { FinanceRulesController } from './finance-rules.controller.js';
import { RULES_SCHEMA_VERSION } from './finance-rules.config.js';

/**
 * Unit tests of the rules service against a small in-memory stand-in for
 * Prisma. The database guards (triggers, unique indexes, RLS) and real
 * concurrency are covered by test/finance-rules.e2e-spec.ts.
 */
type Row = Record<string, any>;
const CONTEXT = 'ctx-1';

const match = (row: Row, where: Row = {}): boolean =>
  Object.entries(where).every(([key, expected]) => {
    if (expected && typeof expected === 'object' && 'in' in expected)
      return (expected.in as unknown[]).includes(row[key]);
    return row[key] === expected;
  });

function table(rows: Row[]) {
  const sorted = (list: Row[], orderBy?: Row | Row[]) => {
    const [first] = ([] as Row[]).concat(orderBy ?? []);
    if (!first) return list;
    const [key, dir] = Object.entries(first)[0] as [string, string];
    const factor = dir === 'desc' ? -1 : 1;
    return [...list].sort((a, b) => (a[key] > b[key] ? factor : a[key] < b[key] ? -factor : 0));
  };
  return {
    rows,
    findMany: async ({ where, orderBy, take }: Row = {}) =>
      sorted(rows.filter((r) => match(r, where)), orderBy).slice(0, take ?? rows.length),
    findFirst: async ({ where, orderBy }: Row = {}) =>
      sorted(rows.filter((r) => match(r, where)), orderBy)[0] ?? null,
    create: async ({ data }: Row) => {
      const row = { createdAt: new Date(), approvedAt: new Date(), ...data };
      rows.push(row);
      return row;
    },
    update: async ({ where, data }: Row) => {
      const row = rows.find((r) => match(r, where))!;
      Object.assign(row, data);
      return row;
    },
    updateMany: async ({ where, data }: Row) => {
      const hit = rows.filter((r) => match(r, where));
      hit.forEach((r) => Object.assign(r, data));
      return { count: hit.length };
    },
    deleteMany: async ({ where }: Row) => {
      const keep = rows.filter((r) => !match(r, where));
      const count = rows.length - keep.length;
      rows.splice(0, rows.length, ...keep);
      return { count };
    },
  };
}

function setup(opts: { partners?: Row[]; accounts?: Row[]; email?: ReturnType<typeof vi.fn> } = {}) {
  const members = table(
    opts.partners ?? [
      { id: 'ana', name: 'Ana', role: 'socio', active: true, contextId: CONTEXT, createdAt: 1 },
      { id: 'beto', name: 'Beto', role: 'socio', active: true, contextId: CONTEXT, createdAt: 2 },
    ],
  );
  const sets = table([]);
  const approvals = table([]);
  const reminders = table([]);
  const accounts = table(
    opts.accounts ?? [
      { id: 'acc-ana', memberId: 'ana', username: 'ana@example.test', active: true, contextId: CONTEXT },
      { id: 'acc-beto', memberId: 'beto', username: 'beto-sin-correo', active: true, contextId: CONTEXT },
    ],
  );
  const raw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('?');
    if (sql.includes('MAX("version")'))
      return [{ next: Math.max(0, ...sets.rows.map((r) => r.version)) + 1 }];
    if (sql.includes('FOR UPDATE'))
      return sets.rows.filter((r) => r.id === values[0] && r.contextId === values[1]);
    if (sql.includes('nombreNegocio')) return [{ name: 'Bazar Sol' }];
    return [];
  };
  const prisma: Row = {
    member: members,
    financeRuleSet: sets,
    financeRuleApproval: approvals,
    financeRuleReminder: reminders,
    account: accounts,
    $queryRaw: raw,
    $executeRaw: async () => 1,
    $transaction: async (fn: (tx: Row) => unknown) => fn(prisma),
  };
  const email = opts.email ?? vi.fn().mockResolvedValue(undefined);
  const service = new FinanceRulesService(prisma as never, { sendFinanceRulesReminderEmail: email } as never);
  return { service, members, sets, approvals, reminders, email };
}

const actor = (memberId: string, boundTo: string | null = memberId) =>
  ({
    account: { id: `acc-${memberId}`, contextId: CONTEXT, memberId: boundTo },
    selection: { memberId, deviceId: 'dev' },
  }) as never;

const config = (reserve = 10) => ({
  schemaVersion: RULES_SCHEMA_VERSION,
  profitBase: { partnerPct: 50, capitalPct: 30, workPct: 20 },
  reinvestment: { currentPhase: 'operacion', arranquePct: 100, operacionPct: 50, cierrePct: 0, untilAmountMinor: null },
  capitalRecovery: { mode: 'por_diferencia', timing: 'durante' },
  work: { payHours: false, order: 'antes', pay: { kind: 'por_hora', rateMinorPerHour: 5000 } },
  partnerExpenses: 'reembolsar',
  reserves: { kind: 'porcentaje', pct: reserve },
  partnerLoans: { repayBeforeCapital: true },
});

const propose = async (s: ReturnType<typeof setup>, who = 'ana') => {
  const draft = await s.service.saveDraft(actor(who), config());
  return s.service.submit(actor(who), draft.id);
};

describe('FinanceRulesService', () => {
  describe('overview', () => {
    it('sin reglas: sin aprobar, sin versiones, con el aviso legal', async () => {
      const { service } = setup();
      const view = await service.overview(actor('ana'));
      expect(view).toMatchObject({ state: 'sin_aprobar', inForce: null, pending: null, draft: null, history: [] });
      expect(view.partners.map((p) => p.name)).toEqual(['Ana', 'Beto']);
      expect(view.disclaimer).toContain('No es asesoría contable ni legal');
      expect(view.me).toMatchObject({ memberId: 'ana', canApprove: true, isProposer: false, hasApproved: false });
    });

    it('pendiente: nombra a quien falta y distingue al proponente', async () => {
      const s = setup();
      await propose(s);
      await s.service.approve(actor('beto'), s.sets.rows[0]!.id);
      const view = await s.service.overview(actor('ana'));
      expect(view.state).toBe('pendiente');
      expect(view.pending!.missing.map((m) => m.name)).toEqual(['Ana']);
      expect(view.pending!.approvals.map((a) => a.name)).toEqual(['Beto']);
      expect(view.me.isProposer).toBe(true);
      expect((await s.service.overview(actor('beto'))).me).toMatchObject({ hasApproved: true, isProposer: false });
    });

    it('vigente: separa lo vigente del historial y no mezcla el borrador', async () => {
      const s = setup({ partners: [{ id: 'ana', name: 'Ana', role: 'socio', active: true, contextId: CONTEXT, createdAt: 1 }] });
      const pending = await propose(s);
      await s.service.approve(actor('ana'), pending.id);
      await s.service.saveDraft(actor('ana'), config(20));
      const view = await s.service.overview(actor('ana'));
      expect(view.state).toBe('vigente');
      expect(view.inForce!.version).toBe(1);
      expect(view.draft!.version).toBe(2);
      expect(view.history.map((h) => h.status)).toEqual(['vigente']);
    });

    it('un acceso compartido con varios socios ve por qué no puede aprobar', async () => {
      const s = setup();
      await propose(s);
      const view = await s.service.overview(actor('beto', null));
      expect(view.me).toMatchObject({ canApprove: false, cannotApproveReason: SHARED_LOGIN_MESSAGE });
    });

    it('quien no es socio activo no puede aprobar', async () => {
      const { service } = setup();
      const view = await service.overview(actor('intruso'));
      expect(view.me).toMatchObject({ canApprove: false, cannotApproveReason: 'Solo los socios activos pueden aprobar.' });
    });
  });

  describe('borrador', () => {
    it('rechaza reglas inválidas con todos los problemas y en español', async () => {
      const { service, sets } = setup();
      const bad = { ...config(), partnerExpenses: 'nunca', profitBase: { partnerPct: 1, capitalPct: 1, workPct: 1 } };
      const error = await service.saveDraft(actor('ana'), bad).catch((e) => e);
      expect(error).toBeInstanceOf(BadRequestException);
      expect(error.getResponse()).toMatchObject({ code: 'FINANCE_RULES_INVALID' });
      expect(error.getResponse().message).toContain('deben sumar 100');
      expect(error.getResponse().message).toContain('partnerExpenses');
      expect(sets.rows).toHaveLength(0);
    });

    it('crea la versión 1 y luego edita el mismo borrador', async () => {
      const { service, sets } = setup();
      const first = await service.saveDraft(actor('ana'), config(10));
      const second = await service.saveDraft(actor('ana'), config(80));
      expect(first).toMatchObject({ version: 1, status: 'borrador' });
      expect(second.id).toBe(first.id);
      expect(second.config.reserves).toEqual({ kind: 'porcentaje', pct: 80 });
      expect(second.configHash).not.toBe(first.configHash);
      expect(second.warnings.map((w) => w.code)).toContain('RESERVES_HIGH');
      expect(sets.rows).toHaveLength(1);
    });

    it('otro socio no puede tomar el borrador abierto', async () => {
      const { service } = setup();
      await service.saveDraft(actor('ana'), config());
      await expect(service.saveDraft(actor('beto'), config())).rejects.toMatchObject({
        response: { code: 'FINANCE_RULES_DRAFT_OWNED' },
      });
    });

    it('descartar lo deja retirado y la siguiente versión es la 2', async () => {
      const { service } = setup();
      const draft = await service.saveDraft(actor('ana'), config());
      expect((await service.discardDraft(actor('ana'), draft.id)).status).toBe('retirada');
      expect((await service.saveDraft(actor('ana'), config())).version).toBe(2);
    });

    it('solo se descarta un borrador y solo lo hace su dueño', async () => {
      const s = setup();
      const draft = await s.service.saveDraft(actor('ana'), config());
      await expect(s.service.discardDraft(actor('beto'), draft.id)).rejects.toMatchObject({
        response: { code: 'FINANCE_RULES_NOT_PROPOSER' },
      });
      const pending = await s.service.submit(actor('ana'), draft.id);
      await expect(s.service.discardDraft(actor('ana'), pending.id)).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('enviar', () => {
    it('congela el borrador como pendiente, con fecha de envío', async () => {
      const s = setup();
      const pending = await propose(s);
      expect(pending).toMatchObject({ status: 'pendiente', missing: expect.any(Array) });
      expect(pending.submittedAt).toEqual(expect.any(String));
      expect(pending.missing).toHaveLength(2);
    });

    it('solo el proponente envía, y no puede haber dos propuestas pendientes', async () => {
      const s = setup();
      const draft = await s.service.saveDraft(actor('ana'), config());
      await expect(s.service.submit(actor('beto'), draft.id)).rejects.toBeInstanceOf(ForbiddenException);
      await s.service.submit(actor('ana'), draft.id);
      const other = await s.service.saveDraft(actor('ana'), config(20));
      await expect(s.service.submit(actor('ana'), other.id)).rejects.toMatchObject({
        response: { code: 'FINANCE_RULES_PENDING_EXISTS' },
      });
    });

    it('una propuesta que no existe es un 404', async () => {
      const { service } = setup();
      await expect(service.submit(actor('ana'), 'nada')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('retirar', () => {
    it('vuelve a borrador y borra las aprobaciones', async () => {
      const s = setup();
      const pending = await propose(s);
      await s.service.approve(actor('beto'), pending.id);
      const back = await s.service.withdraw(actor('ana'), pending.id);
      expect(back).toMatchObject({ status: 'borrador', submittedAt: null, approvals: [] });
      expect(s.approvals.rows).toHaveLength(0);
    });

    it('solo el proponente, solo si está pendiente y sin otro borrador abierto', async () => {
      const s = setup();
      const pending = await propose(s);
      await expect(s.service.withdraw(actor('beto'), pending.id)).rejects.toBeInstanceOf(ForbiddenException);
      await s.service.saveDraft(actor('ana'), config(30));
      await expect(s.service.withdraw(actor('ana'), pending.id)).rejects.toMatchObject({
        response: { code: 'FINANCE_RULES_DRAFT_EXISTS' },
      });
      const draft = s.sets.rows.find((r) => r.status === 'borrador')!;
      await expect(s.service.withdraw(actor('ana'), draft.id)).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('aprobar', () => {
    it('un solo socio aprueba y queda vigente al instante', async () => {
      const s = setup({ partners: [{ id: 'ana', name: 'Ana', role: 'socio', active: true, contextId: CONTEXT, createdAt: 1 }] });
      const pending = await propose(s);
      const done = await s.service.approve(actor('ana'), pending.id);
      expect(done.status).toBe('vigente');
      expect(done.activatedAt).toEqual(expect.any(String));
    });

    it('un acceso compartido aprueba solo si es el único socio', async () => {
      const solo = setup({ partners: [{ id: 'ana', name: 'Ana', role: 'socio', active: true, contextId: CONTEXT, createdAt: 1 }] });
      const pending = await propose(solo);
      expect((await solo.service.approve(actor('ana', null), pending.id)).status).toBe('vigente');

      const many = setup();
      const other = await propose(many);
      const error = await many.service.approve(actor('beto', null), other.id).catch((e) => e);
      expect(error).toBeInstanceOf(ForbiddenException);
      expect(error.getResponse()).toEqual({ code: 'FINANCE_RULES_SHARED_LOGIN', message: SHARED_LOGIN_MESSAGE });
      expect(many.approvals.rows).toHaveLength(0);
    });

    it('activa con la última aprobación y reemplaza la vigente anterior', async () => {
      const s = setup();
      const v1 = await propose(s);
      await s.service.approve(actor('ana'), v1.id);
      expect((await s.service.approve(actor('beto'), v1.id)).status).toBe('vigente');
      const v2 = await propose(s, 'beto');
      await s.service.approve(actor('ana'), v2.id);
      expect(s.sets.rows.find((r) => r.id === v1.id)!.status).toBe('vigente');
      await s.service.approve(actor('beto'), v2.id);
      expect(s.sets.rows.map((r) => [r.version, r.status])).toEqual([[1, 'reemplazada'], [2, 'vigente']]);
      expect(s.sets.rows[0]!.supersededAt).toBeInstanceOf(Date);
    });

    it('aprobar dos veces no duplica ni da error; repetir tras la activación tampoco', async () => {
      const s = setup();
      const pending = await propose(s);
      await s.service.approve(actor('ana'), pending.id);
      const again = await s.service.approve(actor('ana'), pending.id);
      expect(again.approvals).toHaveLength(1);
      await s.service.approve(actor('beto'), pending.id);
      expect((await s.service.approve(actor('beto'), pending.id)).status).toBe('vigente');
      expect(s.approvals.rows).toHaveLength(2);
    });

    it('guarda el hash exacto que se aprobó', async () => {
      const s = setup();
      const pending = await propose(s);
      await s.service.approve(actor('ana'), pending.id);
      expect(s.approvals.rows[0]).toMatchObject({ approvedHash: pending.configHash, memberId: 'ana' });
    });

    it('un socio dado de baja deja de contar al repetir la aprobación', async () => {
      const s = setup({
        partners: [
          { id: 'ana', name: 'Ana', role: 'socio', active: true, contextId: CONTEXT, createdAt: 1 },
          { id: 'beto', name: 'Beto', role: 'socio', active: true, contextId: CONTEXT, createdAt: 2 },
        ],
      });
      const pending = await propose(s);
      await s.service.approve(actor('ana'), pending.id);
      s.members.rows.find((m) => m.id === 'beto')!.active = false;
      expect((await s.service.approve(actor('ana'), pending.id)).status).toBe('vigente');
    });

    it('no aprueba a quien no es socio activo, ni una propuesta que ya no espera', async () => {
      const s = setup();
      const pending = await propose(s);
      await expect(s.service.approve(actor('intruso'), pending.id)).rejects.toBeInstanceOf(ForbiddenException);
      const draft = await s.service.saveDraft(actor('ana'), config(40));
      await expect(s.service.approve(actor('ana'), draft.id)).rejects.toMatchObject({
        response: { code: 'FINANCE_RULES_WRONG_STATE' },
      });
    });
  });

  describe('recordar', () => {
    const NOW = new Date('2026-10-20T12:00:00Z');

    it('avisa a quien falta: por correo si su usuario es un correo, y siempre en la app', async () => {
      const s = setup();
      const pending = await propose(s);
      const result = await s.service.remind(actor('ana'), pending.id, NOW);
      expect(result.reminded).toEqual([
        { memberId: 'ana', name: 'Ana', emailSent: true },
        { memberId: 'beto', name: 'Beto', emailSent: false },
      ]);
      expect(s.email).toHaveBeenCalledTimes(1);
      expect(s.email).toHaveBeenCalledWith({
        to: 'ana@example.test', memberName: 'Ana', proposerName: 'Ana', businessName: 'Bazar Sol',
      });
      expect(s.reminders.rows).toHaveLength(2);
      expect(s.reminders.rows.find((r) => r.memberId === 'ana')!.emailSent).toBe(true);
    });

    it('no avisa a quien ya aprobó', async () => {
      const s = setup();
      const pending = await propose(s);
      await s.service.approve(actor('beto'), pending.id);
      const result = await s.service.remind(actor('ana'), pending.id, NOW);
      expect(result.reminded.map((r) => r.memberId)).toEqual(['ana']);
    });

    it('máximo una vez cada 24 horas por socio', async () => {
      const s = setup();
      const pending = await propose(s);
      await s.service.remind(actor('ana'), pending.id, NOW);
      const soon = new Date(NOW.getTime() + REMINDER_COOLDOWN_MS - 1000);
      const early = await s.service.remind(actor('ana'), pending.id, soon);
      expect(early.reminded).toEqual([]);
      expect(early.skipped.map((x) => x.memberId)).toEqual(['ana', 'beto']);
      expect(early.skipped[0]!.nextAt).toBe(new Date(NOW.getTime() + REMINDER_COOLDOWN_MS).toISOString());
      const later = new Date(NOW.getTime() + REMINDER_COOLDOWN_MS);
      expect((await s.service.remind(actor('ana'), pending.id, later)).reminded).toHaveLength(2);
    });

    it('si el correo falla, el aviso en la app queda y se sigue con los demás', async () => {
      const email = vi.fn().mockRejectedValue(new Error('resend down'));
      const s = setup({
        email,
        accounts: [
          { id: 'a1', memberId: 'ana', username: 'ana@example.test', active: true, contextId: CONTEXT },
          { id: 'a2', memberId: 'beto', username: 'beto@example.test', active: true, contextId: CONTEXT },
        ],
      });
      const pending = await propose(s);
      const result = await s.service.remind(actor('ana'), pending.id, NOW);
      expect(email).toHaveBeenCalledTimes(2);
      expect(result.reminded.every((r) => !r.emailSent)).toBe(true);
      expect(s.reminders.rows).toHaveLength(2);
    });

    it('solo el proponente, y solo si está pendiente', async () => {
      const s = setup();
      const pending = await propose(s);
      await expect(s.service.remind(actor('beto'), pending.id, NOW)).rejects.toBeInstanceOf(ForbiddenException);
      const draft = await s.service.saveDraft(actor('ana'), config(5));
      await expect(s.service.remind(actor('ana'), draft.id, NOW)).rejects.toBeInstanceOf(ConflictException);
    });
  });
});

describe('FinanceRulesController', () => {
  it('cada ruta pasa la petición y el id al servicio', async () => {
    const calls: unknown[][] = [];
    const record = (name: string) => async (...args: unknown[]) => {
      calls.push([name, ...args]);
      return name;
    };
    const service = {
      overview: record('overview'), saveDraft: record('saveDraft'), discardDraft: record('discardDraft'),
      submit: record('submit'), withdraw: record('withdraw'), approve: record('approve'), remind: record('remind'),
    };
    const controller = new FinanceRulesController(service as never);
    const req = { account: {}, selection: {} } as never;
    const id = 'id-1';

    expect(await controller.overview(req)).toBe('overview');
    expect(await controller.saveDraft(req, { config: { a: 1 } })).toBe('saveDraft');
    expect(await controller.discard(req, id)).toBe('discardDraft');
    expect(await controller.submit(req, id)).toBe('submit');
    expect(await controller.withdraw(req, id)).toBe('withdraw');
    expect(await controller.approve(req, id)).toBe('approve');
    expect(await controller.remind(req, id)).toBe('remind');
    expect(calls).toEqual([
      ['overview', req], ['saveDraft', req, { a: 1 }], ['discardDraft', req, id], ['submit', req, id],
      ['withdraw', req, id], ['approve', req, id], ['remind', req, id],
    ]);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { FinanceRulesService, listNames } from './finance-rules.service.js';
import { FinanceRuleLinksService, RESEND_COOLDOWN_MS } from './finance-rule-links.service.js';
import { FinanceRulesController } from './finance-rules.controller.js';
import { RULES_SCHEMA_VERSION } from './finance-rules.config.js';
import { table, type Row } from '../../test/support/memory-table.js';

/**
 * Unit tests of the rules service against a small in-memory stand-in for Prisma. The database
 * guards (triggers, unique indexes, RLS), the SQL functions that record an answer, and real
 * concurrency are covered by test/finance-rules.e2e-spec.ts.
 */
const CONTEXT = 'ctx-1';
const HOUR = 3600_000;

const partner = (id: string, name: string, createdAt: number, correo: string | null = `${id}@example.test`): Row => ({
  id,
  name,
  correo,
  role: 'socio',
  active: true,
  contextId: CONTEXT,
  createdAt,
});

function setup(opts: { partners?: Row[]; settled?: boolean; sendApproval?: ReturnType<typeof vi.fn> } = {}) {
  const members = table(opts.partners ?? [partner('ana', 'Ana', 1), partner('beto', 'Beto', 2)]);
  const sets = table([]);
  const approvals = table([]);
  const objections = table([]);
  const links = table([]);
  // The column defaults to false in the database; the stand-in must do the same.
  const createLink = links.create;
  links.create = ({ data }: Row) => createLink({ data: { emailSent: false, ...data } });
  const confirmations = table([]);
  const raw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('?');
    if (sql.includes('finance_rule_set_settle')) return [{ settled: opts.settled ?? false }];
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
    financeRuleObjection: objections,
    financeRuleLink: links,
    memberEmailConfirmation: confirmations,
    $queryRaw: raw,
    $executeRaw: async () => 1,
    $transaction: async (fn: (tx: Row) => unknown) => fn(prisma),
  };
  const sendApproval = opts.sendApproval ?? vi.fn().mockResolvedValue(undefined);
  const linksService = new FinanceRuleLinksService(prisma as never, { sendFinanceRulesApprovalEmail: sendApproval } as never);
  const service = new FinanceRulesService(prisma as never, linksService);
  return { service, members, sets, approvals, objections, links, confirmations, sendApproval };
}
type Env = ReturnType<typeof setup>;

const actor = (memberId: string) =>
  ({
    account: { id: `acc-${memberId}`, contextId: CONTEXT, memberId },
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

const propose = async (s: Env, who = 'ana', reserve = 10) => {
  const draft = await s.service.saveDraft(actor(who), config(reserve));
  return s.service.submit(actor(who), draft.id);
};
/** Marks a partner's answer the way the SQL function would. */
const approve = (s: Env, setId: string, memberId: string) =>
  s.approvals.rows.push({ id: `ap-${memberId}`, contextId: CONTEXT, ruleSetId: setId, memberId, correo: `${memberId}@example.test`, linkId: 'l', approvedAt: new Date() });
const object = (s: Env, setId: string, memberId: string, reason = 'No') => {
  s.objections.rows.push({ id: `ob-${memberId}`, contextId: CONTEXT, ruleSetId: setId, memberId, correo: `${memberId}@example.test`, reason, createdAt: new Date() });
  s.sets.rows.find((r) => r.id === setId)!.status = 'en_revision';
};

beforeEach(() => {
  vi.stubEnv('PUBLIC_SITE_URL', 'https://site.test');
});
afterEach(() => vi.unstubAllEnvs());

describe('FinanceRulesService', () => {
  describe('overview', () => {
    it('sin reglas: sin aprobar, sin versiones, con el aviso legal y mi correo enmascarado', async () => {
      const { service } = setup();
      const view = await service.overview(actor('ana'));
      expect(view).toMatchObject({ state: 'sin_aprobar', inForce: null, proposal: null, draft: null, history: [] });
      expect(view.partners.map((p) => [p.name, p.hasCorreo, p.correo, p.response, p.link])).toEqual([
        ['Ana', true, 'a***@e***.test', null, null],
        ['Beto', true, 'b***@e***.test', null, null],
      ]);
      expect(view.disclaimer).toContain('No es asesoría contable ni legal');
      expect(view.me).toEqual({ memberId: 'ana', correo: 'a***@e***.test', hasCorreo: true, pendingCorreo: null });
    });

    it('quien no tiene correo se ve sin correo, y un correo por confirmar se ve enmascarado', async () => {
      const s = setup({ partners: [partner('ana', 'Ana', 1, null)] });
      const now = new Date('2026-10-21T12:00:00Z');
      s.confirmations.rows.push({ contextId: CONTEXT, memberId: 'ana', correo: 'nueva@example.test', usedAt: null, supersededAt: null, expiresAt: new Date(now.getTime() + HOUR), createdAt: now });
      s.confirmations.rows.push({ contextId: CONTEXT, memberId: 'ana', correo: 'vieja@example.test', usedAt: null, supersededAt: null, expiresAt: new Date(now.getTime() - HOUR), createdAt: now });
      const view = await s.service.overview(actor('ana'), now);
      expect(view.me).toMatchObject({ correo: null, hasCorreo: false, pendingCorreo: { correo: 'n***@e***.test' } });
      expect(view.partners[0]).toMatchObject({ hasCorreo: false, correo: null });
    });

    it('pendiente: dice quién falta, quién respondió, y cuándo se puede reenviar', async () => {
      const s = setup();
      const sent = await propose(s);
      approve(s, sent.id, 'beto');
      const view = await s.service.overview(actor('ana'));
      expect(view.state).toBe('pendiente');
      expect(view.proposal!.missing.map((m) => m.name)).toEqual(['Ana']);
      expect(view.proposal!.approvals.map((a) => [a.name, a.via, a.correo])).toEqual([['Beto', 'correo', 'b***@e***.test']]);
      expect(view.partners.map((p) => p.response)).toEqual([null, 'aprobo']);
      expect(view.partners[0]!.link).toMatchObject({ expired: false, canResendAt: null });
    });

    it('en revisión: muestra las objeciones con el correo enmascarado', async () => {
      const s = setup();
      const sent = await propose(s);
      object(s, sent.id, 'beto', 'Más reservas');
      const view = await s.service.overview(actor('ana'));
      expect(view.state).toBe('en_revision');
      expect(view.proposal!.objections).toEqual([
        { memberId: 'beto', name: 'Beto', correo: 'b***@e***.test', reason: 'Más reservas', createdAt: expect.any(String) },
      ]);
      expect(view.partners.map((p) => p.response)).toEqual([null, 'objeto']);
    });

    it('vigente: separa lo vigente del historial y no mezcla el borrador', async () => {
      const s = setup({ partners: [partner('ana', 'Ana', 1)] });
      const sent = await propose(s);
      s.sets.rows[0]!.status = 'vigente';
      approve(s, sent.id, 'ana');
      await s.service.saveDraft(actor('ana'), config(20));
      const view = await s.service.overview(actor('ana'));
      expect(view.state).toBe('vigente');
      expect(view.inForce!.version).toBe(1);
      expect(view.draft!.version).toBe(2);
      expect(view.history.map((h) => h.status)).toEqual(['vigente']);
    });

    it('una aprobación hecha antes (desde una sesión) se muestra sin correo y con su vía', async () => {
      const s = setup({ partners: [partner('ana', 'Ana', 1)] });
      const sent = await propose(s);
      s.approvals.rows.push({ id: 'old', contextId: CONTEXT, ruleSetId: sent.id, memberId: 'ana', approvedAt: new Date(), correo: null, linkId: null });
      const view = await s.service.overview(actor('ana'));
      expect(view.proposal!.approvals).toEqual([expect.objectContaining({ via: 'sesion', correo: null })]);
    });

    it('un enlace vencido se marca, y el reenvío reciente deja la fecha en que se podrá repetir', async () => {
      const s = setup();
      const now = new Date('2026-10-21T12:00:00Z');
      await s.service.submit(actor('ana'), (await s.service.saveDraft(actor('ana'), config())).id, new Date(now.getTime() - 8 * 24 * HOUR));
      await s.service.resend(actor('beto'), s.sets.rows[0]!.id, new Date(now.getTime() - HOUR));
      const view = await s.service.overview(actor('ana'), now);
      expect(view.partners[0]!.link).toMatchObject({ expired: false, canResendAt: new Date(now.getTime() - HOUR + RESEND_COOLDOWN_MS).toISOString() });
    });
  });

  describe('borrador', () => {
    it('rechaza reglas inválidas con todos los problemas y en español', async () => {
      const { service, sets } = setup();
      const bad = { ...config(), partnerExpenses: 'nunca', profitBase: { partnerPct: 1, capitalPct: 1, workPct: 1 } };
      await expect(service.saveDraft(actor('ana'), bad)).rejects.toMatchObject({
        response: { code: 'FINANCE_RULES_INVALID', message: expect.stringContaining('deben sumar 100') },
      });
      await expect(service.saveDraft(actor('ana'), bad)).rejects.toBeInstanceOf(BadRequestException);
      expect(sets.rows).toEqual([]);
    });

    it('crea la versión 1 y luego edita el mismo borrador', async () => {
      const { service, sets } = setup();
      const first = await service.saveDraft(actor('ana'), config(10));
      const second = await service.saveDraft(actor('ana'), config(80));
      expect(second.id).toBe(first.id);
      expect(sets.rows).toHaveLength(1);
      expect(second).toMatchObject({ version: 1, status: 'borrador', basedOn: null, changes: null });
      expect(second.warnings.map((w) => w.code)).toContain('RESERVES_HIGH');
    });

    it('otro socio no puede tomar el borrador abierto', async () => {
      const { service } = setup();
      await service.saveDraft(actor('ana'), config());
      await expect(service.saveDraft(actor('beto'), config())).rejects.toMatchObject({
        response: { code: 'FINANCE_RULES_DRAFT_OWNED' },
      });
    });
  });

  describe('descartar', () => {
    it('cualquier socio descarta un borrador: queda descartada, con quién y cuándo, y la siguiente versión es la 2', async () => {
      const { service, sets } = setup();
      const draft = await service.saveDraft(actor('ana'), config());
      const view = await service.discard(actor('beto'), draft.id);
      expect(view).toMatchObject({ status: 'descartada', closedNote: 'Descartada por Beto.', discardedAt: expect.any(String) });
      expect(sets.rows[0]!.status).toBe('descartada');
      expect((await service.saveDraft(actor('ana'), config())).version).toBe(2);
    });

    it('descarta una propuesta pendiente o en revisión y mata sus enlaces', async () => {
      const s = setup();
      const sent = await propose(s);
      await s.service.discard(actor('beto'), sent.id);
      expect(s.sets.rows[0]!.status).toBe('descartada');
      expect(s.links.rows.every((l) => l.supersededAt)).toBe(true);

      const again = await propose(s, 'ana', 30);
      object(s, again.id, 'beto');
      await s.service.discard(actor('ana'), again.id);
      expect(s.sets.rows[1]!.status).toBe('descartada');
    });

    it('no descarta lo vigente ni una propuesta que no existe', async () => {
      const s = setup({ partners: [partner('ana', 'Ana', 1)] });
      const sent = await propose(s);
      s.sets.rows[0]!.status = 'vigente';
      await expect(s.service.discard(actor('ana'), sent.id)).rejects.toMatchObject({ response: { code: 'FINANCE_RULES_WRONG_STATE' } });
      await expect(s.service.discard(actor('ana'), 'nada')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('enviar', () => {
    it('congela el borrador como pendiente y manda a CADA socio su propio enlace', async () => {
      const s = setup();
      const sent = await propose(s);
      expect(sent).toMatchObject({ status: 'pendiente', submittedAt: expect.any(String), emails: { sent: ['Ana', 'Beto'], failed: [] } });
      expect(s.links.rows.map((l) => [l.memberId, l.correo, l.kind, l.emailSent])).toEqual([
        ['ana', 'ana@example.test', 'envio', true],
        ['beto', 'beto@example.test', 'envio', true],
      ]);
      expect(new Set(s.links.rows.map((l) => l.tokenHash)).size).toBe(2);
      expect(s.links.rows.every((l) => l.expiresAt.getTime() - l.createdAt.getTime() === 7 * 24 * HOUR)).toBe(true);
      expect(s.sendApproval).toHaveBeenCalledTimes(2);
      expect(s.sendApproval.mock.calls[0]![0]).toMatchObject({
        to: 'ana@example.test',
        proposerName: 'Ana',
        businessName: 'Bazar Sol',
        version: 1,
        expiresInDays: 7,
        changes: null,
        reviewUrl: expect.stringMatching(/^https:\/\/site\.test\/acuerdo\/[A-Za-z0-9_-]{43}$/),
      });
    });

    it('no envía mientras a un socio le falta el correo, y dice a quién', async () => {
      const s = setup({ partners: [partner('ana', 'Ana', 1), partner('beto', 'Beto', 2, null), partner('carla', 'Carla', 3, null)] });
      const draft = await s.service.saveDraft(actor('ana'), config());
      const error = await s.service.submit(actor('ana'), draft.id).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UnprocessableEntityException);
      expect((error as UnprocessableEntityException).getResponse()).toMatchObject({
        code: 'FINANCE_RULES_MISSING_EMAIL',
        message: 'No se puede enviar. Falta el correo de Beto y Carla.',
        missing: [{ memberId: 'beto', name: 'Beto' }, { memberId: 'carla', name: 'Carla' }],
      });
      expect(s.sets.rows[0]!.status).toBe('borrador');
      expect(s.links.rows).toEqual([]);
      expect(s.sendApproval).not.toHaveBeenCalled();
    });

    it('solo el proponente envía; una propuesta que no es borrador no se envía; ni dos abiertas', async () => {
      const s = setup();
      const draft = await s.service.saveDraft(actor('ana'), config());
      await expect(s.service.submit(actor('beto'), draft.id)).rejects.toBeInstanceOf(ForbiddenException);
      await s.service.submit(actor('ana'), draft.id);
      await expect(s.service.submit(actor('ana'), draft.id)).rejects.toMatchObject({ response: { code: 'FINANCE_RULES_WRONG_STATE' } });
      const other = await s.service.saveDraft(actor('ana'), config(20));
      await expect(s.service.submit(actor('ana'), other.id)).rejects.toMatchObject({ response: { code: 'FINANCE_RULES_PENDING_EXISTS' } });
      await expect(s.service.submit(actor('ana'), 'nada')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('un correo que falla retira SOLO ese enlace y lo reporta; los demás salen', async () => {
      const sendApproval = vi.fn(async (mail: { to: string }) => {
        if (mail.to === 'beto@example.test') throw new Error('boom');
      });
      const s = setup({ sendApproval });
      const sent = await propose(s);
      expect(sent.emails).toEqual({ sent: ['Ana'], failed: ['Beto'] });
      const beto = s.links.rows.find((l) => l.memberId === 'beto')!;
      expect(beto).toMatchObject({ emailSent: false });
      expect(beto.supersededAt).toBeInstanceOf(Date);
      expect(s.links.rows.find((l) => l.memberId === 'ana')).toMatchObject({ emailSent: true });
    });

    it('sin la dirección pública del sitio, ningún enlace sale y todos se reportan', async () => {
      vi.stubEnv('PUBLIC_SITE_URL', '');
      vi.stubEnv('NODE_ENV', 'production');
      const s = setup();
      const sent = await propose(s);
      expect(sent.emails).toEqual({ sent: [], failed: ['Ana', 'Beto'] });
      expect(s.sendApproval).not.toHaveBeenCalled();
    });

    it('compara con las reglas vigentes: "qué cambió" va en la propuesta y en el correo', async () => {
      const s = setup({ partners: [partner('ana', 'Ana', 1)] });
      const first = await propose(s, 'ana', 10);
      s.sets.rows[0]!.status = 'vigente';
      s.sendApproval.mockClear();
      const second = await propose(s, 'ana', 30);
      expect(second.changes).toEqual([
        { topic: 'Reservas', before: 'Se aparta 10 % para reservas antes de repartir.', after: 'Se aparta 30 % para reservas antes de repartir.' },
      ]);
      expect(s.sendApproval.mock.calls[0]![0].changes).toEqual(second.changes);
      expect(first.changes).toBeNull();
    });

    it('si nada cambió respecto a lo vigente, no hay sección "qué cambió"', async () => {
      const s = setup({ partners: [partner('ana', 'Ana', 1)] });
      await propose(s);
      s.sets.rows[0]!.status = 'vigente';
      s.sendApproval.mockClear();
      const same = await propose(s);
      expect(same.changes).toBeNull();
      expect(s.sendApproval.mock.calls[0]![0].changes).toBeNull();
    });
  });

  describe('modificar', () => {
    it('copia la propuesta abierta en un borrador de quien lo pide, con las objeciones a la vista', async () => {
      const s = setup();
      const sent = await propose(s);
      object(s, sent.id, 'beto', 'Más reservas');
      const draft = await s.service.modify(actor('beto'), sent.id);
      expect(draft).toMatchObject({ status: 'borrador', version: 2, config: sent.config, configHash: sent.configHash, proposedBy: { name: 'Beto' } });
      expect(draft.basedOn).toMatchObject({ id: sent.id, version: 1, objections: [expect.objectContaining({ name: 'Beto', reason: 'Más reservas' })] });
      expect(s.sets.rows[0]!.status).toBe('en_revision');
    });

    it('enviar la versión nueva reemplaza la anterior, avisa a todos y no arrastra aprobaciones', async () => {
      const s = setup();
      const sent = await propose(s);
      approve(s, sent.id, 'ana');
      object(s, sent.id, 'beto', 'Más reservas');
      const draft = await s.service.modify(actor('beto'), sent.id);
      await s.service.saveDraft(actor('beto'), config(25));
      s.sendApproval.mockClear();
      const next = await s.service.submit(actor('beto'), draft.id);

      expect(next).toMatchObject({ status: 'pendiente', version: 2, approvals: [] });
      expect(next.changes).toEqual([expect.objectContaining({ topic: 'Reservas' })]);
      expect(s.sets.rows[0]).toMatchObject({ status: 'descartada', closedNote: 'Reemplazada por la versión 2.' });
      expect(s.sendApproval).toHaveBeenCalledTimes(2);
      expect(s.sendApproval.mock.calls.map(([m]) => m.to)).toEqual(['ana@example.test', 'beto@example.test']);
    });

    it('también se puede modificar una propuesta que aún espera respuestas', async () => {
      const s = setup();
      const sent = await propose(s);
      expect((await s.service.modify(actor('beto'), sent.id)).basedOn).toMatchObject({ id: sent.id, objections: [] });
    });

    it('solo una propuesta abierta, y solo si no hay otro borrador', async () => {
      const s = setup();
      const draft = await s.service.saveDraft(actor('ana'), config());
      await expect(s.service.modify(actor('ana'), draft.id)).rejects.toMatchObject({ response: { code: 'FINANCE_RULES_WRONG_STATE' } });
      await s.service.submit(actor('ana'), draft.id);
      await s.service.saveDraft(actor('beto'), config(40));
      await expect(s.service.modify(actor('ana'), draft.id)).rejects.toMatchObject({
        response: { code: 'FINANCE_RULES_DRAFT_EXISTS', message: 'Beto ya tiene un borrador abierto. Que lo envíe o lo descarte primero.' },
      });
    });
  });

  describe('reenviar', () => {
    it('reenvía solo a quien falta, con enlace nuevo, y lo recuerda 24 horas', async () => {
      const s = setup();
      const sent = await propose(s);
      approve(s, sent.id, 'ana');
      s.sendApproval.mockClear();
      const now = new Date('2026-10-21T12:00:00Z');

      const first = await s.service.resend(actor('ana'), sent.id, now);
      expect(first).toEqual({ activated: false, resent: [{ memberId: 'beto', name: 'Beto', emailSent: true }], skipped: [], noEmail: [] });
      expect(s.sendApproval).toHaveBeenCalledTimes(1);
      expect(s.sendApproval.mock.calls[0]![0]).toMatchObject({ to: 'beto@example.test', proposerName: 'Ana' });
      const betoLinks = s.links.rows.filter((l) => l.memberId === 'beto');
      expect(betoLinks.map((l) => [l.kind, Boolean(l.supersededAt)])).toEqual([['envio', true], ['reenvio', false]]);

      const soon = await s.service.resend(actor('ana'), sent.id, new Date(now.getTime() + 23 * HOUR));
      expect(soon.resent).toEqual([]);
      expect(soon.skipped).toEqual([{ memberId: 'beto', name: 'Beto', nextAt: new Date(now.getTime() + RESEND_COOLDOWN_MS).toISOString() }]);
      const later = await s.service.resend(actor('ana'), sent.id, new Date(now.getTime() + 25 * HOUR));
      expect(later.resent).toHaveLength(1);
    });

    it('un reenvío que falló no cuenta para las 24 horas', async () => {
      const sendApproval = vi.fn().mockResolvedValue(undefined);
      const s = setup({ sendApproval });
      const sent = await propose(s);
      sendApproval.mockRejectedValueOnce(new Error('boom'));
      const now = new Date('2026-10-21T12:00:00Z');
      const failed = await s.service.resend(actor('ana'), sent.id, now);
      expect(failed.resent.find((r) => r.name === 'Ana')).toMatchObject({ emailSent: false });
      const again = await s.service.resend(actor('ana'), sent.id, new Date(now.getTime() + 1000));
      expect(again.skipped.map((r) => r.name)).toEqual(['Beto']);
      expect(again.resent.map((r) => r.name)).toEqual(['Ana']);
    });

    it('dice a quién no se le pudo mandar por no tener correo', async () => {
      const s = setup();
      const sent = await propose(s);
      s.members.rows.find((m) => m.id === 'beto')!.correo = null;
      const res = await s.service.resend(actor('ana'), sent.id);
      expect(res.noEmail).toEqual([{ memberId: 'beto', name: 'Beto' }]);
      expect(res.resent.map((r) => r.name)).toEqual(['Ana']);
    });

    it('si quien faltaba ya no es socio activo, reenviar deja la propuesta vigente', async () => {
      const s = setup({ settled: true });
      const sent = await propose(s);
      s.sendApproval.mockClear();
      expect(await s.service.resend(actor('ana'), sent.id)).toEqual({ activated: true, resent: [], skipped: [], noEmail: [] });
      expect(s.sendApproval).not.toHaveBeenCalled();
    });

    it('en revisión no se reenvía, y tampoco un borrador', async () => {
      const s = setup();
      const draft = await s.service.saveDraft(actor('ana'), config());
      await expect(s.service.resend(actor('ana'), draft.id)).rejects.toMatchObject({ response: { code: 'FINANCE_RULES_WRONG_STATE' } });
      await s.service.submit(actor('ana'), draft.id);
      object(s, draft.id, 'beto');
      await expect(s.service.resend(actor('ana'), draft.id)).rejects.toMatchObject({
        response: { code: 'FINANCE_RULES_IN_REVIEW', message: 'Esta propuesta está en revisión. Modifícala o descártala.' },
      });
    });
  });

  it('listNames une los nombres como se dice en voz alta', () => {
    expect(listNames([])).toBe('');
    expect(listNames(['Ana'])).toBe('Ana');
    expect(listNames(['Ana', 'Beto'])).toBe('Ana y Beto');
    expect(listNames(['Ana', 'Beto', 'Carla'])).toBe('Ana, Beto y Carla');
  });
});

describe('FinanceRulesController', () => {
  it('cada ruta pasa la petición y el id al servicio', async () => {
    const service = {
      overview: vi.fn().mockResolvedValue('overview'),
      saveDraft: vi.fn().mockResolvedValue('draft'),
      discard: vi.fn().mockResolvedValue('discard'),
      submit: vi.fn().mockResolvedValue('submit'),
      modify: vi.fn().mockResolvedValue('modify'),
      resend: vi.fn().mockResolvedValue('resend'),
    };
    const controller = new FinanceRulesController(service as never);
    const req = actor('ana');
    const id = 'a1b2c3d4-0000-7000-8000-000000000001';

    expect(await controller.overview(req)).toBe('overview');
    expect(await controller.saveDraft(req, { config: { a: 1 } })).toBe('draft');
    expect(await controller.discard(req, id)).toBe('discard');
    expect(await controller.submit(req, id)).toBe('submit');
    expect(await controller.modify(req, id)).toBe('modify');
    expect(await controller.resend(req, id)).toBe('resend');
    expect(service.saveDraft).toHaveBeenCalledWith(req, { a: 1 });
    expect(service.resend).toHaveBeenCalledWith(req, id);
  });
});

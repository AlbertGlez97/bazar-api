import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, HttpException, NotFoundException } from '@nestjs/common';
import {
  AGREEMENT_IN_REVIEW_MESSAGE,
  FinanceRuleLinksService,
  LINK_TTL_MS,
  MAX_REASON_LENGTH,
} from './finance-rule-links.service.js';
import { PublicAgreementsController } from './finance-rules.controller.js';
import { RULES_SCHEMA_VERSION } from './finance-rules.config.js';
import { hashSingleUseToken } from '../common/single-use-token.js';
import { table, type Row } from '../../test/support/memory-table.js';

/**
 * Unit tests of the emailed-link service. What the SQL functions decide (who may answer, the lock
 * order, the last approval) is covered by test/finance-rules.e2e-spec.ts against a real database.
 */
const config = {
  schemaVersion: RULES_SCHEMA_VERSION,
  profitBase: { partnerPct: 50, capitalPct: 30, workPct: 20 },
  reinvestment: { currentPhase: 'operacion', arranquePct: 100, operacionPct: 50, cierrePct: 0, untilAmountMinor: null },
  capitalRecovery: { mode: 'por_diferencia', timing: 'durante' },
  work: { payHours: false, order: 'antes', pay: { kind: 'por_hora', rateMinorPerHour: 5000 } },
  partnerExpenses: 'reembolsar',
  reserves: { kind: 'porcentaje', pct: 10 },
  partnerLoans: { repayBeforeCapital: true },
};
const meta = { proposerName: 'Ana', version: 2, config: config as never, changes: null };

function setup(rows: { lookup?: Row[]; respond?: Row[] } = {}) {
  const links = table([]);
  const queries: { sql: string; values: unknown[] }[] = [];
  const raw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('?');
    queries.push({ sql, values });
    if (sql.includes('finance_rule_link_lookup')) return rows.lookup ?? [];
    if (sql.includes('finance_rule_link_respond')) return rows.respond ?? [];
    if (sql.includes('nombreNegocio')) return [{ name: 'Bazar Sol' }];
    return [];
  };
  const prisma = { financeRuleLink: links, $queryRaw: raw };
  const send = vi.fn().mockResolvedValue(undefined);
  const service = new FinanceRuleLinksService(prisma as never, { sendFinanceRulesApprovalEmail: send } as never);
  return { service, links, queries, send };
}

const lookupRow = (over: Row = {}): Row => ({
  state: 'pendiente',
  contextId: 'ctx',
  version: 2,
  config,
  changeSummary: null,
  memberName: 'Beto',
  proposerName: 'Ana',
  expiresAt: new Date('2026-10-28T12:00:00Z'),
  submittedAt: new Date('2026-10-21T12:00:00Z'),
  approvedNames: ['Ana'],
  waitingNames: ['Beto'],
  ...over,
});
const token = (letter: string) => letter.repeat(43);

beforeEach(() => vi.stubEnv('PUBLIC_SITE_URL', 'https://site.test/'));
afterEach(() => vi.unstubAllEnvs());

describe('FinanceRuleLinksService', () => {
  describe('issue', () => {
    it('crea un enlace de 7 días, guarda solo el hash y retira el enlace vivo anterior de ese socio', async () => {
      const { service, links } = setup();
      const now = new Date('2026-10-21T12:00:00Z');
      const base = { contextId: 'ctx', ruleSetId: 'set', memberId: 'beto', correo: 'beto@example.test', sentByMemberId: 'ana', now };
      links.rows.push({ contextId: 'ctx', ruleSetId: 'set', memberId: 'beto', usedAt: null, supersededAt: null });
      links.rows.push({ contextId: 'ctx', ruleSetId: 'set', memberId: 'ana', usedAt: null, supersededAt: null });

      const issued = await service.issue({ financeRuleLink: links } as never, { ...base, kind: 'reenvio' });

      expect(issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(links.rows[0]!.supersededAt).toEqual(now);
      expect(links.rows[1]!.supersededAt).toBeNull();
      const created = links.rows.at(-1)!;
      expect(created).toMatchObject({ memberId: 'beto', correo: 'beto@example.test', kind: 'reenvio', sentByMemberId: 'ana', tokenHash: hashSingleUseToken(issued.token) });
      expect(created.expiresAt).toEqual(new Date(now.getTime() + LINK_TTL_MS));
      expect(JSON.stringify(created)).not.toContain(issued.token);
    });
  });

  describe('deliver', () => {
    const link = { linkId: 'l1', token: token('T'), memberId: 'beto', memberName: 'Beto', correo: 'beto@example.test' };

    it('no hace nada sin enlaces', async () => {
      const { service, send } = setup();
      expect((await service.deliver('ctx', [], meta)).size).toBe(0);
      expect(send).not.toHaveBeenCalled();
    });

    it('manda cada correo con su enlace /acuerdo/<token> y marca el enlace como enviado', async () => {
      const { service, links, send } = setup();
      links.rows.push({ id: 'l1', emailSent: false });
      const delivered = await service.deliver('ctx', [link], { ...meta, changes: [{ topic: 'Reservas', before: 'a', after: 'b' }] });

      expect([...delivered]).toEqual(['beto']);
      expect(send).toHaveBeenCalledWith(expect.objectContaining({
        to: 'beto@example.test',
        memberName: 'Beto',
        proposerName: 'Ana',
        businessName: 'Bazar Sol',
        version: 2,
        expiresInDays: 7,
        reviewUrl: `https://site.test/acuerdo/${token('T')}`,
        changes: [{ topic: 'Reservas', before: 'a', after: 'b' }],
      }));
      expect(send.mock.calls[0]![0].summary).toHaveLength(7);
      expect(links.rows[0]!.emailSent).toBe(true);
    });

    it('si el correo falla, retira ese enlace y sigue con los demás', async () => {
      const { service, links, send } = setup();
      links.rows.push({ id: 'l1', emailSent: false }, { id: 'l2', emailSent: false });
      send.mockRejectedValueOnce(new Error('boom'));
      const delivered = await service.deliver('ctx', [link, { ...link, linkId: 'l2', memberId: 'carla', memberName: 'Carla' }], meta);

      expect([...delivered]).toEqual(['carla']);
      expect(links.rows[0]).toMatchObject({ emailSent: false });
      expect(links.rows[0]!.supersededAt).toBeInstanceOf(Date);
      expect(links.rows[1]).toMatchObject({ emailSent: true });
    });

    it('sin la dirección pública del sitio (en producción) no se manda nada: un enlace adivinado podría apuntar a otro lado', async () => {
      vi.stubEnv('PUBLIC_SITE_URL', '');
      vi.stubEnv('NODE_ENV', 'production');
      const { service, links, send } = setup();
      links.rows.push({ id: 'l1', emailSent: false });
      expect((await service.deliver('ctx', [link], meta)).size).toBe(0);
      expect(send).not.toHaveBeenCalled();
      expect(links.rows[0]!.supersededAt).toBeInstanceOf(Date);
    });

    it('si no se encuentra el nombre del negocio, el correo dice "tu negocio"', async () => {
      const links = table([{ id: 'l1' }]);
      const send = vi.fn().mockResolvedValue(undefined);
      const service = new FinanceRuleLinksService({ financeRuleLink: links, $queryRaw: async () => [] } as never, { sendFinanceRulesApprovalEmail: send } as never);
      await service.deliver('ctx', [link], meta);
      expect(send.mock.calls[0]![0].businessName).toBe('tu negocio');
    });
  });

  describe('inspect', () => {
    it('muestra la propuesta en palabras sencillas, con quién respondió y quién falta', async () => {
      const { service, queries } = setup({ lookup: [lookupRow({ changeSummary: [{ topic: 'Reservas', before: 'a', after: 'b' }] })] });
      const page = await service.inspect(token('A'), '1.2.3.4');

      expect(queries[0]!.values).toEqual([hashSingleUseToken(token('A'))]);
      expect(page).toMatchObject({
        state: 'pendiente',
        message: null,
        business: 'Bazar Sol',
        memberName: 'Beto',
        proposerName: 'Ana',
        version: 2,
        submittedAt: '2026-10-21T12:00:00.000Z',
        expiresAt: '2026-10-28T12:00:00.000Z',
        changes: [{ topic: 'Reservas', before: 'a', after: 'b' }],
        approvedBy: ['Ana'],
        waitingFor: ['Beto'],
      });
      expect(page.rules).toContain('La utilidad va 50 % por ser socio, 30 % por capital y 20 % por trabajo.');
      expect(page.warnings).toEqual([]);
    });

    it('en revisión dice por qué no se puede responder', async () => {
      const { service } = setup({ lookup: [lookupRow({ state: 'en_revision', submittedAt: null, changeSummary: [] })] });
      const page = await service.inspect(token('A'), 'ip');
      expect(page).toMatchObject({ state: 'en_revision', message: AGREEMENT_IN_REVIEW_MESSAGE, submittedAt: null, changes: null });
    });

    it('un enlace que no sirve da la respuesta de siempre', async () => {
      const { service } = setup();
      await expect(service.inspect(token('A'), 'ip')).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.inspect(token('A'), 'ip')).rejects.toMatchObject({
        response: { code: 'AGREEMENT_LINK_INVALID', message: 'Este enlace no sirve. Pide a un socio que te lo envíe de nuevo.' },
      });
    });

    it('limita los intentos por enlace y por dirección', async () => {
      const { service } = setup();
      const codes: number[] = [];
      for (let i = 0; i < 12; i++) codes.push(await service.inspect(token('B'), 'ip').catch((e: HttpException) => e.getStatus()) as number);
      expect(codes.slice(0, 10).every((code) => code === 404)).toBe(true);
      expect(codes.slice(10)).toEqual([429, 429]);

      const byIp = setup();
      const statuses: number[] = [];
      for (let i = 0; i < 125; i++)
        statuses.push(await byIp.service.inspect(`${String(i).padStart(2, '0')}${'x'.repeat(41)}`, 'same-ip').catch((e: HttpException) => e.getStatus()) as number);
      expect(statuses.at(-1)).toBe(429);
    });
  });

  describe('respond', () => {
    it('aprobar no pide motivo y devuelve el resultado', async () => {
      const { service, queries } = setup({ respond: [{ outcome: 'vigente' }] });
      expect(await service.respond(token('A'), 'approve', undefined, 'ip')).toEqual({ outcome: 'vigente' });
      expect(queries[0]!.values.slice(0, 3)).toEqual([hashSingleUseToken(token('A')), 'approve', '']);
      expect(queries[0]!.values[3]).toMatch(/^[0-9a-f]{8}-/);
    });

    it('objetar exige un motivo: vacío, solo espacios o solo caracteres invisibles no sirven', async () => {
      const { service, queries } = setup({ respond: [{ outcome: 'objetada' }] });
      for (const reason of [undefined, '', '   ', '\u0000​'])
        await expect(service.respond(token('A'), 'object', reason, 'ip')).rejects.toMatchObject({
          response: { code: 'AGREEMENT_REASON_REQUIRED', message: 'Escribe en pocas palabras por qué no estás de acuerdo.' },
        });
      expect(queries).toEqual([]);
    });

    it('el motivo va como texto plano, limpio, y de 500 letras como máximo', async () => {
      const { service, queries } = setup({ respond: [{ outcome: 'objetada' }] });
      await service.respond(token('A'), 'object', '  Quiero  más <b>reservas</b>.\u0000 ', 'ip');
      expect(queries[0]!.values[2]).toBe('Quiero más <b>reservas</b>.');
      await service.respond(token('A'), 'object', 'x'.repeat(MAX_REASON_LENGTH), 'ip');
      await expect(service.respond(token('A'), 'object', 'x'.repeat(MAX_REASON_LENGTH + 1), 'ip')).rejects.toMatchObject({
        response: { code: 'AGREEMENT_REASON_TOO_LONG', message: 'Usa máximo 500 letras.' },
      });
      await expect(service.respond(token('A'), 'object', '', 'ip')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('un enlace que no sirve da la misma respuesta que al leerlo', async () => {
      const { service } = setup();
      await expect(service.respond(token('A'), 'approve', undefined, 'ip')).rejects.toMatchObject({
        response: { code: 'AGREEMENT_LINK_INVALID' },
      });
    });
  });
});

describe('PublicAgreementsController', () => {
  it('pasa el enlace y la dirección de quien pregunta al servicio', async () => {
    const service = {
      inspect: vi.fn().mockResolvedValue('page'),
      respond: vi.fn().mockResolvedValue({ outcome: 'aprobada' }),
    };
    const controller = new PublicAgreementsController(service as never);
    const req = { headers: {}, socket: { remoteAddress: '203.0.113.9' } } as never;

    expect(await controller.inspect(req, { token: token('A') })).toBe('page');
    expect(await controller.respond(req, { token: token('A'), decision: 'object', reason: 'No' })).toEqual({ outcome: 'aprobada' });
    expect(service.inspect).toHaveBeenCalledWith(token('A'), expect.any(String));
    expect(service.respond).toHaveBeenCalledWith(token('A'), 'object', 'No', expect.any(String));
  });
});

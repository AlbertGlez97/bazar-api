import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpException } from '@nestjs/common';
import {
  EMAIL_CONFIRMATION_TTL_MS,
  EMAIL_IN_USE_MESSAGE,
  MemberEmailService,
} from './member-email.service.js';
import { MemberEmailController, PublicMemberEmailController } from './member-email.controller.js';
import { hashSingleUseToken } from '../common/single-use-token.js';
import { table, type Row } from '../../test/support/memory-table.js';

/**
 * Unit tests of "Escribir mi correo". The functions that look a link up and give the address
 * (and the unique index that decides who owns it) are covered by test/member-email.e2e-spec.ts.
 */
const CONTEXT = 'ctx-1';
const token = (letter: string) => letter.repeat(43);

function setup(opts: { members?: Row[]; accounts?: Row[]; taken?: boolean; lookup?: Row[]; confirm?: Row[]; businessName?: string | null } = {}) {
  const members = table(opts.members ?? [{ id: 'ana', name: 'Ana', role: 'socio', active: true, contextId: CONTEXT, correo: null }]);
  const accounts = table(opts.accounts ?? []);
  const confirmations = table([]);
  const queries: { sql: string; values: unknown[] }[] = [];
  const raw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('?');
    queries.push({ sql, values });
    if (sql.includes('member_correo_taken')) return [{ taken: opts.taken ?? false }];
    if (sql.includes('member_email_confirmation_lookup')) return opts.lookup ?? [];
    if (sql.includes('member_email_confirm(')) return opts.confirm ?? [];
    if (sql.includes('nombreNegocio')) return opts.businessName === null ? [] : [{ name: opts.businessName ?? 'Bazar Sol' }];
    return [];
  };
  const prisma: Row = {
    member: members,
    account: accounts,
    memberEmailConfirmation: confirmations,
    $queryRaw: raw,
    $transaction: async (fn: (tx: Row) => unknown) => fn(prisma),
  };
  const emails = {
    sendMemberEmailConfirmationEmail: vi.fn().mockResolvedValue(undefined),
    sendMemberEmailRegisteredNoticeEmail: vi.fn().mockResolvedValue(undefined),
  };
  const service = new MemberEmailService(prisma as never, emails as never);
  return { service, members, accounts, confirmations, queries, emails };
}

const actor = (memberId = 'ana') =>
  ({ account: { id: `acc-${memberId}`, contextId: CONTEXT, memberId }, selection: { memberId, deviceId: 'dev' } }) as never;

beforeEach(() => vi.stubEnv('PUBLIC_SITE_URL', 'https://site.test'));
afterEach(() => vi.unstubAllEnvs());

describe('MemberEmailService', () => {
  describe('status', () => {
    it('sin correo ni confirmación pendiente', async () => {
      expect(await setup().service.status(actor())).toEqual({ correo: null, pending: null });
    });

    it('muestra el correo enmascarado y la confirmación vigente, nunca una vencida o usada', async () => {
      const s = setup({ members: [{ id: 'ana', name: 'Ana', role: 'socio', active: true, contextId: CONTEXT, correo: 'ana@example.test' }] });
      const now = new Date('2026-10-21T12:00:00Z');
      const live = { contextId: CONTEXT, memberId: 'ana', usedAt: null, supersededAt: null, createdAt: now };
      s.confirmations.rows.push(
        { ...live, correo: 'vencido@example.test', expiresAt: new Date(now.getTime() - 1) },
        { ...live, correo: 'usado@example.test', expiresAt: new Date(now.getTime() + 1000), usedAt: now },
        { ...live, correo: 'nuevo@example.test', expiresAt: new Date(now.getTime() + 1000) },
      );
      expect(await s.service.status(actor(), now)).toEqual({
        correo: 'a***@e***.test',
        pending: { correo: 'n***@e***.test', expiresAt: new Date(now.getTime() + 1000).toISOString() },
      });
    });
  });

  describe('request', () => {
    it('manda el enlace SOLO al correo escrito (en minúsculas), guarda el hash y no cambia a la persona', async () => {
      const s = setup();
      const now = new Date('2026-10-21T12:00:00Z');
      const res = await s.service.request(actor(), '  Ana@Example.TEST ', now);

      expect(res).toEqual({ ok: true, correo: 'a***@e***.test', expiresAt: new Date(now.getTime() + EMAIL_CONFIRMATION_TTL_MS).toISOString() });
      const [mail] = s.emails.sendMemberEmailConfirmationEmail.mock.calls[0]!;
      expect(mail).toMatchObject({ to: 'ana@example.test', memberName: 'Ana', businessName: 'Bazar Sol', expiresInHours: 48 });
      const sentToken = mail.confirmUrl.split('/confirmar-correo/')[1];
      expect(mail.confirmUrl).toBe(`https://site.test/confirmar-correo/${sentToken}`);
      expect(s.confirmations.rows[0]).toMatchObject({ memberId: 'ana', correo: 'ana@example.test', tokenHash: hashSingleUseToken(sentToken), requestedByAccountId: 'acc-ana' });
      expect(JSON.stringify(s.confirmations.rows)).not.toContain(sentToken);
      expect(s.members.rows[0]!.correo).toBeNull();
    });

    it('una petición nueva retira el enlace anterior de esa persona, no el de otras', async () => {
      const s = setup();
      s.confirmations.rows.push(
        { id: 'mine', contextId: CONTEXT, memberId: 'ana', usedAt: null, supersededAt: null },
        { id: 'theirs', contextId: CONTEXT, memberId: 'beto', usedAt: null, supersededAt: null },
      );
      const now = new Date('2026-10-21T12:00:00Z');
      await s.service.request(actor(), 'ana@example.test', now);
      expect(s.confirmations.rows.find((r) => r.id === 'mine')!.supersededAt).toEqual(now);
      expect(s.confirmations.rows.find((r) => r.id === 'theirs')!.supersededAt).toBeNull();
    });

    it.each(['ana', 'ana@', 'a b@c.co', 'Ana <a@b.co>', 'a@b.co, c@d.co'])('rechaza "%s" en español', async (typed) => {
      const s = setup();
      await expect(s.service.request(actor(), typed)).rejects.toMatchObject({
        response: { code: 'MEMBER_EMAIL_INVALID', message: 'Escribe un correo válido, por ejemplo nombre@dominio.com' },
      });
      expect(s.emails.sendMemberEmailConfirmationEmail).not.toHaveBeenCalled();
    });

    it('quien no es socio activo no encuentra su ficha', async () => {
      const s = setup({ members: [{ id: 'ana', name: 'Ana', role: 'socio', active: false, contextId: CONTEXT, correo: null }] });
      await expect(s.service.request(actor(), 'ana@example.test')).rejects.toMatchObject({ status: 404 });
    });

    it('quien ya tiene correo no escribe otro aquí', async () => {
      const s = setup({ members: [{ id: 'ana', name: 'Ana', role: 'socio', active: true, contextId: CONTEXT, correo: 'ana@example.test' }] });
      await expect(s.service.request(actor(), 'otro@example.test')).rejects.toMatchObject({
        response: { code: 'MEMBER_EMAIL_ALREADY_SET', message: 'Ya tienes un correo registrado.' },
      });
    });

    it('un correo que ya es de otra persona (en cualquier negocio) está en uso', async () => {
      const s = setup({ taken: true });
      await expect(s.service.request(actor(), 'otro@example.test')).rejects.toMatchObject({
        response: { code: 'MEMBER_EMAIL_IN_USE', message: EMAIL_IN_USE_MESSAGE },
      });
      expect(s.emails.sendMemberEmailConfirmationEmail).not.toHaveBeenCalled();
      expect(s.confirmations.rows).toEqual([]);
    });

    it('el usuario de otra persona también cuenta, salvo el acceso compartido de este negocio o el propio', async () => {
      const login = (over: Row) => ({ username: 'x@example.test', contextId: CONTEXT, memberId: null, ...over });
      for (const [account, refused] of [
        [login({ contextId: 'otro-negocio' }), true],
        [login({ memberId: 'beto' }), true],
        [login({ contextId: 'otro-negocio', memberId: 'ana' }), false],
        [login({}), false],
        [login({ memberId: 'ana' }), false],
      ] as const) {
        const s = setup({ accounts: [account] });
        const result = s.service.request(actor(), 'x@example.test');
        if (refused) await expect(result).rejects.toMatchObject({ response: { code: 'MEMBER_EMAIL_IN_USE' } });
        else await expect(result).resolves.toMatchObject({ ok: true });
      }
    });

    it('limita a 5 correos por hora por persona', async () => {
      const s = setup();
      const codes: number[] = [];
      for (let i = 0; i < 6; i++)
        codes.push(await s.service.request(actor(), `ana${i}@example.test`).then(() => 200, (e: HttpException) => e.getStatus()));
      expect(codes).toEqual([200, 200, 200, 200, 200, 429]);
    });

    it('si el correo no sale, el enlace se retira y se avisa', async () => {
      const s = setup();
      s.emails.sendMemberEmailConfirmationEmail.mockRejectedValue(new Error('boom'));
      await expect(s.service.request(actor(), 'ana@example.test')).rejects.toMatchObject({
        response: { code: 'MEMBER_EMAIL_NOT_SENT' },
      });
      expect(s.confirmations.rows[0]!.supersededAt).toBeInstanceOf(Date);
    });

    it('sin la dirección pública del sitio (en producción) no se manda nada', async () => {
      vi.stubEnv('PUBLIC_SITE_URL', '');
      vi.stubEnv('NODE_ENV', 'production');
      const s = setup();
      await expect(s.service.request(actor(), 'ana@example.test')).rejects.toMatchObject({ response: { code: 'MEMBER_EMAIL_NOT_SENT' } });
      expect(s.emails.sendMemberEmailConfirmationEmail).not.toHaveBeenCalled();
    });

    it('sin el nombre del negocio, el correo dice "tu negocio"', async () => {
      const s = setup({ businessName: null });
      await s.service.request(actor(), 'ana@example.test');
      expect(s.emails.sendMemberEmailConfirmationEmail.mock.calls[0]![0].businessName).toBe('tu negocio');
    });
  });

  describe('la página pública', () => {
    const lookup = [{ memberName: 'Ana', correo: 'ana@example.test', expiresAt: new Date('2026-10-23T12:00:00Z') }];

    it('inspect muestra a quién pertenece el correo, enmascarado, sin consumir nada', async () => {
      const s = setup({ lookup });
      expect(await s.service.inspect(token('A'), 'ip')).toEqual({ memberName: 'Ana', correo: 'a***@e***.test', expiresAt: '2026-10-23T12:00:00.000Z' });
      expect(s.queries[0]!.values).toEqual([hashSingleUseToken(token('A'))]);
    });

    it('un enlace que no sirve da la misma respuesta al leerlo y al confirmarlo', async () => {
      const s = setup();
      for (const call of [s.service.inspect(token('A'), 'ip'), s.service.confirm(token('B'), 'ip')])
        await expect(call).rejects.toMatchObject({
          response: { code: 'MEMBER_EMAIL_LINK_INVALID', message: 'Este enlace no sirve. Escribe tu correo de nuevo para recibir otro.' },
          status: 404,
        });
    });

    it('confirm devuelve el correo enmascarado y avisa a los otros socios, sin el correo completo', async () => {
      const s = setup({
        confirm: [{ correo: 'ana@example.test', memberName: 'Ana', contextId: CONTEXT, memberId: 'ana', notify: [{ name: 'Beto', correo: 'beto@example.test' }, { name: 'Carla', correo: 'carla@example.test' }] }],
      });
      expect(await s.service.confirm(token('A'), 'ip')).toEqual({ ok: true, correo: 'a***@e***.test' });
      expect(s.emails.sendMemberEmailRegisteredNoticeEmail.mock.calls.map(([m]) => [m.to, m.memberName, m.registeredName, m.maskedCorreo, m.businessName])).toEqual([
        ['beto@example.test', 'Beto', 'Ana', 'a***@e***.test', 'Bazar Sol'],
        ['carla@example.test', 'Carla', 'Ana', 'a***@e***.test', 'Bazar Sol'],
      ]);
      expect(JSON.stringify(s.emails.sendMemberEmailRegisteredNoticeEmail.mock.calls)).not.toContain('ana@example.test');
    });

    it('un aviso que falla no deshace la confirmación ni impide los demás', async () => {
      const s = setup({
        confirm: [{ correo: 'ana@example.test', memberName: 'Ana', contextId: CONTEXT, memberId: 'ana', notify: [{ name: 'Beto', correo: 'beto@example.test' }, { name: 'Carla', correo: 'carla@example.test' }] }],
      });
      s.emails.sendMemberEmailRegisteredNoticeEmail.mockRejectedValueOnce(new Error('boom'));
      expect(await s.service.confirm(token('A'), 'ip')).toEqual({ ok: true, correo: 'a***@e***.test' });
      expect(s.emails.sendMemberEmailRegisteredNoticeEmail).toHaveBeenCalledTimes(2);
    });

    it('limita los intentos por enlace y por dirección', async () => {
      const s = setup();
      const codes: number[] = [];
      for (let i = 0; i < 12; i++) codes.push(await s.service.inspect(token('C'), 'ip').catch((e: HttpException) => e.getStatus()) as number);
      expect(codes.slice(10)).toEqual([429, 429]);
    });
  });
});

describe('member email controllers', () => {
  it('cada ruta pasa la petición al servicio', async () => {
    const service = {
      status: vi.fn().mockResolvedValue('status'),
      request: vi.fn().mockResolvedValue('request'),
      inspect: vi.fn().mockResolvedValue('inspect'),
      confirm: vi.fn().mockResolvedValue('confirm'),
    };
    const req = actor();
    const socio = new MemberEmailController(service as never);
    expect(await socio.status(req)).toBe('status');
    expect(await socio.request(req, { correo: 'ana@example.test' })).toBe('request');
    expect(service.request).toHaveBeenCalledWith(req, 'ana@example.test');

    const publicPage = new PublicMemberEmailController(service as never);
    const http = { headers: {}, socket: { remoteAddress: '203.0.113.9' } } as never;
    expect(await publicPage.inspect(http, { token: token('A') })).toBe('inspect');
    expect(await publicPage.confirm(http, { token: token('A') })).toBe('confirm');
    expect(service.confirm).toHaveBeenCalledWith(token('A'), expect.any(String));
  });
});

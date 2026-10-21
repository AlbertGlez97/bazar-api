import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  AccountInvitationsService,
  INVITATION_INVALID_MESSAGE,
  INVITATION_NOT_SENT_MESSAGE,
} from './account-invitations.service.js';
import {
  MemberInvitationsController,
  PublicInvitationsController,
} from './account-invitations.controller.js';
import {
  INVITATION_MAX_PER_DAY,
  INVITATION_MIN_GAP_MS,
  INVITATION_TTL_MS,
  hashInvitationToken,
} from './invitation-token.js';
import { table, type Row } from '../../test/support/memory-table.js';

vi.mock('../common/password.js', () => ({ hashPassword: vi.fn(async (p: string) => `hashed:${p}`) }));

/**
 * Unit tests against an in-memory stand-in for Prisma. The SQL functions are
 * imitated here only to exercise this class; the real functions, the row-level
 * security and concurrency are covered by test/account-invitations.e2e-spec.ts.
 */
const CONTEXT = 'ctx-1';
const NOW = new Date('2026-10-20T12:00:00.000Z');
const MIN = 60_000;
const HOUR = 60 * MIN;

/** `bound` is the member the login belongs to; `null` is the shared login of the business. */
const actor = (memberId = 'ana', bound: string | null = memberId) =>
  ({ account: { id: 'acc-ana', contextId: CONTEXT, memberId: bound }, selection: { memberId, deviceId: 'dev' } }) as never;
const sharedActor = (selected = 'ana') => actor(selected, null);

function setup(opts: { accounts?: Row[]; invitations?: Row[]; members?: Row[]; email?: ReturnType<typeof vi.fn> } = {}) {
  const members = table(
    opts.members ?? [
      { id: 'ana', name: 'Ana', role: 'socio', active: true, contextId: CONTEXT, createdAt: 1 },
      { id: 'beto', name: 'Beto', role: 'socio', active: true, contextId: CONTEXT, createdAt: 2 },
      { id: 'carla', name: 'Carla', role: 'colaborador', active: true, contextId: CONTEXT, createdAt: 3 },
    ],
  );
  const accounts = table(opts.accounts ?? [{ id: 'acc-ana', memberId: 'ana', username: 'ana@example.test', contextId: CONTEXT }]);
  const invitations = table(opts.invitations ?? []);
  const raw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('?');
    if (sql.includes('nombreNegocio')) return [{ name: 'Bazar Sol' }];
    if (sql.includes('account_invitation_lookup') || sql.includes('account_invitation_accept')) {
      const row = invitations.rows.find(
        (r) => r.tokenHash === values[0] && !r.usedAt && !r.supersededAt && r.expiresAt > new Date(),
      );
      const member = row && members.rows.find((m) => m.id === row.memberId && m.active && m.role === 'socio');
      if (!row || !member) return [];
      if (sql.includes('account_invitation_lookup'))
        return [{ memberName: member.name, email: row.email, expiresAt: row.expiresAt }];
      row.usedAt = new Date();
      row.accountId = values[1];
      accounts.rows.push({ id: values[1], memberId: row.memberId, username: row.email, passwordHash: values[2] });
      return [{ email: row.email }];
    }
    return [];
  };
  const prisma: Row = {
    member: members, account: accounts, accountInvitation: invitations,
    $queryRaw: raw,
    $transaction: async (fn: (tx: Row) => unknown) => fn(prisma),
  };
  const email = opts.email ?? vi.fn().mockResolvedValue(undefined);
  const service = new AccountInvitationsService(prisma as never, { sendAccountInvitationEmail: email } as never);
  return { service, members, accounts, invitations, email };
}

const tokenOf = (email: ReturnType<typeof vi.fn>) => {
  const url = (email.mock.calls.at(-1)![0] as { inviteUrl: string }).inviteUrl;
  return url.slice(url.lastIndexOf('/') + 1);
};

beforeEach(() => {
  vi.stubEnv('PUBLIC_SITE_URL', 'https://site.test/?x=1#y');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('AccountInvitationsService.invite', () => {
  it('crea la invitación con el hash del token, 72 horas, y manda el enlace sin contraseña', async () => {
    const s = setup();
    const result = await s.service.invite(actor(), 'beto', '  BETO@Example.test ', NOW);

    expect(result).toEqual({ ok: true, expiresAt: new Date(NOW.getTime() + INVITATION_TTL_MS).toISOString() });
    const [row] = s.invitations.rows;
    expect(row).toMatchObject({ memberId: 'beto', email: 'beto@example.test', invitedByMemberId: 'ana', contextId: CONTEXT });
    expect(row!.expiresAt.getTime() - NOW.getTime()).toBe(72 * HOUR);
    const call = s.email.mock.calls[0]![0];
    expect(call).toMatchObject({
      to: 'beto@example.test', memberName: 'Beto', inviterName: 'Ana', businessName: 'Bazar Sol', expiresInHours: 72,
    });
    expect(call.inviteUrl).toMatch(/^https:\/\/site\.test\/invitacion\/[A-Za-z0-9_-]{43}$/);
    expect(row!.tokenHash).toBe(hashInvitationToken(tokenOf(s.email)));
    expect(JSON.stringify(row)).not.toContain(tokenOf(s.email));
  });

  it.each(['', 'sin-arroba', 'a@b', 'a b@c.com', 'a@b.com, c@d.com', `${'x'.repeat(95)}@e.com`])(
    'rechaza el correo %j',
    async (bad) => {
      const s = setup();
      await expect(s.service.invite(actor(), 'beto', bad, NOW)).rejects.toBeInstanceOf(BadRequestException);
      expect(s.invitations.rows).toHaveLength(0);
    },
  );

  it('solo invita a un socio activo que existe, sin cuenta propia', async () => {
    const s = setup();
    await expect(s.service.invite(actor(), 'nadie', 'x@example.test', NOW)).rejects.toBeInstanceOf(NotFoundException);
    await expect(s.service.invite(actor(), 'carla', 'x@example.test', NOW)).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(s.service.invite(actor(), 'ana', 'x@example.test', NOW)).rejects.toBeInstanceOf(ConflictException);
    s.members.rows.find((m) => m.id === 'beto')!.active = false;
    await expect(s.service.invite(actor(), 'beto', 'x@example.test', NOW)).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(s.email).not.toHaveBeenCalled();
  });

  it('un correo que ya es cuenta, aquí o en otro negocio, da siempre la misma respuesta genérica', async () => {
    const s = setup({
      accounts: [
        { id: 'a1', memberId: 'ana', username: 'ana@example.test', contextId: CONTEXT },
        { id: 'a2', memberId: null, username: 'otro@example.test', contextId: 'otro-negocio' },
      ],
    });
    const failures = [];
    for (const email of ['ana@example.test', 'otro@example.test'])
      failures.push(await s.service.invite(actor(), 'beto', email, NOW).catch((e) => e));
    for (const error of failures) {
      expect(error).toBeInstanceOf(UnprocessableEntityException);
      expect(error.getResponse()).toEqual({ code: 'INVITATION_NOT_SENT', message: INVITATION_NOT_SENT_MESSAGE });
    }
    expect(failures[0].getStatus()).toBe(failures[1].getStatus());
    expect(s.invitations.rows).toHaveLength(0);
    expect(s.email).not.toHaveBeenCalled();
  });

  it('si el envío falla, el enlace queda sin efecto y la respuesta es la genérica', async () => {
    const s = setup({ email: vi.fn().mockRejectedValue(new Error('resend down')) });
    const error = await s.service.invite(actor(), 'beto', 'beto@example.test', NOW).catch((e) => e);
    expect(error.getResponse()).toEqual({ code: 'INVITATION_NOT_SENT', message: INVITATION_NOT_SENT_MESSAGE });
    expect(s.invitations.rows[0]!.supersededAt).toBeInstanceOf(Date);
  });

  it('un reenvío invalida el enlace anterior', async () => {
    const s = setup();
    await s.service.invite(actor(), 'beto', 'beto@example.test', NOW);
    await s.service.invite(actor(), 'beto', 'beto@example.test', new Date(NOW.getTime() + 2 * MIN));
    expect(s.invitations.rows.map((r) => Boolean(r.supersededAt))).toEqual([true, false]);
  });

  it('pide esperar un minuto entre envíos', async () => {
    const s = setup();
    await s.service.invite(actor(), 'beto', 'beto@example.test', NOW);
    const soon = new Date(NOW.getTime() + INVITATION_MIN_GAP_MS - 1);
    await expect(s.service.invite(actor(), 'beto', 'beto@example.test', soon)).rejects.toMatchObject({
      response: { code: 'INVITATION_TOO_SOON', message: 'Espera un minuto antes de enviar otra invitación.' },
      status: 429,
    });
    await expect(
      s.service.invite(actor(), 'beto', 'beto@example.test', new Date(NOW.getTime() + INVITATION_MIN_GAP_MS)),
    ).resolves.toMatchObject({ ok: true });
  });

  it('máximo 3 en 24 horas y se libera pasado el día', async () => {
    const s = setup();
    for (let i = 0; i < INVITATION_MAX_PER_DAY; i++)
      await s.service.invite(actor(), 'beto', 'beto@example.test', new Date(NOW.getTime() + i * 2 * MIN));
    const fourth = new Date(NOW.getTime() + 10 * MIN);
    await expect(s.service.invite(actor(), 'beto', 'beto@example.test', fourth)).rejects.toMatchObject({
      response: { code: 'INVITATION_DAILY_LIMIT', message: 'Ya se enviaron 3 invitaciones hoy. Intenta mañana.' },
      status: 429,
    });
    const nextDay = new Date(NOW.getTime() + 24 * HOUR + 4 * MIN);
    await expect(s.service.invite(actor(), 'beto', 'beto@example.test', nextDay)).resolves.toMatchObject({ ok: true });
  });

  describe('tope de invitaciones nuevas por socio que invita', () => {
    const manyMembers = (n: number): Row[] => [
      { id: 'ana', name: 'Ana', role: 'socio', active: true, contextId: CONTEXT, createdAt: 0 },
      ...Array.from({ length: n }, (_, i) => ({ id: `m${i}`, name: `Socio ${i}`, role: 'socio', active: true, contextId: CONTEXT, createdAt: i + 1 })),
    ];
    const invite = (s: ReturnType<typeof setup>, i: number, at: Date, who = 'ana') =>
      s.service.invite(actor(who), `m${i}`, `m${i}@example.test`, at);

    it('la invitación número 11 del día a personas distintas se rechaza con un mensaje claro', async () => {
      const s = setup({ members: manyMembers(12) });
      for (let i = 0; i < 10; i++) await invite(s, i, new Date(NOW.getTime() + i * MIN));
      const error = await invite(s, 10, new Date(NOW.getTime() + 11 * MIN)).catch((e) => e);
      expect(error.getStatus()).toBe(429);
      expect(error.getResponse()).toEqual({
        code: 'INVITATION_NEW_DAILY_LIMIT',
        message: 'Ya invitaste a 10 personas hoy. Intenta mañana.',
      });
      expect(s.invitations.rows).toHaveLength(10);
      expect(s.email).toHaveBeenCalledTimes(10);
    });

    it('los reenvíos a quien ya invitaste no cuentan como nuevos ni se bloquean por este tope', async () => {
      const s = setup({ members: manyMembers(12) });
      for (let i = 0; i < 10; i++) await invite(s, i, new Date(NOW.getTime() + i * MIN));
      await expect(invite(s, 0, new Date(NOW.getTime() + 20 * MIN))).resolves.toMatchObject({ ok: true });
    });

    it('pasadas 24 horas se pueden invitar más personas', async () => {
      const s = setup({ members: manyMembers(12) });
      for (let i = 0; i < 10; i++) await invite(s, i, new Date(NOW.getTime() + i * MIN));
      await expect(invite(s, 10, new Date(NOW.getTime() + 24 * HOUR + 11 * MIN))).resolves.toMatchObject({ ok: true });
    });

    it('el tope es de cada socio que invita: lo de otro socio no suma', async () => {
      const members = [...manyMembers(12), { id: 'otro', name: 'Otro', role: 'socio', active: true, contextId: CONTEXT, createdAt: 99 }];
      const s = setup({ members });
      for (let i = 0; i < 10; i++) await invite(s, i, new Date(NOW.getTime() + i * MIN));
      await expect(invite(s, 10, new Date(NOW.getTime() + 11 * MIN), 'otro')).resolves.toMatchObject({ ok: true });
    });

    it('una invitación a alguien que antes fue invitada por otro socio no cuenta como nueva para quien reenvía', async () => {
      const members = [...manyMembers(12), { id: 'otro', name: 'Otro', role: 'socio', active: true, contextId: CONTEXT, createdAt: 99 }];
      const s = setup({ members });
      for (let i = 0; i < 10; i++) await invite(s, i, new Date(NOW.getTime() + i * MIN), 'otro');
      // Ana reenvía a m0, a quien ya había invitado `otro`: no es una persona nueva.
      await expect(invite(s, 0, new Date(NOW.getTime() + 30 * MIN))).resolves.toMatchObject({ ok: true });
    });
  });

  it('sin PUBLIC_SITE_URL en producción no manda nada y da la respuesta genérica; en desarrollo usa localhost', async () => {
    vi.stubEnv('PUBLIC_SITE_URL', '');
    vi.stubEnv('NODE_ENV', 'production');
    const prod = setup();
    await expect(prod.service.invite(actor(), 'beto', 'beto@example.test', NOW)).rejects.toMatchObject({
      response: { code: 'INVITATION_NOT_SENT' },
    });
    vi.stubEnv('NODE_ENV', 'development');
    const dev = setup();
    await dev.service.invite(actor(), 'beto', 'beto@example.test', NOW);
    expect(dev.email.mock.calls[0]![0].inviteUrl).toMatch(/^http:\/\/localhost:5173\/invitacion\//);
  });
});

describe('AccountInvitationsService.invite: acceso compartido', () => {
  // Negocio recién creado: nadie tiene cuenta personal todavía.
  const fresh = (extra: Row[] = []) => ({ accounts: extra, invitations: [] as Row[] });
  const shared = { id: 'sh', memberId: null, username: 'compartido', contextId: CONTEXT };

  it('puede invitar al socio elegido cuando el negocio aún no tiene cuentas personales, y queda anotado', async () => {
    const s = setup(fresh([shared]));
    await expect(s.service.invite(sharedActor('ana'), 'ana', 'ana@example.test', NOW)).resolves.toMatchObject({ ok: true });
    expect(s.invitations.rows[0]).toMatchObject({ memberId: 'ana', invitedByMemberId: 'ana', invitedViaSharedLogin: true });
  });

  it('no puede invitar a otro socio aunque no haya cuentas personales', async () => {
    const s = setup(fresh([shared]));
    const error = await s.service.invite(sharedActor('ana'), 'beto', 'beto@example.test', NOW).catch((e) => e);
    expect(error.getStatus()).toBe(403);
    expect(error.getResponse()).toEqual({
      code: 'INVITATION_SHARED_SELF_ONLY',
      message: 'Con el acceso compartido solo puedes invitar al socio que elegiste en este momento.',
    });
    expect(s.invitations.rows).toHaveLength(0);
    expect(s.email).not.toHaveBeenCalled();
  });

  it('si ya hay una cuenta personal, no invita a nadie, ni a sí mismo, y explica qué hacer', async () => {
    const s = setup(fresh([shared, { id: 'p1', memberId: 'ana', username: 'ana@example.test', contextId: CONTEXT }]));
    for (const target of ['ana', 'beto']) {
      const error = await s.service.invite(sharedActor('beto'), target, `${target}@example.test`, NOW).catch((e) => e);
      expect(error.getStatus()).toBe(403);
      expect(error.getResponse()).toEqual({
        code: 'INVITATION_SHARED_BLOCKED',
        message: 'Tu acceso es compartido y ya hay cuentas personales. Pídele a un socio con cuenta personal que te invite.',
      });
    }
    expect(s.invitations.rows).toHaveLength(0);
  });

  it('una cuenta personal sí invita a otros socios sin cuenta, y no queda anotada como compartida', async () => {
    const s = setup(fresh([{ id: 'p1', memberId: 'ana', username: 'ana@example.test', contextId: CONTEXT }]));
    await s.service.invite(actor('ana'), 'beto', 'beto@example.test', NOW);
    expect(s.invitations.rows[0]!.invitedViaSharedLogin).toBe(false);
  });

  it('solo cuentan las cuentas personales de socios activos: la de un colaborador o de un socio dado de baja no bloquea', async () => {
    const s = setup({
      accounts: [
        shared,
        { id: 'c1', memberId: 'carla', username: 'carla@example.test', contextId: CONTEXT },
        { id: 'd1', memberId: 'dani', username: 'dani@example.test', contextId: CONTEXT },
      ],
      members: [
        { id: 'ana', name: 'Ana', role: 'socio', active: true, contextId: CONTEXT, createdAt: 1 },
        { id: 'carla', name: 'Carla', role: 'colaborador', active: true, contextId: CONTEXT, createdAt: 2 },
        { id: 'dani', name: 'Dani', role: 'socio', active: false, contextId: CONTEXT, createdAt: 3 },
      ],
    });
    await expect(s.service.invite(sharedActor('ana'), 'ana', 'ana@example.test', NOW)).resolves.toMatchObject({ ok: true });
  });

  it('una cuenta personal de otro negocio no cuenta', async () => {
    const s = setup(fresh([shared, { id: 'x', memberId: 'ana', username: 'x@example.test', contextId: 'otro' }]));
    await expect(s.service.invite(sharedActor('ana'), 'ana', 'ana@example.test', NOW)).resolves.toMatchObject({ ok: true });
  });

  it('un socio que ya tiene cuenta personal sigue sin poder ser invitado (409) por una cuenta personal', async () => {
    const s = setup(fresh([{ id: 'p1', memberId: 'ana', username: 'ana@example.test', contextId: CONTEXT }, { id: 'p2', memberId: 'beto', username: 'beto@example.test', contextId: CONTEXT }]));
    await expect(s.service.invite(actor('ana'), 'beto', 'otro@example.test', NOW)).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('AccountInvitationsService.status: quién puede invitar a quién', () => {
  const personal = (memberId: string) => ({ id: `p-${memberId}`, memberId, username: `${memberId}@example.test`, contextId: CONTEXT });
  const rowOf = (list: Awaited<ReturnType<AccountInvitationsService['status']>>, id: string) => list.find((r) => r.memberId === id)!;

  it('una cuenta personal puede invitar a todo socio sin cuenta; a quien ya tiene no hay nada que invitar', async () => {
    const s = setup({ accounts: [personal('ana')] });
    const list = await s.service.status(actor('ana'), NOW);
    expect(rowOf(list, 'ana').invite).toEqual({ allowed: false, reason: null });
    expect(rowOf(list, 'beto').invite).toEqual({ allowed: true, reason: null });
  });

  it('el acceso compartido sin cuentas personales solo puede invitar al socio elegido; los demás explican por qué no', async () => {
    const s = setup({ accounts: [] });
    const list = await s.service.status(sharedActor('ana'), NOW);
    expect(rowOf(list, 'ana').invite).toEqual({ allowed: true, reason: null });
    expect(rowOf(list, 'beto').invite).toEqual({
      allowed: false,
      reason: 'Con el acceso compartido solo puedes invitar al socio que elegiste en este momento.',
    });
  });

  it('el acceso compartido con cuentas personales no puede invitar a nadie y se lo explica en cada fila', async () => {
    const s = setup({ accounts: [personal('ana')] });
    const list = await s.service.status(sharedActor('beto'), NOW);
    expect(rowOf(list, 'beto').invite).toEqual({
      allowed: false,
      reason: 'Tu acceso es compartido y ya hay cuentas personales. Pídele a un socio con cuenta personal que te invite.',
    });
  });
});

describe('AccountInvitationsService.status', () => {
  it('muestra quién tiene cuenta, quién tiene invitación vigente y cuántos envíos quedan', async () => {
    const s = setup();
    await s.service.invite(actor(), 'beto', 'beto@example.test', NOW);
    const later = new Date(NOW.getTime() + 5 * MIN);
    const [ana, beto] = await s.service.status(actor(), later);

    expect(ana).toEqual({ memberId: 'ana', name: 'Ana', hasPersonalAccount: true, invite: { allowed: false, reason: null }, invitation: null });
    expect(beto).toEqual({
      memberId: 'beto', name: 'Beto', hasPersonalAccount: false, invite: { allowed: true, reason: null },
      invitation: {
        email: 'beto@example.test', sentAt: NOW.toISOString(), expiresAt: new Date(NOW.getTime() + 72 * HOUR).toISOString(),
        canResendAt: new Date(NOW.getTime() + MIN).toISOString(), resendsLeftToday: 2,
      },
    });
  });

  it('una invitación usada, reemplazada o vencida ya no aparece, y los colaboradores no se listan', async () => {
    const s = setup();
    await s.service.invite(actor(), 'beto', 'beto@example.test', NOW);
    const result = await s.service.status(actor(), new Date(NOW.getTime() + 73 * HOUR));
    expect(result.map((m) => m.memberId)).toEqual(['ana', 'beto']);
    expect(result[1]!.invitation).toBeNull();
    s.invitations.rows[0]!.expiresAt = new Date(NOW.getTime() + 100 * HOUR);
    s.invitations.rows[0]!.supersededAt = NOW;
    expect((await s.service.status(actor(), NOW))[1]!.invitation).toBeNull();
    s.invitations.rows[0]!.supersededAt = null;
    s.invitations.rows[0]!.usedAt = NOW;
    expect((await s.service.status(actor(), NOW))[1]!.invitation).toBeNull();
  });
});

describe('AccountInvitationsService public page', () => {
  const live = async () => {
    const s = setup();
    await s.service.invite(actor(), 'beto', 'beto@example.test', new Date());
    return { s, token: tokenOf(s.email) };
  };
  const invalid = { code: 'INVITATION_INVALID', message: INVITATION_INVALID_MESSAGE };

  it('ver la invitación muestra a quién va dirigida y no consume nada', async () => {
    const { s, token } = await live();
    for (let i = 0; i < 3; i++)
      expect(await s.service.inspect(token, '1.1.1.1')).toEqual({
        memberName: 'Beto', email: 'beto@example.test', expiresAt: expect.any(String),
      });
    expect(s.invitations.rows[0]!.usedAt).toBeUndefined();
  });

  it('crear la contraseña crea la cuenta atada al socio con la contraseña elegida (hasheada) y gasta el enlace', async () => {
    const { s, token } = await live();
    expect(await s.service.accept(token, 'mi-clave-larga-1', '1.1.1.1')).toEqual({ ok: true, email: 'beto@example.test' });
    expect(s.accounts.rows.at(-1)).toMatchObject({ memberId: 'beto', username: 'beto@example.test', passwordHash: 'hashed:mi-clave-larga-1' });
    await expect(s.service.accept(token, 'otra-clave-larga', '1.1.1.1')).rejects.toBeInstanceOf(NotFoundException);
    await expect(s.service.inspect(token, '1.1.1.1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('un enlace desconocido, vencido o reemplazado da siempre la misma respuesta', async () => {
    const { s, token } = await live();
    s.invitations.rows[0]!.expiresAt = new Date(0);
    const errors = [];
    for (const t of ['A'.repeat(43), token]) {
      errors.push(await s.service.inspect(t, '2.2.2.2').catch((e) => e));
      errors.push(await s.service.accept(t, 'mi-clave-larga-1', '2.2.2.2').catch((e) => e));
    }
    for (const error of errors) {
      expect(error).toBeInstanceOf(NotFoundException);
      expect(error.getResponse()).toEqual(invalid);
    }
  });

  it('si la cuenta no se pudo crear (el correo se ocupó), también es el mismo error', async () => {
    const { s, token } = await live();
    const original = (s.service as any).prisma.$queryRaw;
    let calls = 0;
    (s.service as any).prisma.$queryRaw = async (strings: TemplateStringsArray, ...v: unknown[]) =>
      ++calls === 1 ? original(strings, ...v) : [];
    await expect(s.service.accept(token, 'mi-clave-larga-1', '3.3.3.3')).rejects.toMatchObject({ response: invalid });
  });

  it('limita los intentos por enlace (10) y por dirección (120) en 10 minutos', async () => {
    const s = setup();
    const token = 'C'.repeat(43);
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push(await s.service.inspect(token, '4.4.4.4').then(() => 200, (e) => e.getStatus()));
    expect(statuses.slice(0, 10).every((x) => x === 404)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);

    const results: number[] = [];
    for (let i = 0; i < 122; i++)
      results.push(await s.service.inspect(`${String(i).padStart(43, 'D')}`, '5.5.5.5').then(() => 200, (e) => e.getStatus()));
    expect(results.slice(0, 120).every((x) => x === 404)).toBe(true);
    expect(results.slice(120)).toEqual([429, 429]);
    expect(await s.service.inspect('E'.repeat(43), '6.6.6.6').catch((e) => e.getStatus())).toBe(404);
  });
});

describe('invitation controllers', () => {
  it('pasan la petición, el id y el cuerpo al servicio', async () => {
    const calls: unknown[][] = [];
    const record = (name: string) => async (...args: unknown[]) => (calls.push([name, ...args]), name);
    const service = { status: record('status'), invite: record('invite'), inspect: record('inspect'), accept: record('accept') };
    const members = new MemberInvitationsController(service as never);
    const pub = new PublicInvitationsController(service as never);
    const req = { account: {}, selection: {} } as never;
    const web = { headers: {}, socket: { remoteAddress: '9.9.9.9' } } as never;

    expect(await members.status(req)).toBe('status');
    expect(await members.invite(req, 'id-1', { email: 'a@b.co' })).toBe('invite');
    expect(await pub.inspect(web, { token: 't' })).toBe('inspect');
    expect(await pub.accept(web, { token: 't', password: 'p' })).toBe('accept');
    expect(calls).toEqual([
      ['status', req], ['invite', req, 'id-1', 'a@b.co'], ['inspect', 't', '9.9.9.9'], ['accept', 't', 'p', '9.9.9.9'],
    ]);
  });
});

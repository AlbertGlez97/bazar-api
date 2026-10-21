import { describe, expect, it, vi } from 'vitest';
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { CREDENTIALS_EMAIL_TIMEOUT_MS } from '../email/email.service.js';
import {
  MEMBER_CREATE_TRANSACTION_OPTIONS,
  MembersService,
} from './members.service.js';
import type { CreateMemberDto } from './dto/member.dto.js';

// The Resend calls run inside the create transaction and have no abort signal
// in the installed SDK, so EmailService bounds them with its own timer (the
// TOTAL deadline of the direct send plus the approver fallback). It must fire
// first, in a controlled way (rollback and 502), instead of the transaction
// expiring under a pending call. The margin covers the queries and the Argon2
// hash that run before the email is sent. Same rule as the business approval.
describe('member creation transaction', () => {
  it('keeps the credentials email total deadline below the transaction timeout, with a 5 s margin', () => {
    expect(CREDENTIALS_EMAIL_TIMEOUT_MS).toBeLessThan(
      MEMBER_CREATE_TRANSACTION_OPTIONS.timeout,
    );
    expect(
      MEMBER_CREATE_TRANSACTION_OPTIONS.timeout - CREDENTIALS_EMAIL_TIMEOUT_MS,
    ).toBeGreaterThanOrEqual(5_000);
  });
});

/** The Prisma failure of a racing `Account.username` insert (see approve-failures.ts). */
const usernameRace = () =>
  Object.assign(new Error('Unique constraint failed on Account_username_key'), {
    code: 'P2002',
    meta: {
      modelName: 'Account',
      driverAdapterError: {
        cause: { constraint: { index: 'Account_username_key' } },
      },
    },
  });

/** The Prisma failure of a transaction that outlived its timeout. */
const expiredTransaction = () =>
  Object.assign(new Error('Transaction API error: expired transaction'), {
    code: 'P2028',
    meta: { operation: 'commit', timeout: 15_000, timeTaken: 15_100 },
  });

const actor = {
  account: { id: 'account-id', contextId: 'ctx', memberId: null },
  selection: { memberId: 'socio-id', deviceId: 'device-id' },
} as unknown as Parameters<MembersService['create']>[0];

const dto = (overrides: Partial<CreateMemberDto> = {}): CreateMemberDto =>
  ({
    nombre: 'Ana',
    apellidos: 'Nueva',
    correo: 'ana@example.test',
    role: 'colaborador',
    ...overrides,
  }) as CreateMemberDto;

const created = {
  id: 'member-id',
  name: 'Ana Nueva',
  role: 'colaborador' as const,
  active: true,
  commissionRateBps: null,
  createdByMemberId: 'socio-id',
  username: 'ana@example.test',
  credentialsEmail: 'member' as const,
};

/** A transaction stand-in that lets the real `create` logic run, to pin what it stores and refuses. */
function runCreate(opts: { usernameTaken?: string[] } = {}) {
  const members: Record<string, unknown>[] = [];
  const accounts: Record<string, unknown>[] = [];
  const tx = {
    account: {
      findFirst: async () => ({ id: 'account-id' }),
      findUnique: async ({ where }: { where: { username: string } }) =>
        opts.usernameTaken?.includes(where.username) ? { id: 'taken' } : null,
      create: async ({ data }: { data: Record<string, unknown> }) => (accounts.push(data), data),
    },
    member: {
      findFirst: async () => ({ id: 'socio-id', name: 'Socio', role: 'socio', active: true }),
      create: async ({ data }: { data: Record<string, unknown> }) => (members.push(data), data),
    },
    device: { findFirst: async () => ({ id: 'device-id' }) },
  };
  const sendMemberCredentialsEmail = vi.fn().mockResolvedValue({ deliveredTo: 'member' });
  const members$ = new MembersService(
    { $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) } as never,
    { sendMemberCredentialsEmail } as never,
  );
  return { service: members$, members, accounts, sendMemberCredentialsEmail };
}

describe('MembersService.create: the correo', () => {
  it('queda guardado en minúsculas en la persona (para sus aprobaciones) y no sale en la respuesta', async () => {
    const run = runCreate();
    const res = await run.service.create(actor, dto({ correo: '  Ana@Example.TEST ' }));

    expect(run.members[0]).toMatchObject({ name: 'Ana Nueva', correo: 'ana@example.test' });
    expect(run.accounts[0]).toMatchObject({ username: 'ana@example.test' });
    expect(res).not.toHaveProperty('correo');
    expect(run.sendMemberCredentialsEmail).toHaveBeenCalledTimes(1);
  });

  it('un correo que ya es el usuario de alguien da un 409 claro, no crea nada y no manda correo', async () => {
    const run = runCreate({ usernameTaken: ['ana@example.test'] });

    await expect(run.service.create(actor, dto())).rejects.toMatchObject({
      status: 409,
      response: { code: 'MEMBER_EMAIL_IN_USE', message: 'Ese correo ya está en uso. Usa otro correo.' },
    });
    expect(run.members).toEqual([]);
    expect(run.accounts).toEqual([]);
    expect(run.sendMemberCredentialsEmail).not.toHaveBeenCalled();
  });

  it('un correo demasiado largo para ser usuario sigue recibiendo uno inventado y se guarda completo', async () => {
    const long = `a-1@${'b'.repeat(60)}.${'c'.repeat(60)}.example.test`;
    const run = runCreate({ usernameTaken: [long] });
    await run.service.create(actor, dto({ correo: long }));

    expect(run.members[0]).toMatchObject({ correo: long });
    expect(run.accounts[0]!.username).toMatch(/^[a-z0-9-]+-[0-9a-f]{6}$/);
  });
});

describe('MembersService: las respuestas de las rutas de personas no llevan el correo', () => {
  const row = { id: 'm1', name: 'Ana', role: 'colaborador', active: true, contextId: 'ctx', correo: 'ana@example.test' };
  const build = (active: boolean) => {
    const updates: Record<string, unknown>[] = [];
    const tx = {
      $queryRaw: async () => [],
      account: { findFirst: async () => ({ id: 'account-id' }) },
      device: { findFirst: async () => ({ id: 'device-id' }) },
      member: {
        findFirst: async ({ where }: { where: { id: string } }) =>
          where.id === 'm1' ? { ...row, active } : { id: 'socio-id', name: 'Socio', role: 'socio', active: true },
        update: async (args: Record<string, unknown>) => (updates.push(args), { id: 'm1' }),
      },
    };
    const service = new MembersService({ $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) } as never, {} as never);
    return { service, updates };
  };

  it('desactivar y reactivar piden la fila sin correo, y si no hay nada que cambiar la devuelven sin él', async () => {
    const off = build(false);
    expect(await off.service.deactivate(actor, 'm1')).not.toHaveProperty('correo');
    expect(await off.service.reactivate(actor, 'm1')).toEqual({ id: 'm1' });
    expect(off.updates[0]).toMatchObject({ omit: { correo: true } });

    const on = build(true);
    expect(await on.service.reactivate(actor, 'm1')).not.toHaveProperty('correo');
    expect(await on.service.deactivate(actor, 'm1')).toEqual({ id: 'm1' });
    expect(on.updates[0]).toMatchObject({ omit: { correo: true } });
  });

  it('editar a una persona pide la fila sin correo', async () => {
    const run = build(true);
    await run.service.patch(actor, 'm1', { name: 'Otro' } as never);
    expect(run.updates[0]).toMatchObject({ omit: { correo: true } });
  });
});

describe('MembersService.create failure handling', () => {
  const service = (transaction: ReturnType<typeof vi.fn>) =>
    new MembersService({ $transaction: transaction } as never, {} as never);

  it('rejects a commission rate for a socio before opening any transaction', async () => {
    const transaction = vi.fn();

    await expect(
      service(transaction).create(actor, dto({ role: 'socio', commissionRateBps: 0 })),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service(transaction).create(actor, dto({ role: 'socio', commissionRateBps: null })),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('rejects a correo the credentials email could not go to before opening any transaction', async () => {
    const transaction = vi.fn();

    await expect(
      service(transaction).create(actor, dto({ correo: "o'brien@example.test" })),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('retries a lost username race with a fresh transaction and succeeds', async () => {
    const transaction = vi
      .fn()
      .mockRejectedValueOnce(usernameRace())
      .mockRejectedValueOnce(usernameRace())
      .mockResolvedValueOnce(created);

    await expect(service(transaction).create(actor, dto())).resolves.toEqual(created);
    expect(transaction).toHaveBeenCalledTimes(3);
  });

  it('answers 409 when the username race is lost on every attempt', async () => {
    const transaction = vi.fn().mockRejectedValue(usernameRace());

    await expect(service(transaction).create(actor, dto())).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(transaction).toHaveBeenCalledTimes(3);
  });

  it('answers a clear 409 when another person has the correo, and does not retry', async () => {
    const taken = Object.assign(new Error('Unique constraint failed on Member_correo_key'), {
      code: 'P2002',
      meta: { modelName: 'Member', driverAdapterError: { cause: { constraint: { index: 'Member_correo_key' } } } },
    });
    const transaction = vi.fn().mockRejectedValue(taken);

    await expect(service(transaction).create(actor, dto())).rejects.toMatchObject({
      status: 409,
      response: { code: 'MEMBER_EMAIL_IN_USE', message: 'Ese correo ya está en uso. Usa otro correo.' },
    });
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it('answers 502 when the transaction expires, and does not retry', async () => {
    const transaction = vi.fn().mockRejectedValue(expiredTransaction());

    await expect(service(transaction).create(actor, dto())).rejects.toBeInstanceOf(
      BadGatewayException,
    );
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it('lets any other failure through untouched, without retrying', async () => {
    const boom = new Error('database is down');
    const transaction = vi.fn().mockRejectedValue(boom);

    await expect(service(transaction).create(actor, dto())).rejects.toBe(boom);
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it('runs the transaction with the documented options', async () => {
    const transaction = vi.fn().mockResolvedValue(created);

    await service(transaction).create(actor, dto());

    expect(transaction.mock.calls[0][1]).toEqual(MEMBER_CREATE_TRANSACTION_OPTIONS);
  });
});

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Test } from '@nestjs/testing';
import { DatabaseModule } from '../src/database/database.module.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { withTestTenant } from './tenant-scope.js';

/**
 * One account per person: the migration ties every unbound account to the
 * founding socio of its business (the oldest socio) and leaves alone, on
 * purpose, the cases that would be a guess. The backfill statements are read
 * from the migration file and run against one business at a time.
 */
const MIGRATION = '20261025120000_one_account_per_person';

describe('migration: one account per person', () => {
  let prisma: PrismaService;
  let close: () => Promise<void>;
  let backfill: string[];
  const contexts: string[] = [];

  const newContext = (label: string) => {
    const contextId = `one-acct-mig-${label}-${randomUUID()}`;
    contexts.push(contextId);
    return contextId;
  };

  const member = (
    contextId: string,
    role: 'socio' | 'colaborador',
    createdAt: string,
  ) =>
    withTestTenant(contextId, () =>
      prisma.member.create({
        data: {
          name: `${role} ${createdAt}`,
          role,
          contextId,
          createdAt: new Date(createdAt),
        },
      }),
    );

  const account = (contextId: string, createdAt: string, memberId?: string) =>
    prisma.account.create({
      data: {
        username: `mig-${randomUUID()}`,
        passwordHash: 'not-a-login-fixture',
        contextId,
        createdAt: new Date(createdAt),
        ...(memberId ? { memberId } : {}),
      },
    });

  const run = (contextId: string) =>
    withTestTenant(contextId, () =>
      prisma.$transaction(async (tx) => {
        for (const statement of backfill) await tx.$executeRawUnsafe(statement);
      }),
    );

  const memberIdOf = async (accountId: string) =>
    (await prisma.account.findUniqueOrThrow({ where: { id: accountId } }))
      .memberId;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [DatabaseModule],
    }).compile();
    prisma = module.get(PrismaService);
    close = () => module.close();
    const sql = readFileSync(
      fileURLToPath(
        new URL(`../prisma/migrations/${MIGRATION}/migration.sql`, import.meta.url),
      ),
      'utf8',
    );
    const body = /-- backfill:begin\r?\n([\s\S]*?)-- backfill:end/.exec(sql)?.[1];
    expect(body).toBeDefined();
    backfill = (body as string)
      .split(/;\r?\n/)
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0);
  });

  afterAll(async () => {
    if (prisma) {
      // Accounts first: Account.memberId is ON DELETE RESTRICT.
      await prisma.account.deleteMany({ where: { contextId: { in: contexts } } });
      for (const contextId of contexts)
        await withTestTenant(contextId, () =>
          prisma.member.deleteMany({ where: { contextId } }),
        );
    }
    await close?.();
  });

  it('ties the unbound account to the oldest socio, not to a colaborador or a newer socio', async () => {
    const contextId = newContext('normal');
    await member(contextId, 'colaborador', '2025-01-01T00:00:00Z');
    const founder = await member(contextId, 'socio', '2026-01-01T00:00:00Z');
    await member(contextId, 'socio', '2026-02-01T00:00:00Z');
    const shared = await account(contextId, '2026-01-02T00:00:00Z');

    await run(contextId);

    expect(await memberIdOf(shared.id)).toBe(founder.id);
  });

  it('leaves an account unbound when the business has no socio', async () => {
    const contextId = newContext('no-socio');
    await member(contextId, 'colaborador', '2026-01-01T00:00:00Z');
    const shared = await account(contextId, '2026-01-02T00:00:00Z');

    await run(contextId);

    expect(await memberIdOf(shared.id)).toBeNull();
  });

  it('leaves the shared account unbound when the founder already has an account', async () => {
    const contextId = newContext('founder-has-account');
    const founder = await member(contextId, 'socio', '2026-01-01T00:00:00Z');
    const own = await account(contextId, '2026-01-02T00:00:00Z', founder.id);
    const shared = await account(contextId, '2026-01-03T00:00:00Z');

    await run(contextId);

    expect(await memberIdOf(own.id)).toBe(founder.id);
    expect(await memberIdOf(shared.id)).toBeNull();
  });

  it('ties only the oldest of several unbound accounts of one business', async () => {
    const contextId = newContext('two-unbound');
    const founder = await member(contextId, 'socio', '2026-01-01T00:00:00Z');
    const older = await account(contextId, '2026-01-02T00:00:00Z');
    const newer = await account(contextId, '2026-03-01T00:00:00Z');

    await run(contextId);

    expect(await memberIdOf(older.id)).toBe(founder.id);
    expect(await memberIdOf(newer.id)).toBeNull();
  });

  it('does not touch an account that is already tied to a person', async () => {
    const contextId = newContext('already-tied');
    await member(contextId, 'socio', '2026-01-01T00:00:00Z');
    const colaborador = await member(contextId, 'colaborador', '2026-01-02T00:00:00Z');
    const own = await account(contextId, '2026-01-03T00:00:00Z', colaborador.id);

    await run(contextId);

    expect(await memberIdOf(own.id)).toBe(colaborador.id);
  });

  it('is safe to run twice', async () => {
    const contextId = newContext('twice');
    const founder = await member(contextId, 'socio', '2026-01-01T00:00:00Z');
    const shared = await account(contextId, '2026-01-02T00:00:00Z');

    await run(contextId);
    await run(contextId);

    expect(await memberIdOf(shared.id)).toBe(founder.id);
  });
});

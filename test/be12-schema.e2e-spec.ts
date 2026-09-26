import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Test } from '@nestjs/testing';
import { DatabaseModule } from '../src/database/database.module.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { withTestTenant } from './tenant-scope.js';

/**
 * BE-12 (task T1): the schema that team management and device management
 * with one-time activation build on. Nothing here exercises an endpoint:
 * the endpoints arrive in later tasks. This spec pins the columns,
 * constraints, defaults and the legacy backfill so those tasks can rely on
 * them.
 */
const MIGRATION = '20260925120000_be12_team_devices';

describe('BE-12 schema: team and device management columns', () => {
  let prisma: PrismaService;
  let close: () => Promise<void>;

  const accountIds: string[] = [];
  const contexts: string[] = [];

  const newContext = (label: string) => {
    const contextId = `be12-schema-${label}-${randomUUID()}`;
    contexts.push(contextId);
    return contextId;
  };

  const newAccount = async (contextId: string, memberId?: string) => {
    const account = await prisma.account.create({
      data: {
        username: `be12-${randomUUID()}`,
        passwordHash: 'not-a-login-fixture',
        contextId,
        ...(memberId ? { memberId } : {}),
      },
    });
    accountIds.push(account.id);
    return account;
  };

  const column = (table: string, name: string) =>
    prisma.$queryRaw<
      Array<{
        is_nullable: string;
        udt_name: string;
        column_default: string | null;
      }>
    >`SELECT is_nullable, udt_name, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ${table} AND column_name = ${name}`;

  const constraint = (name: string) =>
    prisma.$queryRaw<Array<{ deleteRule: string; definition: string }>>`
      SELECT confdeltype::text AS "deleteRule", pg_get_constraintdef(oid) AS definition
      FROM pg_constraint WHERE conname = ${name}`;

  const index = (name: string) =>
    prisma.$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = ${name}`;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [DatabaseModule],
    }).compile();
    prisma = module.get(PrismaService);
    await module.init();
    close = () => module.close();
  });

  afterAll(async () => {
    // Accounts first: Account.memberId is ON DELETE RESTRICT, so a bound
    // Member cannot be removed while its Account still points at it.
    await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
    for (const contextId of contexts) {
      await withTestTenant(contextId, async () => {
        await prisma.member.deleteMany({});
        await prisma.device.deleteMany({});
      });
    }
    await close();
  });

  describe('catalog', () => {
    it('Account.memberId is a nullable uuid with a unique index and a RESTRICT foreign key to Member', async () => {
      expect(await column('Account', 'memberId')).toEqual([
        { is_nullable: 'YES', udt_name: 'uuid', column_default: null },
      ]);
      const [unique] = await index('Account_memberId_key');
      expect(unique?.indexdef).toMatch(/CREATE UNIQUE INDEX .* \("memberId"\)/);
      const [fk] = await constraint('Account_memberId_fkey');
      expect(fk?.deleteRule).toBe('r');
      expect(fk?.definition).toMatch(/REFERENCES "Member"\(id\)/);
    });

    it('Member.createdByMemberId is a nullable, indexed uuid with a SET NULL self foreign key', async () => {
      expect(await column('Member', 'createdByMemberId')).toEqual([
        { is_nullable: 'YES', udt_name: 'uuid', column_default: null },
      ]);
      expect((await index('Member_createdByMemberId_idx')).length).toBe(1);
      const [fk] = await constraint('Member_createdByMemberId_fkey');
      expect(fk?.deleteRule).toBe('n');
      expect(fk?.definition).toMatch(/REFERENCES "Member"\(id\)/);
    });

    it('DeviceStatus has the three lifecycle values, in order', async () => {
      const labels = await prisma.$queryRaw<Array<{ enumlabel: string }>>`
        SELECT e.enumlabel FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'DeviceStatus' ORDER BY e.enumsortorder`;
      expect(labels.map((row) => row.enumlabel)).toEqual([
        'pendiente_activacion',
        'activo',
        'revocado',
      ]);
    });

    it('Device.status is NOT NULL and defaults to activo; the token and timestamps are nullable', async () => {
      const [status] = await column('Device', 'status');
      expect(status?.is_nullable).toBe('NO');
      expect(status?.udt_name).toBe('DeviceStatus');
      expect(status?.column_default).toMatch(/'activo'/);
      expect(await column('Device', 'tokenHash')).toEqual([
        { is_nullable: 'YES', udt_name: 'text', column_default: null },
      ]);
      for (const name of ['activatedAt', 'revokedAt']) {
        expect(await column('Device', name)).toEqual([
          { is_nullable: 'YES', udt_name: 'timestamptz', column_default: null },
        ]);
      }
    });

    it('keeps Device_identifier_key, `authorized`, and FORCE row level security on Device', async () => {
      expect((await index('Device_identifier_key')).length).toBe(1);
      expect((await column('Device', 'authorized'))[0]?.is_nullable).toBe('NO');
      const [rls] = await prisma.$queryRaw<
        Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>
      >`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = '"Device"'::regclass`;
      expect(rls).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    });

    it('Account is still not under row level security', async () => {
      const [rls] = await prisma.$queryRaw<
        Array<{ relrowsecurity: boolean }>
      >`SELECT relrowsecurity FROM pg_class WHERE oid = '"Account"'::regclass`;
      expect(rls?.relrowsecurity).toBe(false);
    });
  });

  describe('Account.memberId', () => {
    it('is optional: an account without a member is the legacy shared login', async () => {
      const account = await newAccount(newContext('acc-null'));
      expect(account.memberId).toBeNull();
    });

    it('binds an account to one member and refuses a second account for the same member', async () => {
      const contextId = newContext('acc-unique');
      const member = await withTestTenant(contextId, () =>
        prisma.member.create({ data: { name: 'Bound', contextId } }),
      );
      const bound = await newAccount(contextId, member.id);
      expect(bound.memberId).toBe(member.id);
      await expect(newAccount(contextId, member.id)).rejects.toMatchObject({
        code: 'P2002',
      });
    });

    it('refuses a member that does not exist', async () => {
      await expect(
        newAccount(newContext('acc-fk'), randomUUID()),
      ).rejects.toMatchObject({ code: 'P2003' });
    });

    it('refuses to delete a member that still has a bound account (never silently unbinds it)', async () => {
      const contextId = newContext('acc-restrict');
      const member = await withTestTenant(contextId, () =>
        prisma.member.create({ data: { name: 'Protected', contextId } }),
      );
      await newAccount(contextId, member.id);
      await expect(
        withTestTenant(contextId, () =>
          prisma.member.delete({ where: { id: member.id } }),
        ),
      ).rejects.toMatchObject({ code: 'P2003' });
    });
  });

  describe('Member.createdByMemberId', () => {
    it('is null for members that nobody created (seed and legacy rows)', async () => {
      const contextId = newContext('mem-null');
      const member = await withTestTenant(contextId, () =>
        prisma.member.create({ data: { name: 'Founder', contextId } }),
      );
      expect(member.createdByMemberId).toBeNull();
    });

    it('records the creator and refuses one that does not exist', async () => {
      const contextId = newContext('mem-fk');
      const creator = await withTestTenant(contextId, () =>
        prisma.member.create({
          data: { name: 'Creator', role: 'socio', contextId },
        }),
      );
      const created = await withTestTenant(contextId, () =>
        prisma.member.create({
          data: { name: 'Created', contextId, createdByMemberId: creator.id },
        }),
      );
      expect(created.createdByMemberId).toBe(creator.id);
      await expect(
        withTestTenant(contextId, () =>
          prisma.member.create({
            data: { name: 'Orphan', contextId, createdByMemberId: randomUUID() },
          }),
        ),
      ).rejects.toMatchObject({ code: 'P2003' });
    });

    it('drops only the attribution when the creator row is removed', async () => {
      const contextId = newContext('mem-setnull');
      const creator = await withTestTenant(contextId, () =>
        prisma.member.create({
          data: { name: 'Creator', role: 'socio', contextId },
        }),
      );
      const created = await withTestTenant(contextId, () =>
        prisma.member.create({
          data: { name: 'Created', contextId, createdByMemberId: creator.id },
        }),
      );
      await withTestTenant(contextId, () =>
        prisma.member.delete({ where: { id: creator.id } }),
      );
      const after = await withTestTenant(contextId, () =>
        prisma.member.findUnique({ where: { id: created.id } }),
      );
      expect(after).not.toBeNull();
      expect(after?.createdByMemberId).toBeNull();
    });
  });

  describe('Device lifecycle columns', () => {
    it('a device created the way every existing fixture and the seed do is an active legacy device (no token)', async () => {
      const contextId = newContext('dev-default');
      const device = await withTestTenant(contextId, () =>
        prisma.device.create({
          data: {
            name: 'Legacy tablet',
            identifier: randomUUID(),
            contextId,
            authorized: true,
          },
        }),
      );
      expect(device).toMatchObject({
        status: 'activo',
        tokenHash: null,
        activatedAt: null,
        revokedAt: null,
      });
    });

    it('accepts every lifecycle status and stores the token hash and timestamps', async () => {
      const contextId = newContext('dev-status');
      const at = new Date('2026-09-25T12:00:00.000Z');
      const device = await withTestTenant(contextId, () =>
        prisma.device.create({
          data: {
            name: 'Pending tablet',
            identifier: randomUUID(),
            contextId,
            status: 'pendiente_activacion',
            tokenHash: 'a'.repeat(64),
            activatedAt: at,
            revokedAt: at,
          },
        }),
      );
      expect(device.status).toBe('pendiente_activacion');
      expect(device.authorized).toBe(false);
      expect(device.tokenHash).toBe('a'.repeat(64));
      expect(device.activatedAt).toEqual(at);
      expect(device.revokedAt).toEqual(at);
    });
  });

  describe('legacy backfill', () => {
    // The migration marks the rows that are unauthorized today as revoked.
    // The statement lives between two marker comments in the migration file;
    // this test runs that exact SQL, as the runtime role and under row level
    // security, against fixture rows in their pre-migration state (status =
    // the column default, revokedAt = null).
    it('marks unauthorized devices revoked, leaves authorized ones active, and never invents a token', async () => {
      const sql = readFileSync(
        fileURLToPath(
          new URL(`../prisma/migrations/${MIGRATION}/migration.sql`, import.meta.url),
        ),
        'utf8',
      );
      const backfill = /-- backfill:begin\r?\n([\s\S]*?)-- backfill:end/.exec(sql)?.[1];
      expect(backfill).toBeDefined();

      const contextId = newContext('backfill');
      const [authorized, unauthorized] = await withTestTenant(
        contextId,
        async () =>
          Promise.all([
            prisma.device.create({
              data: {
                name: 'Authorized',
                identifier: randomUUID(),
                contextId,
                authorized: true,
              },
            }),
            prisma.device.create({
              data: {
                name: 'Unauthorized',
                identifier: randomUUID(),
                contextId,
                authorized: false,
              },
            }),
          ]),
      );
      expect(unauthorized?.status).toBe('activo');

      await withTestTenant(contextId, () =>
        prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(backfill as string);
        }),
      );

      const [afterAuthorized, afterUnauthorized] = await withTestTenant(
        contextId,
        () =>
          Promise.all([
            prisma.device.findUnique({ where: { id: authorized?.id } }),
            prisma.device.findUnique({ where: { id: unauthorized?.id } }),
          ]),
      );
      expect(afterAuthorized).toMatchObject({
        status: 'activo',
        revokedAt: null,
        tokenHash: null,
      });
      expect(afterUnauthorized).toMatchObject({
        status: 'revocado',
        tokenHash: null,
      });
      expect(afterUnauthorized?.revokedAt).toBeInstanceOf(Date);
    });
  });
});

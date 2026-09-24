import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { assertRlsEnforcingRole } from '../src/database/rls-role-guard.js';
import { selectTestMigrationDatabase } from '../scripts/test-environment.js';

/**
 * Runtime database role (BE-11 follow-up): Postgres never applies RLS to a
 * SUPERUSER or BYPASSRLS role, so the app, the seed and these tests must
 * connect as a least-privileged role. See doc/runtime-database-role.md.
 */
describe('runtime database role', () => {
  let prisma: PrismaService;

  beforeAll(() => {
    prisma = new PrismaService();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('is neither superuser nor BYPASSRLS', async () => {
    const rows = await prisma.$queryRaw<
      Array<{ rolsuper: boolean; rolbypassrls: boolean }>
    >`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    expect(rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });

  it('passes the startup guard (onModuleInit)', async () => {
    await expect(prisma.onModuleInit()).resolves.toBeUndefined();
  });

  // The owner URL is only exercised when the environment really provides it
  // (DATABASE_URL_TEST_MIGRATE); no owner URL is ever fabricated here.
  const ownerUrl = process.env.DATABASE_URL_TEST_MIGRATE;
  it.skipIf(!ownerUrl)(
    'the startup guard rejects the owner/migrator connection',
    async () => {
      const owner = new PrismaClient({
        adapter: new PrismaPg({
          connectionString: selectTestMigrationDatabase(process.env),
        }),
      });
      try {
        await expect(assertRlsEnforcingRole(owner)).rejects.toThrow(
          /Refusing to start.*(SUPERUSER|BYPASSRLS)/s,
        );
      } finally {
        await owner.$disconnect();
      }
    },
  );

  it('cannot run DDL', async () => {
    await expect(
      prisma.$executeRawUnsafe(
        'CREATE TABLE "runtime_role_ddl_probe" (id int)',
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('cannot read the Prisma migrations table', async () => {
    await expect(
      prisma.$queryRawUnsafe('SELECT * FROM "_prisma_migrations" LIMIT 1'),
    ).rejects.toThrow(/permission denied/i);
  });
});

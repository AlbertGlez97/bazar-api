import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { DatabaseModule } from '../src/database/database.module.js';
import { PrismaService } from '../src/database/prisma.service.js';

describe('PostgreSQL infrastructure', () => {
  it('connects, exposes all five tables, writes only a test marker and disconnects', async () => {
    const app = await Test.createTestingModule({
      imports: [DatabaseModule],
    }).compile();
    const prisma = app.get(PrismaService);
    await app.init();
    const id = randomUUID();
    try {
      expect(await prisma.$queryRaw`SELECT current_database() AS name`).toEqual(
        [{ name: 'bazar_test' }],
      );
      const tables = await prisma.$queryRaw<
        Array<{ tablename: string }>
      >`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`;
      expect(tables.map((table) => table.tablename)).toEqual(
        expect.arrayContaining([
          'Member',
          'Device',
          'Product',
          'Sale',
          'SaleItem',
        ]),
      );
      await prisma.member.create({
        data: { id, name: 'BE02 isolation smoke' },
      });
      expect(await prisma.member.findUnique({ where: { id } })).not.toBeNull();
    } finally {
      await prisma.member.deleteMany({ where: { id } });
      await app.close();
    }
  });
});

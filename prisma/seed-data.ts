import { argon2id, hash } from 'argon2';
import type { PrismaClient } from '../src/generated/prisma/client.js';

export async function seedContext(
  prisma: PrismaClient,
  options: {
    contextId: string;
    username: string;
    password: string;
  },
) {
  if (
    !options.contextId ||
    options.contextId === 'legacy-unassigned' ||
    !options.username ||
    options.password.length < 12
  ) {
    throw new Error(
      'Seed requires context, username and a password of at least 12 characters',
    );
  }
  const existing = await prisma.account.findUnique({
    where: { username: options.username },
  });
  if (existing && existing.contextId !== options.contextId) {
    throw new Error('Seed username already belongs to another context');
  }
  const passwordHash =
    existing?.passwordHash ??
    (await hash(options.password, { type: argon2id }));
  await prisma.$transaction(async (tx) => {
    const account = await tx.account.upsert({
      where: { username: options.username },
      update: {},
      create: {
        username: options.username,
        passwordHash,
        contextId: options.contextId,
      },
    });
    if (account.contextId !== options.contextId)
      throw new Error('Seed account context mismatch');
    for (const [id, name] of [
      ['bf030001-0000-4000-8000-000000000001', 'Alberto'],
      ['bf030001-0000-4000-8000-000000000002', 'Adid'],
    ]) {
      const member = await tx.member.findUnique({ where: { id } });
      if (member && member.contextId !== options.contextId)
        throw new Error('Seed member context mismatch');
      const result = await tx.member.upsert({
        where: { id },
        update: {},
        create: { id, name, role: 'socio', contextId: options.contextId },
      });
      if (result.contextId !== options.contextId)
        throw new Error('Seed member context mismatch');
    }
    for (const [identifier, name] of [
      ['shared-tablet', 'Shared tablet'],
      ['alberto-backup-phone', 'Alberto backup phone'],
      ['adid-backup-phone', 'Adid backup phone'],
    ]) {
      const device = await tx.device.findUnique({ where: { identifier } });
      if (device && device.contextId !== options.contextId)
        throw new Error('Seed device context mismatch');
      const result = await tx.device.upsert({
        where: { identifier },
        update: {},
        create: {
          identifier,
          name,
          contextId: options.contextId,
          authorized: true,
        },
      });
      if (result.contextId !== options.contextId)
        throw new Error('Seed device context mismatch');
    }
  });
}

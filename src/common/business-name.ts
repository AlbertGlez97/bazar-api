import type { PrismaService } from '../database/prisma.service.js';

/** The name the business gave when it registered, for emails; null if it cannot be found. */
export async function businessNameOf(
  prisma: Pick<PrismaService, '$queryRaw'>,
  contextId: string,
): Promise<string | null> {
  const rows = await prisma.$queryRaw<{ name: string | null }[]>`
    SELECT "nombreNegocio" AS name FROM "BusinessRegistrationRequest"
    WHERE "createdContextId" = ${contextId} ORDER BY "createdAt" DESC LIMIT 1`;
  return rows[0]?.name ?? null;
}

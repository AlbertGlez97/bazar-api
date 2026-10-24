import type { PrismaService } from '../database/prisma.service.js';

/**
 * Resolves whether the person of the logged-in account is an active socio of
 * `contextId`. Used by read-only listing endpoints (`GET /products`,
 * `GET /members`) that do not require a full {@link ContextGuard}/
 * {@link SocioGuard} selection (no device is needed to browse), but still
 * gate a higher-privilege query parameter (`includeInactive`) and the
 * purchase cost to socios only.
 *
 * Every account belongs to one person, so the person is `account.memberId`
 * and nothing the client sends. The `x-member-id` header plays no part.
 *
 * @returns `false` (never throws) for an account with no person, a person of
 * another context, a non-socio or a deactivated one. The caller silently
 * falls back to the safe default: what is usually just a stale query
 * parameter is not worth an error.
 */
export async function isRequestingSocio(
  prisma: PrismaService,
  contextId: string,
  accountMemberId: string | null,
): Promise<boolean> {
  if (accountMemberId === null) return false;
  const member = await prisma.member.findFirst({
    where: {
      id: accountMemberId,
      contextId,
      role: 'socio',
      active: true,
    },
  });
  return Boolean(member);
}

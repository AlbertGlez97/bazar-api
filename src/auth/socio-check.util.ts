import { isUUID } from 'class-validator';
import type { PrismaService } from '../database/prisma.service.js';

/**
 * The single definition of "this login is bound to a Member" (BE-12). Both
 * enforcement points, {@link ContextGuard} and {@link isRequestingSocio},
 * use it so the rule cannot drift between them: only `null`/`undefined`
 * means the shared business login that may select any Member of its context.
 */
export function isBoundToMember(
  accountMemberId: string | null | undefined,
): accountMemberId is string {
  return accountMemberId != null;
}

/**
 * Resolves whether an optionally-supplied `x-member-id` actually belongs to
 * an active socio in `contextId` — used by read-only listing endpoints
 * (`GET /products`, `GET /members`) that intentionally do not require a
 * full {@link ContextGuard}/{@link SocioGuard} selection (both are used
 * *before* a Member has necessarily been selected, e.g. to populate the
 * person selector itself), but still need to gate a specific,
 * higher-privilege query parameter (`includeInactive`) to socios only.
 *
 * Deliberately does not check `x-device-id`/device authorization: this is
 * a read-only convenience check, not an action being attributed to a
 * device, so requiring a full device selection for it would be
 * disproportionate.
 *
 * BE-12: when the login is bound to a Member (`accountMemberId` not null) it
 * may only act as that Member, exactly as {@link ContextGuard} enforces. A
 * candidate that differs from the bound Member is not honored, so a
 * colaborador's own login cannot name a socio's id to list inactive rows.
 * The shared business login (`accountMemberId` null) keeps choosing any
 * Member of its context. The argument is required on purpose: a caller that
 * forgets it must fail to compile instead of silently behaving as a shared
 * login.
 *
 * @returns `false` (never throws) for a missing, malformed, foreign-
 * context, non-socio or deactivated candidate, or one that differs from the
 * account's bound Member — the caller is expected to
 * silently fall back to the safe default rather than surface an error for
 * what is usually just a stale or accidental query parameter, not a
 * malicious request.
 */
export async function isRequestingSocio(
  prisma: PrismaService,
  contextId: string,
  candidateMemberId: string | undefined,
  accountMemberId: string | null,
): Promise<boolean> {
  if (!candidateMemberId || !isUUID(candidateMemberId)) return false;
  if (isBoundToMember(accountMemberId) && accountMemberId !== candidateMemberId)
    return false;
  const member = await prisma.member.findFirst({
    where: {
      id: candidateMemberId,
      contextId,
      role: 'socio',
      active: true,
    },
  });
  return Boolean(member);
}

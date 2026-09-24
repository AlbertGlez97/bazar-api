import { isUUID } from 'class-validator';
import type { PrismaService } from '../database/prisma.service.js';

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
 * @returns `false` (never throws) for a missing, malformed, foreign-
 * context, non-socio or deactivated candidate — the caller is expected to
 * silently fall back to the safe default rather than surface an error for
 * what is usually just a stale or accidental query parameter, not a
 * malicious request.
 */
export async function isRequestingSocio(
  prisma: PrismaService,
  contextId: string,
  candidateMemberId: string | undefined,
): Promise<boolean> {
  if (!candidateMemberId || !isUUID(candidateMemberId)) return false;
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

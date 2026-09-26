import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { isUUID } from 'class-validator';
import { verifyDeviceToken } from '../common/device-secret.js';
import { PrismaService } from '../database/prisma.service.js';
import { AuthGuard, type AuthenticatedRequest } from './auth.guard.js';
import { isBoundToMember } from './socio-check.util.js';

/**
 * Establishes *who is attending the sale* and *from which device*, on top
 * of {@link AuthGuard}'s account-level authentication.
 *
 * The tablet/phones are shared among socios and colaboradores; a single
 * account login does not identify the person at the counter. The frontend
 * lets that person pick themselves from a quick selector — no per-sale PIN
 * or re-authentication — but the backend must still verify that selection
 * is legitimate rather than trusting whatever `x-member-id`/`x-device-id`
 * the client happens to send. This guard re-validates, per request, that:
 * - the account has a Member and a Device with those ids, and
 * - both belong to the *same* authenticated `contextId` (bazar/tenant),
 *   preventing one account from attributing actions to a member or device
 *   that belongs to a different context, and
 * - the device is `authorized`, so revoking a lost/compromised device takes
 *   effect immediately even if its identifier is still known, and
 * - (BE-12) an account bound to a Member (`account.memberId`) selects only
 *   that Member, and a device that carries a token hash presents the
 *   matching `x-device-token`. The shared business login (no bound Member)
 *   and legacy devices (no token hash) behave exactly as before.
 *
 * On success it attaches `request.selection`, which downstream services
 * (e.g. product audits, sales attribution) treat as the source of truth for
 * "who/what performed this action" — not any member/device id a client may
 * additionally send in a request body.
 *
 * The Member lookup also requires `active: true` (BE-10): a deactivated
 * colaborador/socio can no longer be selected as the acting person at the
 * counter — this is the actual enforcement point for "an inactive Member
 * cannot authenticate," since this app has no per-Member login, only this
 * per-request shared-tablet selection on top of the per-Account JWT.
 */
@Injectable()
export class ContextGuard implements CanActivate {
  constructor(
    @Inject(AuthGuard) private readonly auth: AuthGuard,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext) {
    await this.auth.canActivate(context);
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const memberId = request.headers['x-member-id'];
    const deviceId = request.headers['x-device-id'];
    if (
      typeof memberId !== 'string' ||
      typeof deviceId !== 'string' ||
      !isUUID(memberId) ||
      !isUUID(deviceId)
    ) {
      throw new ForbiddenException(
        'Valid member and device selection required',
      );
    }
    // Every refusal below shares this one message, so a caller cannot tell
    // which part of the selection failed.
    const refuse = () =>
      new ForbiddenException('Selection is not authorized for this context');
    const { contextId, memberId: boundMemberId } = request.account;
    // A login bound to a Member may only act as that Member. Without this,
    // a colaborador's own login could name a socio's id and act as the socio.
    if (isBoundToMember(boundMemberId) && boundMemberId !== memberId)
      throw refuse();
    const [member, device] = await Promise.all([
      this.prisma.member.findFirst({
        where: { id: memberId, contextId, active: true },
      }),
      this.prisma.device.findFirst({
        where: { id: deviceId, contextId, authorized: true },
      }),
    ]);
    if (!member || !device) throw refuse();
    // A device activated through the one-time flow carries a token hash and
    // must present the matching secret. A device with no hash is LEGACY
    // (seeded, or created before BE-12) and keeps working with `x-device-id`
    // alone; a token header sent by such a device is ignored. A repeated
    // header reaches Node as one joined string, which never matches.
    if (device.tokenHash !== null) {
      const token = request.headers['x-device-token'];
      if (typeof token !== 'string' || !verifyDeviceToken(token, device.tokenHash))
        throw refuse();
    }
    request.selection = { memberId, deviceId };
    return true;
  }
}

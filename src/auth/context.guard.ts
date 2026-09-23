import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { isUUID } from 'class-validator';
import { PrismaService } from '../database/prisma.service.js';
import { AuthGuard, type AuthenticatedRequest } from './auth.guard.js';

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
 *   effect immediately even if its identifier is still known.
 *
 * On success it attaches `request.selection`, which downstream services
 * (e.g. product audits, sales attribution) treat as the source of truth for
 * "who/what performed this action" — not any member/device id a client may
 * additionally send in a request body.
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
    const contextId = request.account.contextId;
    const [member, device] = await Promise.all([
      this.prisma.member.findFirst({ where: { id: memberId, contextId } }),
      this.prisma.device.findFirst({
        where: { id: deviceId, contextId, authorized: true },
      }),
    ]);
    if (!member || !device)
      throw new ForbiddenException(
        'Selection is not authorized for this context',
      );
    request.selection = { memberId, deviceId };
    return true;
  }
}

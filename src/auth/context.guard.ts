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

/**
 * Establishes *who is acting* and *from which device*, on top of
 * {@link AuthGuard}'s account-level authentication.
 *
 * Every account belongs to exactly one person (`account.memberId`), so the
 * token already identifies the person: the guard takes the Member from the
 * account and from nowhere else. The `x-member-id` header is ignored, which
 * means a client (old or tampered) cannot act as another socio or role.
 *
 * Per request it re-validates that:
 * - the account has a person assigned; an account without one is refused with
 *   a clear message, and
 * - that Member is active and belongs to the account's `contextId`, so a
 *   deactivated person stops working at once, and
 * - the device (`x-device-id`) belongs to the same `contextId` and is
 *   `authorized`, so revoking a lost device takes effect immediately, and
 * - a device that carries a token hash presents the matching
 *   `x-device-token`. A device with no hash is LEGACY (seeded, or created
 *   before BE-12) and keeps working with `x-device-id` alone.
 *
 * On success it attaches `request.selection`, which downstream services
 * (product audits, sales attribution) treat as the source of truth for "who
 * and what performed this action", not any id a client may send in a body.
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
    const { contextId, memberId } = request.account;
    if (memberId === null)
      throw new ForbiddenException('Tu cuenta no tiene una persona asignada');
    const deviceId = request.headers['x-device-id'];
    if (typeof deviceId !== 'string' || !isUUID(deviceId)) {
      throw new ForbiddenException('Valid device selection required');
    }
    // Every refusal below shares this one message, so a caller cannot tell
    // which part of the selection failed.
    const refuse = () =>
      new ForbiddenException('Selection is not authorized for this context');
    const [member, device] = await Promise.all([
      this.prisma.member.findFirst({
        where: { id: memberId, contextId, active: true },
      }),
      this.prisma.device.findFirst({
        where: { id: deviceId, contextId, authorized: true },
      }),
    ]);
    if (!member || !device) throw refuse();
    if (device.tokenHash !== null) {
      const token = request.headers['x-device-token'];
      if (
        typeof token !== 'string' ||
        !verifyDeviceToken(token, device.tokenHash)
      )
        throw refuse();
    }
    request.selection = { memberId, deviceId };
    return true;
  }
}

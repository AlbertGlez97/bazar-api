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

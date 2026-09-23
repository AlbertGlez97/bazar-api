import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { ContextGuard } from '../auth/context.guard.js';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { PrismaService } from '../database/prisma.service.js';

@Injectable()
export class SocioGuard implements CanActivate {
  constructor(
    @Inject(ContextGuard) private readonly context: ContextGuard,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}
  async canActivate(context: ExecutionContext) {
    await this.context.canActivate(context);
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const member = await this.prisma.member.findFirst({
      where: {
        id: request.selection!.memberId,
        contextId: request.account.contextId,
        role: 'socio',
      },
    });
    if (!member)
      throw new ForbiddenException('Only socios may modify products');
    return true;
  }
}

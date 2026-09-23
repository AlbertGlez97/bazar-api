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

/**
 * Restricts an endpoint to the selected Member having `role: 'socio'`.
 *
 * Socios (Alberto and Adid) hold full administrative privileges, including
 * managing the catalog; colaboradores (e.g. occasional family help) may
 * only sell and read the catalog. Product mutations are gated here rather
 * than trusting the account/session alone, because the shared-tablet
 * selection (not a personal login) is what determines the acting role.
 */
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

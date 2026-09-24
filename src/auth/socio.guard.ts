import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { ContextGuard } from './context.guard.js';
import type { AuthenticatedRequest } from './auth.guard.js';
import { PrismaService } from '../database/prisma.service.js';

/**
 * Restricts an endpoint to the selected Member having `role: 'socio'`.
 *
 * Socios (Alberto and Adid) hold full administrative privileges; a
 * colaborador (e.g. occasional family help) may sell and read the catalog
 * but not manage it, view the full sales/movimientos history, or see/
 * resolve incidencias. Originally introduced (BE-04) for product
 * mutations only, and moved here (BE-07) to be shared across products,
 * sales (GET /sales "movimientos") and incidencias, since the rule itself
 * — "only socios" — is identical everywhere it is needed and is not a
 * products-specific concept. Gated here rather than trusting the
 * account/session alone, because the shared-tablet selection (not a
 * personal login) is what determines the acting role.
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
        active: true,
      },
    });
    if (!member)
      throw new ForbiddenException('Only socios may access this resource');
    return true;
  }
}

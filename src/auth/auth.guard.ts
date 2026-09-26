import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { PrismaService } from '../database/prisma.service.js';
import { setActiveContextId } from '../database/tenant-context.js';
import { isUUID } from 'class-validator';

export interface AuthenticatedRequest extends Request {
  /**
   * `memberId` is the Member this login is bound to (BE-12), or `null` for
   * the shared business login every business has today, which may act as any
   * Member of its context. See {@link ContextGuard}.
   */
  account: { id: string; contextId: string; memberId: string | null };
  selection?: { memberId: string; deviceId: string };
}

/**
 * Verifies the bearer JWT identifies an active {@link Account} and attaches
 * it to the request as `request.account`.
 *
 * This only proves *who is logged in*; it does not select *which* Member is
 * attending or *which* Device is in use — the tablet/phone is shared, so a
 * single account session does not identify the socio/colaborador at the
 * counter. That selection is a separate concern handled by
 * {@link ContextGuard}. Endpoints that only need the account (e.g.
 * read-only catalog listing) may use this guard alone.
 *
 * The account is re-read from the database on every request instead of
 * trusting the JWT payload, so revoking or deactivating an account takes
 * effect immediately, even for a still-unexpired token.
 *
 * Also establishes this request's active tenant (BE-11) by recording
 * `account.contextId` into the AsyncLocalStorage-based store that
 * {@link TenantContextMiddleware} already opened for this request, before
 * this guard even ran — every downstream guard/controller/service call
 * that touches a tenant-scoped model (via the Prisma tenant-isolation
 * extension) relies on this having happened. Deliberately done here
 * rather than in the more narrowly-scoped {@link ContextGuard}: several
 * endpoints that only require this guard (`GET /products`, `GET
 * /members`, `POST /devices/identify`) still read/write tenant-scoped
 * models, and would otherwise never have a contextId established.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(JwtService) private readonly jwt: JwtService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const match = /^Bearer ([^\s]+)$/i.exec(
      request.headers.authorization ?? '',
    );
    if (!match) throw new UnauthorizedException();
    let subject: string;
    try {
      const payload = await this.jwt.verifyAsync<{ sub: string }>(match[1]);
      // A forged or malformed subject must fail the same way an unknown one
      // does, so reject it before it ever reaches the database query.
      if (typeof payload.sub !== 'string' || !isUUID(payload.sub))
        throw new Error('Invalid subject');
      subject = payload.sub;
    } catch {
      throw new UnauthorizedException();
    }
    const account = await this.prisma.account.findFirst({
      where: { id: subject, active: true },
      select: { id: true, contextId: true, memberId: true },
    });
    if (!account) throw new UnauthorizedException();
    request.account = account;
    setActiveContextId(account.contextId);
    return true;
  }
}

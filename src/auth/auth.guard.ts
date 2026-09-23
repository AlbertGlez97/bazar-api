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
import { isUUID } from 'class-validator';

export interface AuthenticatedRequest extends Request {
  account: { id: string; contextId: string };
  selection?: { memberId: string; deviceId: string };
}

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
      if (typeof payload.sub !== 'string' || !isUUID(payload.sub))
        throw new Error('Invalid subject');
      subject = payload.sub;
    } catch {
      throw new UnauthorizedException();
    }
    const account = await this.prisma.account.findFirst({
      where: { id: subject, active: true },
      select: { id: true, contextId: true },
    });
    if (!account) throw new UnauthorizedException();
    request.account = account;
    return true;
  }
}

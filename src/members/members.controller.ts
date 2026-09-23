import { Controller, Get, Inject, Req, UseGuards } from '@nestjs/common';
import { AuthGuard, type AuthenticatedRequest } from '../auth/auth.guard.js';
import { PrismaService } from '../database/prisma.service.js';

@Controller('members')
@UseGuards(AuthGuard)
export class MembersController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}
  @Get()
  list(@Req() request: AuthenticatedRequest) {
    return this.prisma.member.findMany({
      where: { contextId: request.account.contextId },
      select: { id: true, name: true, role: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
  }
}

import { Controller, Get, Inject, Req, UseGuards } from '@nestjs/common';
import { AuthGuard, type AuthenticatedRequest } from '../auth/auth.guard.js';
import { PrismaService } from '../database/prisma.service.js';

/**
 * Lists the Members (socios and colaboradores) selectable at the counter
 * for the authenticated account's context.
 *
 * Read-only and available to any authenticated account regardless of role:
 * the shared-tablet person selector needs every eligible member visible,
 * not just socios, so a colaborador can pick themselves before selling.
 */
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

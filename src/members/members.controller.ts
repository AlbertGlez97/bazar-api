import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Req,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthGuard, type AuthenticatedRequest } from '../auth/auth.guard.js';
import { SocioGuard } from '../auth/socio.guard.js';
import { PrismaService } from '../database/prisma.service.js';
import { CommissionsService } from '../commissions/commissions.service.js';
import { SetMemberCommissionRateDto } from '../commissions/dto/commission.dto.js';

const validate = (expectedType: new () => object) =>
  new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    expectedType,
  });

/**
 * `list` is read-only and available to any authenticated account
 * regardless of role: the shared-tablet person selector needs every
 * eligible member visible, not just socios, so a colaborador can pick
 * themselves before selling.
 *
 * `setCommissionRate` requires {@link SocioGuard}: configuring how much a
 * colaborador is paid is an owner-only decision.
 */
@ApiTags('members')
@ApiBearerAuth()
@Controller('members')
export class MembersController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CommissionsService)
    private readonly commissions: CommissionsService,
  ) {}

  @Get()
  @UseGuards(AuthGuard)
  list(@Req() request: AuthenticatedRequest) {
    return this.prisma.member.findMany({
      where: { contextId: request.account.contextId },
      select: { id: true, name: true, role: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
  }

  @Patch(':id/commission-rate')
  @UseGuards(SocioGuard)
  setCommissionRate(
    @Req() request: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(validate(SetMemberCommissionRateDto)) dto: SetMemberCommissionRateDto,
  ) {
    return this.commissions.setMemberRate(
      request.account.contextId,
      id,
      dto.rateBps,
    );
  }
}

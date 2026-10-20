import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { SocioGuard } from '../auth/socio.guard.js';
import { clientIp } from '../business-registration/client-ip.js';
import { AccountInvitationsService } from './account-invitations.service.js';
import {
  AcceptInvitationDto,
  InspectInvitationDto,
  InviteMemberDto,
} from './invitations.dto.js';

const validate = (expectedType: new () => object) =>
  new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    expectedType,
  });

/** Socio-only: invite another socio to create their own login, and see who still lacks one. */
@ApiTags('members')
@ApiBearerAuth()
@UseGuards(SocioGuard)
@Controller('members')
export class MemberInvitationsController {
  constructor(
    @Inject(AccountInvitationsService)
    private readonly invitations: AccountInvitationsService,
  ) {}

  @Get('account-status')
  status(@Req() req: AuthenticatedRequest) {
    return this.invitations.status(req);
  }

  @Post(':id/invitation')
  invite(
    @Req() req: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(validate(InviteMemberDto)) dto: InviteMemberDto,
  ) {
    return this.invitations.invite(req, id, dto.email);
  }
}

/**
 * Public, no session. POST on purpose, never GET: mail scanners open links on their own, and
 * the token must not travel in a URL that proxies log. Responses are never cached and never
 * leak the page address through the Referer header.
 */
@ApiTags('invitations')
@Controller('invitations')
export class PublicInvitationsController {
  constructor(
    @Inject(AccountInvitationsService)
    private readonly invitations: AccountInvitationsService,
  ) {}

  @Post('inspect')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  inspect(
    @Req() req: Request,
    @Body(validate(InspectInvitationDto)) dto: InspectInvitationDto,
  ) {
    return this.invitations.inspect(dto.token, clientIp(req));
  }

  @Post('accept')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  accept(
    @Req() req: Request,
    @Body(validate(AcceptInvitationDto)) dto: AcceptInvitationDto,
  ) {
    return this.invitations.accept(dto.token, dto.password, clientIp(req));
  }
}

import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Post,
  Put,
  Req,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { SocioGuard } from '../auth/socio.guard.js';
import { clientIp } from '../business-registration/client-ip.js';
import { ConfirmMemberEmailDto, SetMemberEmailDto } from './member-email.dto.js';
import { MemberEmailService } from './member-email.service.js';

const validate = (expectedType: new () => object) =>
  new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    expectedType,
  });

/** Socio-only: the caller's own address for approvals. Nobody can write someone else's. */
@ApiTags('members')
@ApiBearerAuth()
@UseGuards(SocioGuard)
@Controller('members/me')
export class MemberEmailController {
  constructor(@Inject(MemberEmailService) private readonly emails: MemberEmailService) {}

  @Get('email')
  status(@Req() req: AuthenticatedRequest) {
    return this.emails.status(req);
  }

  @Put('email')
  request(
    @Req() req: AuthenticatedRequest,
    @Body(validate(SetMemberEmailDto)) dto: SetMemberEmailDto,
  ) {
    return this.emails.request(req, dto.correo);
  }
}

/**
 * Public, no session. POST on purpose, never GET (mail scanners open links on their own), never
 * cached, never leaking the page address through the Referer header.
 */
@ApiTags('member-emails')
@Controller('member-emails')
export class PublicMemberEmailController {
  constructor(@Inject(MemberEmailService) private readonly emails: MemberEmailService) {}

  @Post('inspect')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  inspect(@Req() req: Request, @Body(validate(ConfirmMemberEmailDto)) dto: ConfirmMemberEmailDto) {
    return this.emails.inspect(dto.token, clientIp(req));
  }

  @Post('confirm')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  confirm(@Req() req: Request, @Body(validate(ConfirmMemberEmailDto)) dto: ConfirmMemberEmailDto) {
    return this.emails.confirm(dto.token, clientIp(req));
  }
}

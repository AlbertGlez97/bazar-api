import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Post,
  Get,
  Query,
  Req,
  Res,
  ValidationPipe,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { BusinessRegistrationService } from './business-registration.service.js';
import { clientIp } from './client-ip.js';
import { CreateBusinessRegistrationDto } from './dto/create-business-registration.dto.js';
import { ResendVerificationDto } from './dto/resend-verification.dto.js';
import { VerifyEmailDto } from './dto/verify-email.dto.js';
import { renderStatusPage } from './status-page.html.js';
import { ApiExample } from '../docs/api-example.decorator.js';

const MISSING_TOKEN_PAGE = renderStatusPage(
  'Enlace inválido',
  'Falta el parámetro token en el enlace.',
);

/**
 * Entirely public (no `AuthGuard`/`ContextGuard`/`SocioGuard`): this is
 * how a business that does not exist in the system yet gets in, and the
 * approve/reject links are followed by a human clicking a link in an
 * email, not by an authenticated API client — see
 * {@link BusinessRegistrationService}'s own doc comment for how this
 * interacts with the BE-11 tenant-context mechanism.
 */
@ApiTags('business-registration')
@Controller('business-registration')
export class BusinessRegistrationController {
  constructor(
    @Inject(BusinessRegistrationService)
    private readonly registrations: BusinessRegistrationService,
  ) {}

  // 202 and ALWAYS the same body: nobody learns whether a correo already has a request. The
  // per-IP limit (5/hour) is a middleware (see the module), so it runs before validation.
  @Post()
  @HttpCode(202)
  @ApiExample('businessRegistrationCreate')
  async create(
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
        expectedType: CreateBusinessRegistrationDto,
      }),
    )
    dto: CreateBusinessRegistrationDto,
    @Req() req: Request,
  ) {
    await this.registrations.create(dto, clientIp(req));
    return { ok: true };
  }

  // POST, never GET: mail scanners (Outlook SafeLinks...) open links on their own and would
  // confirm someone else's address. The emailed link opens a FRONTEND page with a button
  // that calls this endpoint.
  @Post('verify-email')
  @HttpCode(200)
  @ApiExample('businessRegistrationVerifyEmail')
  async verifyEmail(
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
        expectedType: VerifyEmailDto,
      }),
    )
    dto: VerifyEmailDto,
  ) {
    await this.registrations.verifyEmail(dto.token);
    return { ok: true };
  }

  @Post('resend')
  @HttpCode(202)
  @ApiExample('businessRegistrationResend')
  async resend(
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
        expectedType: ResendVerificationDto,
      }),
    )
    dto: ResendVerificationDto,
  ) {
    await this.registrations.resend(dto.correo);
    return { ok: true };
  }

  // GET, not POST: this is a link meant to be clicked directly from an
  // email client, which can only ever issue a GET.
  @Get('approve')
  @ApiExample('businessRegistrationApprove')
  async approve(@Query('token') token: string | undefined, @Res() res: Response) {
    if (!token) {
      res.status(404).type('html').send(MISSING_TOKEN_PAGE);
      return;
    }
    const { statusCode, html } = await this.registrations.approve(token);
    res.status(statusCode).type('html').send(html);
  }

  @Get('reject')
  @ApiExample('businessRegistrationReject')
  async reject(@Query('token') token: string | undefined, @Res() res: Response) {
    if (!token) {
      res.status(404).type('html').send(MISSING_TOKEN_PAGE);
      return;
    }
    const { statusCode, html } = await this.registrations.reject(token);
    res.status(statusCode).type('html').send(html);
  }
}

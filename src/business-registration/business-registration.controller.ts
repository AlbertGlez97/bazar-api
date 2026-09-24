import {
  Body,
  Controller,
  Inject,
  Post,
  Get,
  Query,
  Res,
  ValidationPipe,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { BusinessRegistrationService } from './business-registration.service.js';
import { CreateBusinessRegistrationDto } from './dto/create-business-registration.dto.js';
import { renderStatusPage } from './status-page.html.js';

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

  @Post()
  create(
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
        expectedType: CreateBusinessRegistrationDto,
      }),
    )
    dto: CreateBusinessRegistrationDto,
  ) {
    return this.registrations.create(dto);
  }

  // GET, not POST: this is a link meant to be clicked directly from an
  // email client, which can only ever issue a GET.
  @Get('approve')
  async approve(@Query('token') token: string | undefined, @Res() res: Response) {
    if (!token) {
      res.status(404).type('html').send(MISSING_TOKEN_PAGE);
      return;
    }
    const { statusCode, html } = await this.registrations.approve(token);
    res.status(statusCode).type('html').send(html);
  }

  @Get('reject')
  async reject(@Query('token') token: string | undefined, @Res() res: Response) {
    if (!token) {
      res.status(404).type('html').send(MISSING_TOKEN_PAGE);
      return;
    }
    const { statusCode, html } = await this.registrations.reject(token);
    res.status(statusCode).type('html').send(html);
  }
}

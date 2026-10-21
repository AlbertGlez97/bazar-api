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
import { FinanceRuleLinksService } from './finance-rule-links.service.js';
import {
  AgreementTokenDto,
  RespondAgreementDto,
  SaveFinanceRulesDraftDto,
} from './finance-rules.dto.js';
import { FinanceRulesService } from './finance-rules.service.js';

const validate = (expectedType: new () => object) =>
  new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    expectedType,
  });

/** Profit-sharing rules: only active socios see or use any of this. */
@ApiTags('finance')
@ApiBearerAuth()
@UseGuards(SocioGuard)
@Controller('finance/rules')
export class FinanceRulesController {
  constructor(
    @Inject(FinanceRulesService) private readonly rules: FinanceRulesService,
  ) {}

  @Get()
  overview(@Req() req: AuthenticatedRequest) {
    return this.rules.overview(req);
  }

  @Put('draft')
  saveDraft(
    @Req() req: AuthenticatedRequest,
    @Body(validate(SaveFinanceRulesDraftDto)) dto: SaveFinanceRulesDraftDto,
  ) {
    return this.rules.saveDraft(req, dto.config);
  }

  @Post(':id/discard')
  @HttpCode(200)
  discard(
    @Req() req: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.rules.discard(req, id);
  }

  @Post(':id/submit')
  @HttpCode(200)
  submit(
    @Req() req: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.rules.submit(req, id);
  }

  @Post(':id/modify')
  @HttpCode(200)
  modify(
    @Req() req: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.rules.modify(req, id);
  }

  @Post(':id/resend')
  @HttpCode(200)
  resend(
    @Req() req: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.rules.resend(req, id);
  }
}

/**
 * Public, no session: the page an emailed link opens. POST on purpose, never GET: mail scanners
 * open links on their own, and the token must not travel in a URL that proxies log. Responses are
 * never cached and never leak the page address through the Referer header.
 */
@ApiTags('agreements')
@Controller('agreements')
export class PublicAgreementsController {
  constructor(
    @Inject(FinanceRuleLinksService) private readonly links: FinanceRuleLinksService,
  ) {}

  @Post('inspect')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  inspect(@Req() req: Request, @Body(validate(AgreementTokenDto)) dto: AgreementTokenDto) {
    return this.links.inspect(dto.token, clientIp(req));
  }

  @Post('respond')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  respond(@Req() req: Request, @Body(validate(RespondAgreementDto)) dto: RespondAgreementDto) {
    return this.links.respond(dto.token, dto.decision, dto.reason, clientIp(req));
  }
}

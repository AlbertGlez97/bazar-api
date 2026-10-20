import {
  Body,
  Controller,
  Get,
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
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { SocioGuard } from '../auth/socio.guard.js';
import { SaveFinanceRulesDraftDto } from './finance-rules.dto.js';
import { FinanceRulesService } from './finance-rules.service.js';

const validate = new ValidationPipe({
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: true,
  expectedType: SaveFinanceRulesDraftDto,
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
    @Body(validate) dto: SaveFinanceRulesDraftDto,
  ) {
    return this.rules.saveDraft(req, dto.config);
  }

  @Post(':id/discard')
  @HttpCode(200)
  discard(
    @Req() req: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.rules.discardDraft(req, id);
  }

  @Post(':id/submit')
  @HttpCode(200)
  submit(
    @Req() req: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.rules.submit(req, id);
  }

  @Post(':id/withdraw')
  @HttpCode(200)
  withdraw(
    @Req() req: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.rules.withdraw(req, id);
  }

  @Post(':id/approve')
  @HttpCode(200)
  approve(
    @Req() req: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.rules.approve(req, id);
  }

  @Post(':id/remind')
  @HttpCode(200)
  remind(
    @Req() req: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.rules.remind(req, id);
  }
}

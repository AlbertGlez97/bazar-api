import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { SocioGuard } from '../auth/socio.guard.js';
import {
  CreateDistributionAgreementDto,
  DistributionAgreementListDto,
  ReverseDistributionAgreementDto,
} from './finance-agreements.dto.js';
import { FinanceAgreementsService } from './finance-agreements.service.js';
import { FinanceOverviewDto } from './finance-overview.dto.js';

const validate = (expectedType: new () => object) =>
  new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    expectedType,
  });

/**
 * Immutable distribution agreements ("Acuerdo de reparto"). They record what
 * the participants accepted from a simulation; they are not payments.
 */
@ApiTags('finance')
@ApiBearerAuth()
@UseGuards(SocioGuard)
@Controller('finance/distribution-agreements')
export class FinanceAgreementsController {
  constructor(
    @Inject(FinanceAgreementsService)
    private readonly agreements: FinanceAgreementsService,
  ) {}

  @Post()
  async create(
    @Req() req: AuthenticatedRequest,
    @Body(validate(CreateDistributionAgreementDto))
    dto: CreateDistributionAgreementDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.agreements.create(req, dto);
    res.status(result.created ? 201 : 200);
    return result.receipt;
  }

  @Get()
  list(
    @Req() req: AuthenticatedRequest,
    @Query(validate(DistributionAgreementListDto))
    query: DistributionAgreementListDto,
  ) {
    return this.agreements.list(req.account.contextId, query);
  }

  // Declared before ':id' so "commitment" is never read as an agreement id.
  @Get('commitment')
  commitment(
    @Req() req: AuthenticatedRequest,
    @Query(validate(FinanceOverviewDto)) query: FinanceOverviewDto,
  ) {
    return this.agreements.commitment(req.account.contextId, query);
  }

  @Get(':id')
  findOne(
    @Req() req: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.agreements.findOne(req.account.contextId, id);
  }

  @Post(':id/reversals')
  async reverse(
    @Req() req: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(validate(ReverseDistributionAgreementDto))
    dto: ReverseDistributionAgreementDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.agreements.reverse(req, id, dto);
    res.status(result.created ? 201 : 200);
    return result.receipt;
  }
}

import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
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
  CreateDistributionPaymentDto,
  ReverseDistributionPaymentDto,
} from './finance-payments.dto.js';
import { FinancePaymentsService } from './finance-payments.service.js';

const validate = (expectedType: new () => object) =>
  new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    expectedType,
  });

/**
 * REAL payments recorded against a distribution agreement. The system records
 * what was agreed versus actually paid; it never moves money.
 */
@ApiTags('finance')
@ApiBearerAuth()
@UseGuards(SocioGuard)
@Controller('finance')
export class FinancePaymentsController {
  constructor(
    @Inject(FinancePaymentsService)
    private readonly payments: FinancePaymentsService,
  ) {}

  @Post('distribution-agreements/:agreementId/payments')
  async create(
    @Req() req: AuthenticatedRequest,
    @Param('agreementId', new ParseUUIDPipe()) agreementId: string,
    @Body(validate(CreateDistributionPaymentDto))
    dto: CreateDistributionPaymentDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.payments.create(req, agreementId, dto);
    res.status(result.created ? 201 : 200);
    return result.receipt;
  }

  @Get('distribution-agreements/:agreementId/payments')
  list(
    @Req() req: AuthenticatedRequest,
    @Param('agreementId', new ParseUUIDPipe()) agreementId: string,
  ) {
    return this.payments.list(req.account.contextId, agreementId);
  }

  @Get('distribution-payments/:id')
  findOne(
    @Req() req: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.payments.findOne(req.account.contextId, id);
  }

  @Post('distribution-payments/:id/reversals')
  async reverse(
    @Req() req: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(validate(ReverseDistributionPaymentDto))
    dto: ReverseDistributionPaymentDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.payments.reverse(req, id, dto);
    res.status(result.created ? 201 : 200);
    return result.receipt;
  }
}

import {
  Body,
  Controller,
  Get,
  Inject,
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
  CreateFinanceReserveDto,
  FinanceReserveListDto,
} from './finance-reserve.dto.js';
import { FinanceReservesService } from './finance-reserves.service.js';
const validate = (expectedType: new () => object) =>
  new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    expectedType,
  });
@ApiTags('finance')
@ApiBearerAuth()
@UseGuards(SocioGuard)
@Controller('finance/reserves')
export class FinanceReservesController {
  constructor(
    @Inject(FinanceReservesService)
    private readonly reserves: FinanceReservesService,
  ) {}
  @Post()
  async create(
    @Req() req: AuthenticatedRequest,
    @Body(validate(CreateFinanceReserveDto)) dto: CreateFinanceReserveDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.reserves.create(req, dto);
    res.status(result.created ? 201 : 200);
    return result.receipt;
  }
  @Get()
  list(
    @Req() req: AuthenticatedRequest,
    @Query(validate(FinanceReserveListDto)) query: FinanceReserveListDto,
  ) {
    return this.reserves.list(req.account.contextId, query);
  }
}

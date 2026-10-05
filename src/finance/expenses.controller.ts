import {
  Body,
  Controller,
  Get,
  Inject,
  Post,
  Param,
  ParseUUIDPipe,
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
  CreateExpenseDto,
  ExpenseListDto,
  ExpenseSummaryDto,
  ReverseExpenseDto,
} from './expense.dto.js';
import { ExpensesService } from './expenses.service.js';
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
@Controller('finance/expenses')
export class ExpensesController {
  constructor(
    @Inject(ExpensesService) private readonly expenses: ExpensesService,
  ) {}
  @Post()
  async create(
    @Req() req: AuthenticatedRequest,
    @Body(validate(CreateExpenseDto)) dto: CreateExpenseDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.expenses.create(req, dto);
    res.status(result.created ? 201 : 200);
    return result.receipt;
  }
  @Get()
  list(
    @Req() req: AuthenticatedRequest,
    @Query(validate(ExpenseListDto)) query: ExpenseListDto,
  ) {
    return this.expenses.list(req.account.contextId, query);
  }
  // Static segment, declared before any ':id' route.
  @Get('summary')
  summary(
    @Req() req: AuthenticatedRequest,
    @Query(validate(ExpenseSummaryDto)) query: ExpenseSummaryDto,
  ) {
    return this.expenses.summary(req.account.contextId, query);
  }
  @Post(':id/reversals')
  async reverse(
    @Req() req: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(validate(ReverseExpenseDto)) dto: ReverseExpenseDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.expenses.reverse(req, id, dto);
    res.status(result.created ? 201 : 200);
    return result.receipt;
  }
}

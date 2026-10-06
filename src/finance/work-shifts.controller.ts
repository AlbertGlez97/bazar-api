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
import { ContextGuard } from '../auth/context.guard.js';
import { SocioGuard } from '../auth/socio.guard.js';
import {
  CreateWorkShiftDto,
  WorkShiftListDto,
  WorkShiftSummaryDto,
  ReverseWorkShiftDto,
} from './work-shift.dto.js';
import { WorkShiftsService } from './work-shifts.service.js';
const validate = (expectedType: new () => object) =>
  new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    expectedType,
  });
@ApiTags('finance')
@ApiBearerAuth()
@Controller('finance/work-shifts')
export class WorkShiftsController {
  constructor(
    @Inject(WorkShiftsService) private readonly workShifts: WorkShiftsService,
  ) {}
  @UseGuards(SocioGuard)
  @Post()
  async create(
    @Req() req: AuthenticatedRequest,
    @Body(validate(CreateWorkShiftDto)) dto: CreateWorkShiftDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.workShifts.create(req, dto);
    res.status(result.created ? 201 : 200);
    return result.receipt;
  }
  @UseGuards(ContextGuard)
  @Get()
  list(
    @Req() req: AuthenticatedRequest,
    @Query(validate(WorkShiftListDto)) query: WorkShiftListDto,
  ) {
    return this.workShifts.list(req, query);
  }
  // Static segment, declared before any ':id' route.
  @UseGuards(ContextGuard)
  @Get('summary')
  summary(
    @Req() req: AuthenticatedRequest,
    @Query(validate(WorkShiftSummaryDto)) query: WorkShiftSummaryDto,
  ) {
    return this.workShifts.summary(req, query);
  }
  @UseGuards(SocioGuard)
  @Post(':id/reversals')
  async reverse(
    @Req() req: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(validate(ReverseWorkShiftDto)) dto: ReverseWorkShiftDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.workShifts.reverse(req, id, dto);
    res.status(result.created ? 201 : 200);
    return result.receipt;
  }
}

import { ApiExample } from '../docs/api-example.decorator.js';
import {
  Controller,
  Get,
  Inject,
  Query,
  Req,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { SocioGuard } from '../auth/socio.guard.js';
import { DateRangeQueryDto } from './dto/date-range.dto.js';
import { ReportsService } from './reports.service.js';

const validate = (expectedType: new () => object) =>
  new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    expectedType,
  });

/**
 * Both reports are socio-only ({@link SocioGuard}): they summarize the
 * whole team's revenue, an owner-level view, not something a colaborador
 * ringing up their own sales needs to see.
 */
@ApiTags('reports')
@ApiBearerAuth()
@Controller('reports')
@UseGuards(SocioGuard)
export class ReportsController {
  constructor(
    @Inject(ReportsService) private readonly reports: ReportsService,
  ) {}

  @Get('sales-by-period')
  @ApiExample('reportPeriod')
  salesByPeriod(
    @Req() req: AuthenticatedRequest,
    @Query(validate(DateRangeQueryDto)) query: DateRangeQueryDto,
  ) {
    return this.reports.salesByPeriod(req.account.contextId, query);
  }

  @Get('sales-by-member')
  @ApiExample('reportMember')
  salesByMember(
    @Req() req: AuthenticatedRequest,
    @Query(validate(DateRangeQueryDto)) query: DateRangeQueryDto,
  ) {
    return this.reports.salesByMember(req.account.contextId, query);
  }
}

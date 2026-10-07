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
import { SocioGuard } from '../auth/socio.guard.js';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { FinanceOverviewDto } from './finance-overview.dto.js';
import { FinanceOverviewService } from './finance-overview.service.js';
@ApiTags('finance')
@ApiBearerAuth()
@UseGuards(SocioGuard)
@Controller('finance/overview')
export class FinanceOverviewController {
  constructor(
    @Inject(FinanceOverviewService)
    private readonly finance: FinanceOverviewService,
  ) {}
  @Get()
  overview(
    @Req() req: AuthenticatedRequest,
    @Query(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
        expectedType: FinanceOverviewDto,
      }),
    )
    query: FinanceOverviewDto,
  ) {
    return this.finance.overview(req.account.contextId, query);
  }
}

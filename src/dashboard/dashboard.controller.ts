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
import { DashboardService } from './dashboard.service.js';
import { DashboardQueryDto } from './dto/dashboard-query.dto.js';

const validate = (expectedType: new () => object) =>
  new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    expectedType,
  });

/**
 * Socio-only ({@link SocioGuard}), same as ReportsController: this is the
 * Gestión home screen's owner-level summary, not something a colaborador
 * ringing up their own sales needs to see.
 */
@ApiTags('dashboard')
@ApiBearerAuth()
@Controller('dashboard')
@UseGuards(SocioGuard)
export class DashboardController {
  constructor(
    @Inject(DashboardService) private readonly dashboard: DashboardService,
  ) {}

  @Get('summary')
  summary(
    @Req() req: AuthenticatedRequest,
    @Query(validate(DashboardQueryDto)) query: DashboardQueryDto,
  ) {
    return this.dashboard.summary(req.account.contextId, query);
  }
}

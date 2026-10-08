import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Post,
  Req,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { SocioGuard } from '../auth/socio.guard.js';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { FinanceDistributionSimulationDto } from './finance-distribution.dto.js';
import { FinanceDistributionService } from './finance-distribution.service.js';
@ApiTags('finance')
@ApiBearerAuth()
@UseGuards(SocioGuard)
@Controller('finance/distribution-simulations')
export class FinanceDistributionController {
  constructor(
    @Inject(FinanceDistributionService)
    private readonly distribution: FinanceDistributionService,
  ) {}
  // A pure calculation: POST carries the body, but nothing is created (200, not 201).
  @Post()
  @HttpCode(200)
  simulate(
    @Req() req: AuthenticatedRequest,
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
        expectedType: FinanceDistributionSimulationDto,
      }),
    )
    dto: FinanceDistributionSimulationDto,
  ) {
    return this.distribution.simulate(req.account.contextId, dto);
  }
}

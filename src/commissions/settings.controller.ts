import { ApiExample } from '../docs/api-example.decorator.js';
import {
  Body,
  Controller,
  Inject,
  Patch,
  Req,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { SocioGuard } from '../auth/socio.guard.js';
import { SetGlobalCommissionRateDto } from './dto/commission.dto.js';
import { CommissionsService } from './commissions.service.js';

const validate = (expectedType: new () => object) =>
  new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    expectedType,
  });

/**
 * Configures the context-wide default commission percentage. Kept as its
 * own `/settings` resource (rather than folded into `/commissions`)
 * because it is a single piece of context-wide configuration, not a
 * commission calculation itself — a socio configures it once, then
 * `GET /commissions` reads it many times.
 *
 * Socio-only ({@link SocioGuard}): only socios may decide how much of the
 * bazar's revenue colaboradores are paid.
 */
@ApiTags('settings')
@ApiBearerAuth()
@Controller('settings')
@UseGuards(SocioGuard)
export class SettingsController {
  constructor(
    @Inject(CommissionsService) private readonly commissions: CommissionsService,
  ) {}

  @Patch('commission-rate')
  @ApiExample('settings')
  setGlobalRate(
    @Req() req: AuthenticatedRequest,
    @Body(validate(SetGlobalCommissionRateDto)) dto: SetGlobalCommissionRateDto,
  ) {
    return this.commissions.setGlobalRate(req.account.contextId, dto.rateBps);
  }
}

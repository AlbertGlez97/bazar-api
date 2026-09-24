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
import { CommissionsQueryDto } from './dto/commission.dto.js';
import { CommissionsService } from './commissions.service.js';

const validate = (expectedType: new () => object) =>
  new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    expectedType,
  });

/**
 * Read-only commission calculation. Socio-only ({@link SocioGuard}): this
 * is what colaboradores earn, an owner-level concern, not something a
 * colaborador looks up about themselves through this endpoint.
 */
@ApiTags('commissions')
@ApiBearerAuth()
@Controller('commissions')
@UseGuards(SocioGuard)
export class CommissionsController {
  constructor(
    @Inject(CommissionsService) private readonly commissions: CommissionsService,
  ) {}

  @Get()
  @ApiExample('commissions')
  calculate(
    @Req() req: AuthenticatedRequest,
    @Query(validate(CommissionsQueryDto)) query: CommissionsQueryDto,
  ) {
    return this.commissions.calculate(req.account.contextId, query);
  }
}

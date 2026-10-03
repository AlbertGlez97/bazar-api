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
  CreateContributionDto,
  ContributionListDto,
} from './contribution.dto.js';
import { ContributionsService } from './contributions.service.js';
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
@Controller('finance/contributions')
export class ContributionsController {
  constructor(
    @Inject(ContributionsService)
    private readonly contributions: ContributionsService,
  ) {}
  @Post()
  async create(
    @Req() req: AuthenticatedRequest,
    @Body(validate(CreateContributionDto)) dto: CreateContributionDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.contributions.create(req, dto);
    res.status(result.created ? 201 : 200);
    return result.receipt;
  }
  @Get()
  list(
    @Req() req: AuthenticatedRequest,
    @Query(validate(ContributionListDto)) query: ContributionListDto,
  ) {
    return this.contributions.list(req.account.contextId, query);
  }
}

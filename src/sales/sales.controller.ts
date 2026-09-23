import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthGuard, type AuthenticatedRequest } from '../auth/auth.guard.js';
import { ContextGuard } from '../auth/context.guard.js';
import { SocioGuard } from '../auth/socio.guard.js';
import { CreateSaleDto } from './dto/create-sale.dto.js';
import { SaleListDto } from './dto/sale-list.dto.js';
import { SalesService } from './sales.service.js';

const validate = (expectedType: new () => object) =>
  new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    expectedType,
  });

/**
 * `create` requires {@link ContextGuard} (member/device selection), since
 * registering a sale must be attributable to a specific person and
 * device. `findOne` only requires {@link AuthGuard}: any authenticated
 * account may re-fetch a single sale it already knows the id of (e.g.
 * after a lost response). `list` ("movimientos") requires
 * {@link SocioGuard}: browsing every sale across the whole team is an
 * administrative/reviewing capability, not something a colaborador
 * ringing up sales needs.
 */
@ApiTags('sales')
@ApiBearerAuth()
@Controller('sales')
export class SalesController {
  constructor(@Inject(SalesService) private readonly sales: SalesService) {}

  @Post()
  @UseGuards(ContextGuard)
  async create(
    @Req() req: AuthenticatedRequest,
    @Body(validate(CreateSaleDto)) dto: CreateSaleDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    // 201 for a genuinely new sale (including one persisted as
    // "rechazada_por_conflicto"); 200 when this request is an idempotent
    // replay of an id that was already persisted — the resource already
    // existed, nothing was created by this call.
    const { sale, created } = await this.sales.create(req, dto);
    res.status(created ? HttpStatus.CREATED : HttpStatus.OK);
    return sale;
  }

  @Get()
  @UseGuards(SocioGuard)
  list(
    @Req() req: AuthenticatedRequest,
    @Query(validate(SaleListDto)) query: SaleListDto,
  ) {
    return this.sales.list(req.account.contextId, query);
  }

  @Get(':id')
  @UseGuards(AuthGuard)
  findOne(
    @Req() req: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.sales.findOne(req.account.contextId, id);
  }
}



import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthGuard, type AuthenticatedRequest } from '../auth/auth.guard.js';
import { ContextGuard } from '../auth/context.guard.js';
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
 * device; `findOne` and `list` only require {@link AuthGuard}, since
 * reading sales back (e.g. after a lost response, or reviewing sales
 * rejected by an offline sync conflict) does not need a fresh selection.
 */
@ApiTags('sales')
@ApiBearerAuth()
@Controller('sales')
export class SalesController {
  constructor(@Inject(SalesService) private readonly sales: SalesService) {}

  @Post()
  @UseGuards(ContextGuard)
  create(
    @Req() req: AuthenticatedRequest,
    @Body(validate(CreateSaleDto)) dto: CreateSaleDto,
  ) {
    return this.sales.create(req, dto);
  }

  @Get()
  @UseGuards(AuthGuard)
  list(
    @Req() req: AuthenticatedRequest,
    @Query(validate(SaleListDto)) query: SaleListDto,
  ) {
    return this.sales.list(req.account.contextId, query.status);
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


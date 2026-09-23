import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { AuthGuard, type AuthenticatedRequest } from '../auth/auth.guard.js';
import { ContextGuard } from '../auth/context.guard.js';
import { CreateSaleDto } from './dto/create-sale.dto.js';
import { SalesService } from './sales.service.js';

const validate = (expectedType: new () => object) =>
  new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    expectedType,
  });

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

  @Get(':id')
  @UseGuards(AuthGuard)
  findOne(
    @Req() req: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.sales.findOne(req.account.contextId, id);
  }
}

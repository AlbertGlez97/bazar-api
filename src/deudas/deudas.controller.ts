import { ApiExample } from '../docs/api-example.decorator.js';
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
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { ContextGuard } from '../auth/context.guard.js';
import { SocioGuard } from '../auth/socio.guard.js';
import { CreateDeudaDto } from './dto/create-deuda.dto.js';
import { DeudaListDto } from './dto/deuda-list.dto.js';
import { CreateAbonoDto } from './dto/create-abono.dto.js';
import { DeudasService } from './deudas.service.js';

const validate = (expectedType: new () => object) =>
  new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    expectedType,
  });

/**
 * `create`, `list` and `findOne` require {@link SocioGuard}: only a socio
 * may authorize extending credit or reserving stock, and only socios
 * browse/review the full list of who owes what. `addAbono` only requires
 * {@link ContextGuard} (any authenticated member/device selection):
 * collecting a payment from a customer is a task any colaborador on
 * shift can and should be able to do without a socio present.
 */
@ApiTags('deudas')
@ApiBearerAuth()
@Controller('deudas')
export class DeudasController {
  constructor(@Inject(DeudasService) private readonly deudas: DeudasService) {}

  @Post()
  @ApiExample('debtCreate')
  @UseGuards(SocioGuard)
  create(
    @Req() req: AuthenticatedRequest,
    @Body(validate(CreateDeudaDto)) dto: CreateDeudaDto,
  ) {
    return this.deudas.create(req, dto);
  }

  @Get()
  @ApiExample('debts')
  @UseGuards(SocioGuard)
  list(
    @Req() req: AuthenticatedRequest,
    @Query(validate(DeudaListDto)) query: DeudaListDto,
  ) {
    return this.deudas.list(req.account.contextId, query);
  }

  @Get(':id')
  @ApiExample('debtDetail')
  @UseGuards(SocioGuard)
  findOne(
    @Req() req: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.deudas.findOne(req.account.contextId, id);
  }

  @Post(':id/abonos')
  @ApiExample('debtPayment')
  @UseGuards(ContextGuard)
  addAbono(
    @Req() req: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(validate(CreateAbonoDto)) dto: CreateAbonoDto,
  ) {
    return this.deudas.registerAbono(req, id, dto);
  }
}

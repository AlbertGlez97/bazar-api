import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  Req,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { SocioGuard } from '../auth/socio.guard.js';
import {
  IncidenciaListDto,
  ResolveIncidenciaDto,
} from './dto/incidencia.dto.js';
import { IncidenciasService } from './incidencias.service.js';

const validate = (expectedType: new () => object) =>
  new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    expectedType,
  });

/**
 * Every route here requires {@link SocioGuard}: incidencias exist for a
 * socio to review and resolve conflicts/anomalies with the customer, and
 * a colaborador has no need to (and per the approved decisions, must not)
 * see them.
 */
@ApiTags('incidencias')
@ApiBearerAuth()
@Controller('incidencias')
@UseGuards(SocioGuard)
export class IncidenciasController {
  constructor(
    @Inject(IncidenciasService)
    private readonly incidencias: IncidenciasService,
  ) {}

  @Get()
  list(
    @Req() req: AuthenticatedRequest,
    @Query(validate(IncidenciaListDto)) query: IncidenciaListDto,
  ) {
    return this.incidencias.list(req.account.contextId, query);
  }

  @Get(':id')
  findOne(
    @Req() req: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.incidencias.findOne(req.account.contextId, id);
  }

  @Patch(':id/resolver')
  resolve(
    @Req() req: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(validate(ResolveIncidenciaDto)) dto: ResolveIncidenciaDto,
  ) {
    // req.selection is guaranteed by SocioGuard (it runs ContextGuard
    // first), so the authenticated socio's own memberId is always known
    // here — the resolver is never a body-supplied field.
    return this.incidencias.resolve(
      req.account.contextId,
      id,
      req.selection!.memberId,
      dto,
    );
  }
}

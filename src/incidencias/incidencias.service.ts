import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import type { Incidencia } from '../generated/prisma/client.js';
import type {
  IncidenciaListDto,
  ResolveIncidenciaDto,
} from './dto/incidencia.dto.js';

function response(incidencia: Incidencia & { sale?: unknown }) {
  return incidencia;
}

/**
 * Reads and resolves {@link Incidencia} records — the standing,
 * independently-resolvable log of things a socio needs to look at after
 * the fact (a lost offline stock race, or an implausible occurredAt).
 * Every method here is reachable only via {@link SocioGuard} at the
 * controller: a colaborador may cause an incidencia (e.g. by
 * synchronizing a losing sale) but never sees or resolves the resulting
 * record, since resolution always involves a business decision
 * (refunding, adjusting stock, talking to the customer) reserved for
 * socios.
 */
@Injectable()
export class IncidenciasService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * Lists incidencias for the authenticated context, optionally filtered
   * by `type`/`resolutionStatus` and searched by the name of the Member
   * who *sold* the related Sale (not the — possibly still empty —
   * resolvedBy Member), paginated and orderable by `detectedAt`, mirroring
   * ProductsService.list/SalesService.list's established pattern.
   */
  async list(contextId: string, query: IncidenciaListDto) {
    const where = {
      sale: {
        member: {
          contextId,
          ...(query.search
            ? {
                name: {
                  contains: query.search,
                  mode: 'insensitive' as const,
                },
              }
            : {}),
        },
      },
      ...(query.type ? { type: query.type } : {}),
      ...(query.resolutionStatus
        ? { resolutionStatus: query.resolutionStatus }
        : {}),
    };
    const [items, total] = await this.prisma.$transaction(
      [
        this.prisma.incidencia.findMany({
          where,
          orderBy: [{ detectedAt: query.sort }, { id: 'asc' }],
          skip: (query.page - 1) * query.limit,
          take: query.limit,
        }),
        this.prisma.incidencia.count({ where }),
      ],
      { isolationLevel: 'RepeatableRead' },
    );
    return {
      items: items.map(response),
      total,
      page: query.page,
      limit: query.limit,
    };
  }

  /**
   * Retrieves one incidencia together with its related Sale, so the
   * frontend can jump straight to "what sale is this actually about"
   * (its items, total, cash received) without a second round trip.
   *
   * @throws NotFoundException when the incidencia does not exist, or its
   * related Sale belongs to another context (both must be
   * indistinguishable to the caller).
   */
  async findOne(contextId: string, id: string) {
    const incidencia = await this.prisma.incidencia.findFirst({
      where: { id, sale: { member: { contextId } } },
      include: { sale: { include: { items: true } } },
    });
    if (!incidencia) throw new NotFoundException();
    return response(incidencia);
  }

  /**
   * Marks an incidencia as resolved by the authenticated socio.
   *
   * Rejects an already-resolved incidencia with 409 rather than silently
   * overwriting it: `resolvedByMemberId`/`resolvedAt` are meant to record
   * *who actually resolved it and when*, which would be lost/corrupted if
   * a second PATCH were allowed to quietly replace them. The check and
   * the write are done as a single conditional `updateMany` (matching
   * only `resolutionStatus: 'pendiente'`) rather than a separate
   * read-then-write, so two concurrent PATCHes on the same incidencia
   * cannot both believe they were first — only one can ever transition
   * "pendiente" -> "resuelta". There is no "unresolve" — if a resolution
   * needs to change, that is done outside this system, not by mutating
   * the historical record of who resolved what.
   *
   * @throws NotFoundException when the incidencia does not exist in this
   * context.
   * @throws ConflictException when the incidencia was already resolved.
   */
  async resolve(
    contextId: string,
    id: string,
    resolvedByMemberId: string,
    dto: ResolveIncidenciaDto,
  ) {
    const incidencia = await this.prisma.incidencia.findFirst({
      where: { id, sale: { member: { contextId } } },
    });
    if (!incidencia) throw new NotFoundException();
    const { count } = await this.prisma.incidencia.updateMany({
      where: { id, resolutionStatus: 'pendiente' },
      data: {
        resolutionStatus: 'resuelta',
        resolvedByMemberId,
        resolvedAt: new Date(),
        resolutionNotes: dto.resolutionNotes,
      },
    });
    if (count === 0)
      throw new ConflictException(`Incidencia ${id} is already resolved`);
    const resolved = await this.prisma.incidencia.findUniqueOrThrow({
      where: { id },
    });
    return response(resolved);
  }
}

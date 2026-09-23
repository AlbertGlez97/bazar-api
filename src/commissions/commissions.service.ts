import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { multiply, transformScale, halfUp } from 'dinero.js';
import { toDinero, toMinorUnits } from '../common/money.js';
import { currentWeekRange, parseRangeBoundary } from '../common/business-time.js';
import { PrismaService } from '../database/prisma.service.js';
import type { CommissionsQueryDto } from './dto/commission.dto.js';

/**
 * Multiplies an integer cent amount by a basis-point rate and rounds back
 * down to whole cents, entirely through dinero.js (never `Number`/
 * `Decimal` math), per the project-wide money convention.
 *
 * `multiply`'s scaled-factor form (`{ amount: rateBps, scale: 4 }`)
 * represents the exact rational `rateBps / 10^4` (e.g. 1000/10^4 = 0.10
 * for 10.00%) rather than a floating-point percentage, so the
 * multiplication itself introduces no rounding error; `transformScale`
 * then rescales the (necessarily higher-precision) intermediate result
 * back down to cents, at which point rounding is unavoidable — `halfUp`
 * is used so a fractional-cent commission always rounds in the
 * colaborador's favor rather than being silently truncated down.
 */
function commissionMinorFor(totalSoldMinor: number, rateBps: number): number {
  const scaled = multiply(toDinero(totalSoldMinor), {
    amount: rateBps,
    scale: 4,
  });
  const rounded = transformScale(scaled, 2, halfUp);
  return toMinorUnits(rounded);
}

/**
 * Calculates (never pays) a per-colaborador sales commission for a given
 * period, and lets a socio configure the global default / individual
 * override percentages that feed that calculation.
 *
 * A percentage-of-sales model (not a fixed amount per sale) was chosen
 * because it scales naturally with how busy a colaborador's shift
 * actually was — a flat per-sale amount would pay the same for a $20
 * trinket as for a $2,000 sale, which does not reflect the value a
 * colaborador actually helped generate.
 */
@Injectable()
export class CommissionsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * Sets the context-wide default commission percentage (basis points)
   * applied to any colaborador without their own override. Idempotent
   * upsert: the first call for a context creates its `AppSettings` row,
   * subsequent calls just update it.
   */
  async setGlobalRate(contextId: string, rateBps: number) {
    return this.prisma.appSettings.upsert({
      where: { contextId },
      create: { contextId, defaultCommissionRateBps: rateBps },
      update: { defaultCommissionRateBps: rateBps },
    });
  }

  /**
   * Sets (or, with `rateBps: null`, clears) a single colaborador's
   * individual commission override.
   *
   * Restricted to `role: 'colaborador'` members: a socio is an owner, not
   * a paid seller, and is never subject to a sales commission, so giving
   * a socio an override rate would be a meaningless, easily-misused
   * field.
   *
   * @throws NotFoundException when the member does not exist in this
   * context.
   * @throws BadRequestException when the member is a socio, not a
   * colaborador.
   */
  async setMemberRate(
    contextId: string,
    memberId: string,
    rateBps: number | null,
  ) {
    const member = await this.prisma.member.findFirst({
      where: { id: memberId, contextId },
    });
    if (!member) throw new NotFoundException(`Member ${memberId} not found`);
    if (member.role !== 'colaborador')
      throw new BadRequestException(
        'Only colaboradores have an individual commission rate',
      );
    return this.prisma.member.update({
      where: { id: memberId },
      data: { commissionRateBps: rateBps },
    });
  }

  /**
   * Calculates the commission owed to one or every colaborador in a
   * context over a period.
   *
   * The period defaults to the current domingo-sábado business week when
   * `from`/`to` are both omitted (the approved weekly cutover), letting a
   * socio ask "what do I owe right now" without doing date math
   * themselves; passing both explicitly overrides that default for
   * historical/ad-hoc periods. `receivedAt` (the server's own clock), not
   * `occurredAt` (client-declared, only lightly validated), is what
   * anchors a sale to a period — see Sale.receivedAt / SalesService.
   *
   * Only `status: 'completada'` sales are summed. A sale with a pending
   * Incidencia is deliberately *not* excluded: an Incidencia is a flag for
   * a human to look at, not a statement that the sale itself is invalid —
   * hiding it from the commission calculation would just create a silent
   * discrepancy a socio would have to notice and reconcile manually
   * later. If resolving an Incidencia changes a sale's outcome, that is a
   * manual recalculation, not something this system infers automatically.
   *
   * @throws BadRequestException when exactly one of `from`/`to` is given
   * (a half-open range would be ambiguous), or when `memberId` refers to
   * a member outside this context/not a colaborador (surfaced as an empty
   * result set rather than an error, except when `memberId` was
   * explicitly requested and matched nobody).
   */
  async calculate(contextId: string, query: CommissionsQueryDto) {
    if ((query.from && !query.to) || (!query.from && query.to))
      throw new BadRequestException(
        'from and to must be provided together, or omitted together for the current week',
      );

    const range =
      query.from && query.to
        ? {
            from: parseRangeBoundary(query.from, 'start'),
            to: parseRangeBoundary(query.to, 'end'),
          }
        : currentWeekRange(new Date());

    const settings = await this.prisma.appSettings.findUnique({
      where: { contextId },
    });
    const globalRateBps = settings?.defaultCommissionRateBps ?? 0;

    const members = await this.prisma.member.findMany({
      where: {
        contextId,
        role: 'colaborador',
        ...(query.memberId ? { id: query.memberId } : {}),
      },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    if (query.memberId && members.length === 0)
      throw new NotFoundException(
        `Colaborador ${query.memberId} not found in this context`,
      );

    const items = await Promise.all(
      members.map(async (member) => {
        const agg = await this.prisma.sale.aggregate({
          where: {
            memberId: member.id,
            status: 'completada',
            receivedAt: { gte: range.from, lte: range.to },
          },
          _sum: { totalMinor: true },
        });
        const totalSoldMinor = agg._sum.totalMinor ?? 0;
        const rateBps = member.commissionRateBps ?? globalRateBps;
        return {
          memberId: member.id,
          memberName: member.name,
          totalSoldMinor,
          rateBps,
          commissionMinor: commissionMinorFor(totalSoldMinor, rateBps),
        };
      }),
    );

    return { from: range.from, to: range.to, items };
  }
}

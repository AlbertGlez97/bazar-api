import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { multiply, subtract } from 'dinero.js';
import { toDinero, toMinorUnits } from '../common/money.js';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma, type Abono, type Deuda } from '../generated/prisma/client.js';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import type { CreateDeudaDto } from './dto/create-deuda.dto.js';
import type { DeudaListDto } from './dto/deuda-list.dto.js';
import type { CreateAbonoDto } from './dto/create-abono.dto.js';

type Actor = Pick<AuthenticatedRequest, 'account' | 'selection'>;
type DeudaWithAbonos = Deuda & { abonos: Abono[] };

function response(deuda: DeudaWithAbonos) {
  return deuda;
}

/**
 * Registers and settles {@link Deuda} records — the unified "fiado"
 * (product already delivered) / "apartado" (product held/reserved)
 * concept. Both types are handled identically here: the only place `type`
 * matters is as a label the socio chose for their own bookkeeping: the
 * inventory, pricing, abono and status-derivation rules below apply the
 * same way regardless of which one it is.
 */
@Injectable()
export class DeudasService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * Re-validates the actor inside the transaction (mirrors
   * SalesService.authorize), rather than trusting a guard's
   * pre-transaction read, so a device deauthorized or a member
   * removed/demoted between the guard running and the transaction
   * committing is still honored. `requireSocio` additionally re-checks
   * the member's role, since {@link create} must stay socio-only even if
   * the acting member's role changed mid-flight; {@link registerAbono}
   * passes `false` since any authenticated member/device may collect a
   * payment.
   *
   * @throws ForbiddenException when there is no selection, the account/
   * member/device do not resolve within the actor's `contextId` (the
   * device must additionally be `authorized`), or (`requireSocio: true`)
   * the member's role is not `socio`.
   */
  private async authorize(
    tx: Prisma.TransactionClient,
    actor: Actor,
    requireSocio: boolean,
  ) {
    if (!actor.selection) throw new ForbiddenException();
    const account = await tx.account.findFirst({
      where: {
        id: actor.account.id,
        contextId: actor.account.contextId,
        active: true,
      },
    });
    const member = await tx.member.findFirst({
      where: {
        id: actor.selection.memberId,
        contextId: actor.account.contextId,
        ...(requireSocio ? { role: 'socio' as const } : {}),
      },
    });
    const device = await tx.device.findFirst({
      where: {
        id: actor.selection.deviceId,
        contextId: actor.account.contextId,
        authorized: true,
      },
    });
    if (!account || !member || !device) throw new ForbiddenException();
    return { memberId: member.id, deviceId: device.id };
  }

  /**
   * Registers a fiado or apartado for a single product/quantity, backed
   * by an existing {@link Deudor} (`dto.deudorId`) or a brand-new one
   * created inline (`dto.deudor`) — exactly one of the two must be
   * supplied.
   *
   * The total is always the current `Product.unitPriceMinor × cantidad`
   * (dinero.js, same as {@link SalesService.create}): the server never
   * trusts a client-supplied price. Stock is decremented immediately and
   * unconditionally for both "fiado" and "apartado" — even though an
   * apartado's product has not physically left the bazar yet — because
   * the whole point of either is to guarantee this exact piece for this
   * customer while they pay it off; leaving the stock available would let
   * it be sold to someone else in the meantime. Stock check, decrement,
   * total calculation and the Deuda write all happen in one transaction:
   * any failure (nonexistent deudor/product, insufficient stock) rolls
   * back everything, so a Deuda is never applied partially.
   *
   * Unlike {@link SalesService.create}, there is no offline-sync stock
   * race to reconcile here (a Deuda is always created in-person, online,
   * by a socio) — insufficient stock is always a plain rejection, never a
   * persisted "conflict" record.
   *
   * @throws ForbiddenException via {@link authorize} (socio-only).
   * @throws BadRequestException when neither/both of `deudorId`/`deudor`
   * are supplied, `deudorId` does not exist in this context, `productId`
   * does not exist in this context, or `cantidad` exceeds that product's
   * current stock.
   */
  async create(actor: Actor, dto: CreateDeudaDto) {
    const hasDeudorId = Boolean(dto.deudorId);
    const hasInlineDeudor = Boolean(dto.deudor);
    if (hasDeudorId === hasInlineDeudor)
      throw new BadRequestException(
        'Exactly one of deudorId or deudor must be provided',
      );

    const deuda = await this.prisma.$transaction(async (tx) => {
      const { memberId } = await this.authorize(tx, actor, true);

      let deudorId = dto.deudorId;
      if (!deudorId) {
        const deudor = await tx.deudor.create({
          data: {
            nombre: dto.deudor!.nombre,
            telefono: dto.deudor!.telefono,
            notas: dto.deudor!.notas,
            contextId: actor.account.contextId,
          },
        });
        deudorId = deudor.id;
      } else {
        const existingDeudor = await tx.deudor.findFirst({
          where: { id: deudorId, contextId: actor.account.contextId },
        });
        if (!existingDeudor)
          throw new BadRequestException(
            `Deudor ${deudorId} does not exist in this context`,
          );
      }

      // Row-locked read (matches SalesService's FOR UPDATE pattern): even
      // without an offline-sync race to reconcile, two socios could still
      // submit a fiado/apartado for the last unit of the same product at
      // the same moment from two different tablets.
      await tx.$queryRaw`SELECT id FROM "Product" WHERE id = ${dto.productId}::uuid AND "contextId" = ${actor.account.contextId} FOR UPDATE`;
      const product = await tx.product.findFirst({
        where: { id: dto.productId, contextId: actor.account.contextId },
      });
      if (!product)
        throw new BadRequestException(
          `Product ${dto.productId} does not exist in this context`,
        );
      if (dto.cantidad > product.stock)
        throw new BadRequestException(
          `Insufficient stock for product ${dto.productId}`,
        );

      await tx.product.update({
        where: { id: product.id },
        data: { stock: product.stock - dto.cantidad },
      });

      const totalMinor = toMinorUnits(
        multiply(toDinero(product.unitPriceMinor), dto.cantidad),
      );

      return tx.deuda.create({
        data: {
          type: dto.type,
          deudorId,
          productId: product.id,
          cantidad: dto.cantidad,
          totalMinor,
          createdByMemberId: memberId,
        },
        include: { abonos: true },
      });
    });
    return response(deuda);
  }

  /**
   * Lists deudas for the authenticated context, optionally filtered by
   * `status` and searched by the Deudor's own name, paginated and
   * orderable by `createdAt`, mirroring SalesService.list/
   * IncidenciasService.list's established pattern. `status=pendiente` is
   * the primary use case ("who currently owes money").
   */
  async list(contextId: string, query: DeudaListDto) {
    const where = {
      createdByMember: { contextId },
      ...(query.status ? { status: query.status } : {}),
      ...(query.search
        ? {
            deudor: {
              nombre: {
                contains: query.search,
                mode: 'insensitive' as const,
              },
            },
          }
        : {}),
    };
    const [items, total] = await this.prisma.$transaction(
      [
        this.prisma.deuda.findMany({
          where,
          include: { abonos: true, deudor: true },
          orderBy: [{ createdAt: query.sort }, { id: 'asc' }],
          skip: (query.page - 1) * query.limit,
          take: query.limit,
        }),
        this.prisma.deuda.count({ where }),
      ],
      { isolationLevel: 'RepeatableRead' },
    );
    return {
      items,
      total,
      page: query.page,
      limit: query.limit,
    };
  }

  /**
   * Retrieves one deuda together with its full abono history, scoped to
   * the authenticated context via the createdByMember relation (Deuda
   * itself carries no `contextId` column, matching Sale's convention).
   *
   * @throws NotFoundException when the deuda does not exist or belongs to
   * another context.
   */
  async findOne(contextId: string, id: string) {
    const deuda = await this.prisma.deuda.findFirst({
      where: { id, createdByMember: { contextId } },
      include: { abonos: true, deudor: true },
    });
    if (!deuda) throw new NotFoundException();
    return response(deuda);
  }

  /**
   * Registers a payment against a deuda's running balance. Any
   * authenticated Member/device may record one (`requireSocio: false` in
   * {@link authorize}) — collecting cash owed does not require the same
   * authorization as originally extending the credit/reservation.
   *
   * The deuda row is locked (`FOR UPDATE`) before its existing abonos are
   * summed, so two abonos submitted for the same deuda at the same
   * instant from different tablets are serialized rather than both
   * reading the same stale balance and both being accepted past it. The
   * remaining balance is computed with dinero.js (matching the project's
   * blanket "money math never uses raw `number` arithmetic" rule), and an
   * abono that would exceed it is rejected outright — there is no partial
   * application. When an abono brings the sum of all abonos to exactly
   * the total, `status` is flipped to "saldada" in the same transaction;
   * this is the *only* way status ever changes — there is no endpoint to
   * set it directly.
   *
   * @throws ForbiddenException via {@link authorize}.
   * @throws NotFoundException when the deuda does not exist in this
   * context.
   * @throws BadRequestException when `montoMinor` exceeds the remaining
   * pending balance.
   */
  async registerAbono(actor: Actor, deudaId: string, dto: CreateAbonoDto) {
    const deuda = await this.prisma.$transaction(async (tx) => {
      const { memberId } = await this.authorize(tx, actor, false);

      const existing = await tx.deuda.findFirst({
        where: {
          id: deudaId,
          createdByMember: { contextId: actor.account.contextId },
        },
      });
      if (!existing) throw new NotFoundException();

      await tx.$queryRaw`SELECT id FROM "Deuda" WHERE id = ${deudaId}::uuid FOR UPDATE`;

      const paidSoFar = await tx.abono.aggregate({
        where: { deudaId },
        _sum: { montoMinor: true },
      });
      const paidMinor = paidSoFar._sum.montoMinor ?? 0;
      const remainingMinor = toMinorUnits(
        subtract(toDinero(existing.totalMinor), toDinero(paidMinor)),
      );
      if (dto.montoMinor > remainingMinor)
        throw new BadRequestException(
          `Abono of ${dto.montoMinor} exceeds the remaining balance of ${remainingMinor}`,
        );

      await tx.abono.create({
        data: {
          deudaId,
          montoMinor: dto.montoMinor,
          receivedByMemberId: memberId,
          nota: dto.nota,
        },
      });

      const newPaidMinor = paidMinor + dto.montoMinor;
      if (newPaidMinor >= existing.totalMinor) {
        await tx.deuda.update({
          where: { id: deudaId },
          data: { status: 'saldada' },
        });
      }

      return tx.deuda.findUniqueOrThrow({
        where: { id: deudaId },
        include: { abonos: true, deudor: true },
      });
    });
    return response(deuda);
  }
}

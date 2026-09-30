import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { add, multiply, subtract } from 'dinero.js';
import { toDinero, toMinorUnits } from '../common/money.js';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import type { CreateDeudaDto } from './dto/create-deuda.dto.js';
import type { DeudaListDto } from './dto/deuda-list.dto.js';
import type { CreateAbonoDto } from './dto/create-abono.dto.js';
import type { CreateCuotaDto, UpdateCuotaDto } from './dto/cuota-planeada.dto.js';
import { createServerId } from '../common/server-id.js';

type Actor = Pick<AuthenticatedRequest, 'account' | 'selection'>;

// Deliberately untyped-through (`<T>`): the exact shape returned varies by
// method (`create` never nests `deudor`; `list`/`findOne`/`registerAbono`
// do; every method now also nests `cuotasPlaneadas`) — this is just the
// one place that shape decision is made, not a place that needs its own
// duplicate type per call site.
function response<T>(deuda: T): T {
  return deuda;
}

/**
 * Registers and settles {@link Deuda} records — the unified "fiado"
 * (product already delivered) / "apartado" (product held/reserved)
 * concept. Both types are handled identically here: the only place `type`
 * matters is as a label the socio chose for their own bookkeeping: the
 * inventory, pricing, abono and status-derivation rules below apply the
 * same way regardless of which one it is.
 *
 * BE-15 adds: an explicit (always-provided) initial abono at creation
 * time, a purely informative planned-payment schedule (`CuotaPlaneada`,
 * never read by any balance/status calculation), a cost snapshot
 * (`unitCostMinor`) and a settlement timestamp (`saldadaAt`).
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
   * the member's role, since {@link create} and every cuotas mutation
   * must stay socio-only even if the acting member's role changed
   * mid-flight; {@link registerAbono} passes `false` since any
   * authenticated member/device may collect a payment.
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
        active: true,
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
   * The single "may this abono be applied" guard, shared by {@link create}
   * (the initial abono, D1) and {@link registerAbono} (every later one) —
   * exactly one place decides "an abono cannot exceed the remaining
   * balance", never duplicated logic with its own copy of the error
   * message.
   *
   * @throws BadRequestException (same message shape both call sites
   * already relied on) when `montoMinor` exceeds the remaining balance.
   */
  private assertWithinBalance(
    paidMinor: number,
    totalMinor: number,
    montoMinor: number,
  ): number {
    const remainingMinor = toMinorUnits(
      subtract(toDinero(totalMinor), toDinero(paidMinor)),
    );
    if (montoMinor > remainingMinor)
      throw new BadRequestException(
        `Abono of ${montoMinor} exceeds the remaining balance of ${remainingMinor}`,
      );
    return remainingMinor;
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
   * any failure (nonexistent deudor/product, insufficient stock, an
   * over-balance initial abono) rolls back everything, so a Deuda is
   * never applied partially.
   *
   * BE-15 (D1): `dto.abonoInicialMinor` is always provided (never
   * silently omitted). `0` creates no Abono at all. `> 0` creates exactly
   * one Abono (dated today, `receivedByMemberId` = the acting socio) in
   * this same transaction, validated by the exact same
   * {@link assertWithinBalance} guard `registerAbono` uses — an initial
   * abono that alone would exceed `totalMinor` rolls back the whole
   * request (no Deuda, no Deudor, no stock change either). When the
   * initial abono alone covers the total, the Deuda is created already
   * `saldada` (with `saldadaAt` set), matching the invariant `registerAbono`
   * enforces for every later abono — there is exactly one settlement rule
   * in this codebase, not one for creation and a different one for
   * later payments.
   *
   * BE-15 (D5): `unitCostMinor` is copied from `Product.purchaseCostMinor`
   * at this exact moment — nullable, never estimated, never recomputed
   * later (same convention as `SaleItem.unitCostMinor`, BE-13).
   *
   * BE-15 (D3): `dto.cuotasPlaneadas`, when present, is created in this
   * same transaction — purely informative, see `CuotaPlaneada`'s own doc
   * comment (schema.prisma) for why it can never affect the balance
   * computed here or anywhere else.
   *
   * Unlike {@link SalesService.create}, there is no offline-sync stock
   * race to reconcile here (a Deuda is always created in-person, online,
   * by a socio) — insufficient stock is always a plain rejection, never a
   * persisted "conflict" record.
   *
   * @throws ForbiddenException via {@link authorize} (socio-only).
   * @throws BadRequestException when neither/both of `deudorId`/`deudor`
   * are supplied, `deudorId` does not exist in this context, `productId`
   * does not exist in this context, `cantidad` exceeds that product's
   * current stock, or `abonoInicialMinor` alone exceeds `totalMinor`.
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
            id: createServerId(),
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
      // Deactivated products cannot be fiado'd/apartado'd either, same
      // rule as SalesService (BE-10): deactivation removes a product from
      // sale entirely, not just from the catalog.
      if (!product.active)
        throw new BadRequestException(
          `Product ${dto.productId} is deactivated and cannot be used for a new deuda`,
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

      // D1: validated BEFORE any write, so a rejected initial abono rolls
      // back the whole request (no deudor/stock/Deuda change either) —
      // same all-or-nothing discipline as every other guard above.
      if (dto.abonoInicialMinor > 0)
        this.assertWithinBalance(0, totalMinor, dto.abonoInicialMinor);
      const settledAtCreation =
        dto.abonoInicialMinor > 0 && dto.abonoInicialMinor >= totalMinor;
      const now = new Date();

      const created = await tx.deuda.create({
        data: {
          id: createServerId(),
          contextId: actor.account.contextId,
          type: dto.type,
          deudorId,
          productId: product.id,
          cantidad: dto.cantidad,
          totalMinor,
          unitCostMinor: product.purchaseCostMinor,
          createdByMemberId: memberId,
          ...(settledAtCreation
            ? { status: 'saldada' as const, saldadaAt: now }
            : {}),
        },
      });

      if (dto.abonoInicialMinor > 0) {
        await tx.abono.create({
          data: {
            id: createServerId(),
            deudaId: created.id,
            contextId: actor.account.contextId,
            montoMinor: dto.abonoInicialMinor,
            receivedByMemberId: memberId,
            receivedAt: now,
          },
        });
      }

      if (dto.cuotasPlaneadas?.length) {
        await tx.cuotaPlaneada.createMany({
          data: dto.cuotasPlaneadas.map((cuota) => ({
            id: createServerId(),
            deudaId: created.id,
            contextId: actor.account.contextId,
            fechaEsperada: new Date(cuota.fechaEsperada),
            montoEsperadoMinor: cuota.montoEsperadoMinor,
          })),
        });
      }

      return tx.deuda.findUniqueOrThrow({
        where: { id: created.id },
        include: { abonos: true, cuotasPlaneadas: true },
      });
    });
    return response(deuda);
  }

  /**
   * Lists deudas for the authenticated context, optionally filtered by
   * `status`/`search`/`atrasado` and orderable by `createdAt` (default),
   * pending balance, or the earliest overdue planned installment.
   *
   * BE-15 (D6): `createdAt` ordering with no `atrasado` filter keeps the
   * original DB-level `orderBy`+`skip`/`take` (fast path, unchanged from
   * before this task). `atrasado` and the two computed sort orders
   * (`saldoPendiente`, `cuotaVencida`) are never stored columns — a
   * fragile computed-column raw SQL expression was deliberately rejected
   * in favor of fetching every matching Deuda for the context (bounded by
   * `contextId`/`status`/`search`, never by page size), computing
   * saldo/atrasado in application code (same in-memory-aggregation
   * discipline `ReportsService` already uses), then filtering/sorting/
   * paginating the resulting array — this project's actual scale (a
   * two-person bazar) makes that the simpler, more obviously-correct
   * choice over a harder-to-audit SQL expression, and this listing is not
   * a performance-critical path.
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

    const needsInMemory =
      query.atrasado !== undefined || query.orderBy !== 'createdAt';

    if (!needsInMemory) {
      const [items, total] = await this.prisma.$transaction(
        [
          this.prisma.deuda.findMany({
            where,
            include: { abonos: true, deudor: true, cuotasPlaneadas: true },
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

    const all = await this.prisma.deuda.findMany({
      where,
      include: { abonos: true, deudor: true, cuotasPlaneadas: true },
    });

    const now = new Date();
    type Computed = {
      deuda: (typeof all)[number];
      saldoPendienteMinor: number;
      atrasado: boolean;
      earliestOverdueFecha: Date | null;
    };
    const computed: Computed[] = all.map((deuda) => {
      // Plain integer sums (not dinero.js): every addend is already a
      // validated minor-unit integer within range (see toMinorUnits at
      // the point each was persisted); this mirrors the same "cheap
      // running sum in application code" style ReportsService/
      // computeProfitTotals already use for read-only aggregation, not a
      // value that gets re-persisted or fed back through money-precision-
      // sensitive arithmetic here.
      const paidMinor = deuda.abonos.reduce((sum, a) => sum + a.montoMinor, 0);
      const saldoPendienteMinor = deuda.totalMinor - paidMinor;
      const overdueCuotas = deuda.cuotasPlaneadas.filter(
        (c) => c.fechaEsperada.getTime() < now.getTime(),
      );
      const overdueExpectedMinor = overdueCuotas.reduce(
        (sum, c) => sum + c.montoEsperadoMinor,
        0,
      );
      const paidUpToNowMinor = deuda.abonos
        .filter((a) => a.receivedAt.getTime() <= now.getTime())
        .reduce((sum, a) => sum + a.montoMinor, 0);
      const atrasado =
        overdueCuotas.length > 0 && overdueExpectedMinor > paidUpToNowMinor;
      const earliestOverdueFecha = overdueCuotas.length
        ? overdueCuotas.reduce(
            (min, c) => (c.fechaEsperada < min ? c.fechaEsperada : min),
            overdueCuotas[0].fechaEsperada,
          )
        : null;
      return { deuda, saldoPendienteMinor, atrasado, earliestOverdueFecha };
    });

    const filtered =
      query.atrasado === undefined
        ? computed
        : computed.filter((c) => c.atrasado === query.atrasado);

    filtered.sort((a, b) => {
      if (query.orderBy === 'saldoPendiente') {
        return (
          b.saldoPendienteMinor - a.saldoPendienteMinor ||
          a.deuda.id.localeCompare(b.deuda.id)
        );
      }
      if (query.orderBy === 'cuotaVencida') {
        // No overdue cuota sorts last, regardless of direction — there is
        // nothing "earliest" to rank it by.
        if (a.earliestOverdueFecha === null && b.earliestOverdueFecha === null)
          return a.deuda.id.localeCompare(b.deuda.id);
        if (a.earliestOverdueFecha === null) return 1;
        if (b.earliestOverdueFecha === null) return -1;
        return (
          a.earliestOverdueFecha.getTime() - b.earliestOverdueFecha.getTime() ||
          a.deuda.id.localeCompare(b.deuda.id)
        );
      }
      // orderBy === 'createdAt', routed into this in-memory path only
      // because `atrasado` was also requested.
      const dir = query.sort === 'asc' ? 1 : -1;
      return (
        dir * (a.deuda.createdAt.getTime() - b.deuda.createdAt.getTime()) ||
        a.deuda.id.localeCompare(b.deuda.id)
      );
    });

    const total = filtered.length;
    const start = (query.page - 1) * query.limit;
    const items = filtered.slice(start, start + query.limit).map((c) => c.deuda);
    return { items, total, page: query.page, limit: query.limit };
  }

  /**
   * Retrieves one deuda together with its full abono history and planned
   * installments, scoped to the authenticated context via the
   * createdByMember relation (Deuda itself carries no `contextId` column,
   * matching Sale's convention).
   *
   * @throws NotFoundException when the deuda does not exist or belongs to
   * another context.
   */
  async findOne(contextId: string, id: string) {
    const deuda = await this.prisma.deuda.findFirst({
      where: { id, createdByMember: { contextId } },
      include: { abonos: true, deudor: true, cuotasPlaneadas: true },
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
   * abono that would exceed it is rejected outright via
   * {@link assertWithinBalance} — there is no partial application. When
   * an abono brings the sum of all abonos to exactly the total, `status`
   * is flipped to "saldada" **and `saldadaAt` is set to this exact
   * instant** in the same transaction (BE-15, D4) — this remains the
   * *only* way either field ever changes; there is no endpoint to set
   * them directly, and a Deuda that was already saldada before this
   * column existed keeps `saldadaAt: null` forever (no retroactive
   * backfill — that timestamp is genuinely unknown for those rows).
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

      // Locks by id AND contextId explicitly (BE-11 follow-up): raw
      // queries are the one code path the Prisma tenant-isolation
      // extension cannot see or inject into (see
      // src/database/tenant.extension.ts's own doc comment), so this
      // filter has to be written by hand — `actor.account.contextId` is
      // the same authoritative value AuthGuard already established for
      // this request (see src/database/tenant-context.ts), matching the
      // convention every other manual contextId assignment in this
      // entrega already follows. `existing` above already confirmed this
      // Deuda belongs to the actor's context, so this is defense in
      // depth, not the first line of defense; RLS (also strict as of
      // this follow-up) is the true backstop if this filter were ever
      // dropped by mistake.
      //
      // Kept as $queryRaw rather than rewritten with the Prisma Client:
      // Prisma has no query-builder API for `SELECT ... FOR UPDATE` (a
      // row lock hint) as of this project's Prisma version — a plain
      // `tx.deuda.findFirst(...)` here would not actually serialize two
      // concurrent abonos against the same Deuda, defeating the reason
      // this lock exists in the first place (see this method's own doc
      // comment on the FOR UPDATE lock above).
      await tx.$queryRaw`SELECT id FROM "Deuda" WHERE id = ${deudaId}::uuid AND "contextId" = ${actor.account.contextId} FOR UPDATE`;

      const paidSoFar = await tx.abono.aggregate({
        where: { deudaId },
        _sum: { montoMinor: true },
      });
      const paidMinor = paidSoFar._sum.montoMinor ?? 0;
      this.assertWithinBalance(paidMinor, existing.totalMinor, dto.montoMinor);

      await tx.abono.create({
        data: {
          id: createServerId(),
          deudaId,
          contextId: actor.account.contextId,
          montoMinor: dto.montoMinor,
          receivedByMemberId: memberId,
          nota: dto.nota,
        },
      });

      const newPaidMinor = toMinorUnits(
        add(toDinero(paidMinor), toDinero(dto.montoMinor)),
      );
      if (newPaidMinor >= existing.totalMinor) {
        await tx.deuda.update({
          where: { id: deudaId },
          data: { status: 'saldada', saldadaAt: new Date() },
        });
      }

      return tx.deuda.findUniqueOrThrow({
        where: { id: deudaId },
        include: { abonos: true, deudor: true, cuotasPlaneadas: true },
      });
    });
    return response(deuda);
  }

  /**
   * Adds one planned installment (BE-15, D3) to an existing Deuda.
   * Socio-only, same as creating the Deuda itself — this is planning the
   * schedule the socio agreed with the debtor, not collecting a payment.
   * Purely informative: it never touches `totalMinor`, the abono balance,
   * or `status` (see `CuotaPlaneada`'s own doc comment).
   *
   * @throws ForbiddenException via {@link authorize} (socio-only).
   * @throws NotFoundException when the deuda does not exist in this
   * context.
   */
  async addCuota(actor: Actor, deudaId: string, dto: CreateCuotaDto) {
    return this.prisma.$transaction(async (tx) => {
      await this.authorize(tx, actor, true);
      const deuda = await tx.deuda.findFirst({
        where: {
          id: deudaId,
          createdByMember: { contextId: actor.account.contextId },
        },
      });
      if (!deuda) throw new NotFoundException();
      return tx.cuotaPlaneada.create({
        data: {
          id: createServerId(),
          deudaId,
          contextId: actor.account.contextId,
          fechaEsperada: new Date(dto.fechaEsperada),
          montoEsperadoMinor: dto.montoEsperadoMinor,
        },
      });
    });
  }

  /**
   * Edits an existing planned installment. Socio-only; either field may
   * be omitted (partial edit).
   *
   * @throws ForbiddenException via {@link authorize} (socio-only).
   * @throws NotFoundException when the cuota does not exist for this
   * deuda in this context.
   */
  async updateCuota(
    actor: Actor,
    deudaId: string,
    cuotaId: string,
    dto: UpdateCuotaDto,
  ) {
    return this.prisma.$transaction(async (tx) => {
      await this.authorize(tx, actor, true);
      const cuota = await tx.cuotaPlaneada.findFirst({
        where: { id: cuotaId, deudaId, contextId: actor.account.contextId },
      });
      if (!cuota) throw new NotFoundException();
      return tx.cuotaPlaneada.update({
        where: { id: cuotaId },
        data: {
          ...(dto.fechaEsperada !== undefined
            ? { fechaEsperada: new Date(dto.fechaEsperada) }
            : {}),
          ...(dto.montoEsperadoMinor !== undefined
            ? { montoEsperadoMinor: dto.montoEsperadoMinor }
            : {}),
        },
      });
    });
  }

  /**
   * Removes a planned installment. Socio-only. A hard delete (unlike
   * Product/Member's soft delete): a planned-installment row carries no
   * historical meaning worth preserving once it no longer reflects the
   * agreed schedule — nothing else ever references it (it is never read
   * by any balance calculation), so there is no historical trail to
   * protect.
   *
   * @throws ForbiddenException via {@link authorize} (socio-only).
   * @throws NotFoundException when the cuota does not exist for this
   * deuda in this context.
   */
  async deleteCuota(actor: Actor, deudaId: string, cuotaId: string) {
    return this.prisma.$transaction(async (tx) => {
      await this.authorize(tx, actor, true);
      const cuota = await tx.cuotaPlaneada.findFirst({
        where: { id: cuotaId, deudaId, contextId: actor.account.contextId },
      });
      if (!cuota) throw new NotFoundException();
      return tx.cuotaPlaneada.delete({ where: { id: cuotaId } });
    });
  }
}

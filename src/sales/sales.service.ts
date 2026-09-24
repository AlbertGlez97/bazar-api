import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { add, multiply, subtract } from 'dinero.js';
import { createHash } from 'node:crypto';
import { toDinero, toMinorUnits } from '../common/money.js';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import type { Sale, SaleItem } from '../generated/prisma/client.js';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import type {
  CreateSaleDto,
  CreateSaleItemDto,
} from './dto/create-sale.dto.js';
import type { SaleListDto } from './dto/sale-list.dto.js';

type Actor = Pick<AuthenticatedRequest, 'account' | 'selection'>;
type SaleWithItems = Sale & { items: SaleItem[] };

/**
 * Thrown only for a genuine concurrency race — an item's stock was
 * sufficient moments ago (before this transaction contended for the row
 * lock) but insufficient once the lock was actually acquired, meaning a
 * concurrently-processed sale consumed it first. Distinct from
 * BadRequestException, which still covers a request that was already
 * unsatisfiable before any locking occurred (BE-05's plain "not enough
 * stock" case). {@link SalesService.create} catches this specifically to
 * persist a "rechazada_por_conflicto" sale instead of just rejecting.
 */
class SaleStockConflictError extends Error {}

// A duplicate `Sale.id` unique/primary-key violation only ever comes from
// this one constraint in the whole schema, but we still check `meta.target`
// rather than trusting the error code alone: P2002 is Prisma's generic
// "unique constraint failed" code and could in principle fire for some
// other constraint on the same table in the future. Matching on target
// keeps this handler from silently swallowing an unrelated uniqueness
// violation as if it were the sale-id race.
function isSaleIdConflict(
  err: unknown,
): err is Prisma.PrismaClientKnownRequestError {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (err.code !== 'P2002') return false;
  const adapter = err.meta?.driverAdapterError as
    { cause?: { table?: string; constraint?: { index?: string } } } | undefined;
  if (
    err.meta?.modelName === 'Sale' &&
    adapter?.cause?.table === 'Sale' &&
    adapter.cause.constraint?.index === 'Sale_pkey'
  )
    return true;
  const target = err.meta?.target;
  const targets = Array.isArray(target) ? target : [target];
  return targets.some(
    (value) =>
      typeof value === 'string' &&
      (value.includes('Sale_pkey') || value === 'id'),
  );
}

function response(sale: SaleWithItems) {
  const { items, ...header } = sale;
  return {
    ...header,
    items: items.map((item) => ({
      id: item.id,
      productId: item.productId,
      quantity: item.quantity,
      unitPriceMinor: item.unitPriceMinor,
      subtotalMinor: item.subtotalMinor,
      createdAt: item.createdAt,
    })),
  };
}

// A device that queued a sale offline can legitimately submit it hours or
// even a day or two later than `occurredAt`; a genuinely future date, or
// one implausibly far in the past, is more likely a clock bug on the
// device than a real sale. Either way BE-07 never blocks the sale over
// this alone (unlike stock/cash, which are hard business rules) — it only
// flags an Incidencia for a socio to look at, since the money and stock
// are already real and in hand.
const MAX_OCCURRED_AT_PAST_DAYS = 2;

function occurredAtIssue(occurredAt: Date, receivedAt: Date): string | null {
  const diffMs = occurredAt.getTime() - receivedAt.getTime();
  if (diffMs > 0) {
    const hours = (diffMs / 3_600_000).toFixed(1);
    return `occurredAt es ${hours}h posterior a receivedAt (fecha futura)`;
  }
  const pastDays = -diffMs / 86_400_000;
  if (pastDays > MAX_OCCURRED_AT_PAST_DAYS) {
    return `occurredAt es ${pastDays.toFixed(1)} días anterior a receivedAt (excede el máximo de ${MAX_OCCURRED_AT_PAST_DAYS} días)`;
  }
  return null;
}

// Order-independent comparison of {productId, quantity} pairs. Price is
// deliberately excluded: it is never client-authoritative (see
// CreateSaleItemDto.unitPriceMinor), so two requests describing the same
// items/quantities are the same sale regardless of what price, if any,
// the client happened to attach for its own logging.
function sameItems(
  existingItems: SaleItem[],
  dtoItems: CreateSaleItemDto[],
): boolean {
  if (existingItems.length !== dtoItems.length) return false;
  const byProduct = (a: { productId: string }, b: { productId: string }) =>
    a.productId.localeCompare(b.productId);
  const a = [...existingItems].sort(byProduct);
  const b = [...dtoItems].sort(byProduct);
  return a.every(
    (item, index) =>
      item.productId === b[index].productId &&
      item.quantity === b[index].quantity,
  );
}

/**
 * Decides whether a POST /sales carrying an id that already exists is a
 * legitimate resend of the exact same sale (offline sync retry, lost
 * response, etc.) rather than an id collision or a buggy re-send with
 * different data.
 *
 * Canonicalize attempted items as well as headers. Client prices are not
 * authoritative and remain excluded. Store only the fingerprint, not
 * an additional copy of the customer's request.
 */
function requestFingerprint(dto: CreateSaleDto): string {
  const items = dto.items
    .map(({ productId, quantity }) => ({ productId, quantity }))
    .sort(
      (a, b) =>
        a.productId.localeCompare(b.productId) || a.quantity - b.quantity,
    );
  return createHash('sha256')
    .update(
      JSON.stringify({
        memberId: dto.memberId,
        deviceId: dto.deviceId,
        currency: dto.currency,
        cashReceivedMinor: dto.cashReceivedMinor,
        occurredAt: new Date(dto.occurredAt).toISOString(),
        items,
      }),
    )
    .digest('hex');
}

function isIdempotentReplay(
  existing: SaleWithItems,
  dto: CreateSaleDto,
): boolean {
  const sameHeader =
    existing.memberId === dto.memberId &&
    existing.deviceId === dto.deviceId &&
    existing.currency === dto.currency &&
    existing.cashReceivedMinor === dto.cashReceivedMinor &&
    existing.occurredAt.getTime() === new Date(dto.occurredAt).getTime();
  if (!sameHeader) return false;
  if (existing.requestFingerprint)
    return existing.requestFingerprint === requestFingerprint(dto);
  // Historical rejected rows have no attempted items: fail closed, never
  // fabricate a fingerprint or accept a changed request as an exact replay.
  if (existing.status === 'rechazada_por_conflicto') return false;
  return sameItems(existing.items, dto.items);
}

@Injectable()
export class SalesService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * Re-validates the actor inside the transaction rather than trusting
   * {@link ContextGuard}'s pre-transaction read (mirrors
   * ProductsService.authorize), so a device deauthorized or a member
   * removed between the guard running and the transaction committing is
   * still honored.
   *
   * @throws ForbiddenException when there is no selection, or the account,
   * member or device do not resolve within the actor's `contextId` (the
   * device must additionally be `authorized`).
   */
  private async authorize(tx: Prisma.TransactionClient, actor: Actor) {
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
   * Registers a single in-person, cash-only, multi-item sale — or, on a
   * resend of the same client-generated `id`, replays or rejects it
   * idempotently instead of reprocessing (see {@link isIdempotentReplay}).
   *
   * The client's per-item `unitPriceMinor` (if sent) is only for the
   * frontend's own traceability/logging; the server always recalculates
   * every line from the *current* `Product.unitPriceMinor`, so a stale
   * offline price cache or a tampered payload cannot change what is
   * actually charged. Stock validation, the price/total/change
   * calculation and the Sale+SaleItem write all happen inside one
   * transaction: any failure — a nonexistent/foreign-context product,
   * insufficient stock on any single line from the very start, insufficient
   * cash, or a persistence error — rolls back every line already processed
   * in this request, so a sale is never applied partially.
   *
   * There is no fiado/apartado (deferred payment) path here: insufficient
   * cash simply rejects the whole sale rather than recording a partial
   * payment or a debtor.
   *
   * Stock races between offline sales synchronizing concurrently for the
   * same product are handled differently from a plain invalid request:
   * each item is read once *before* attempting its row lock (an
   * unlocked snapshot) and once more *after* acquiring the `FOR UPDATE`
   * lock. If the unlocked snapshot already showed insufficient stock, the
   * request was simply invalid from the start — BE-05's behavior applies
   * (400, nothing persisted). If the unlocked snapshot showed enough stock
   * but the post-lock read does not, another sale's transaction committed
   * a decrement while this one waited for the lock — a genuine race, which
   * this sale lost. The server does not resolve that race in favor of
   * whichever device's clock claims to be earlier (device clocks are not
   * trusted); it always favors whichever transaction the database itself
   * finishes processing (and thus locks/commits) first. The loser is not
   * discarded: it is persisted as `status = "rechazada_por_conflicto"`
   * with a `conflictReason` and `conflictDetectedAt`, with no stock
   * decremented and no items stored (there is nothing authoritative to
   * store — the sale never priced or applied any line), so it remains
   * available for a human to review and resolve with the customer. There
   * is deliberately no automatic resolution (refund, re-stocking,
   * reassigning the sale to different stock): that is a business decision
   * outside this system.
   *
   * @throws ForbiddenException when the body's `memberId`/`deviceId` do not
   * match the authenticated `x-member-id`/`x-device-id` selection (a
   * device cannot attribute a sale to a different member/device than the
   * one it was authorized for), or via {@link authorize}.
   * @throws ConflictException when `id` already exists with a payload that
   * does not match this request (see {@link isIdempotentReplay}) — a
   * resend must be identical, not merely share an id.
   * @throws BadRequestException when any item's product does not exist in
   * this context, any item's `quantity` exceeds that product's stock as
   * read before any row lock was attempted (for `unica` products, stock is
   * always 1, so any `quantity > 1` is rejected the same way), or
   * `cashReceivedMinor` is less than the server-calculated total.
   *
   * @returns `{ sale, created }` — `created` is `false` only for an
   * idempotent replay of an already-persisted sale (controller uses this
   * to answer 200 instead of 201); every other outcome that returns
   * normally (a fresh "completada" sale, or a "rechazada_por_conflicto"
   * sale persisted after losing a real stock race) is a genuinely new row
   * and answers 201.
   */
  async create(actor: Actor, dto: CreateSaleDto) {
    // The persisted sale attributes its member/device from the authenticated
    // header-selected context, not from client-declared body fields; both
    // must agree so a device cannot attribute a sale to another selection.
    if (
      !actor.selection ||
      dto.memberId !== actor.selection.memberId ||
      dto.deviceId !== actor.selection.deviceId
    ) {
      throw new ForbiddenException(
        'Sale attribution must match the authenticated selection',
      );
    }

    const existing = await this.prisma.sale.findUnique({
      where: { id: dto.id },
      include: { items: true },
    });
    if (existing) {
      if (isIdempotentReplay(existing, dto))
        return { sale: response(existing), created: false };
      throw new ConflictException(
        `Sale ${dto.id} already exists with different data`,
      );
    }

    try {
      const sale = await this.prisma.$transaction(async (tx) => {
        const { memberId, deviceId } = await this.authorize(tx, actor);
        let totalDinero = toDinero(0);
        const lines: {
          productId: string;
          quantity: number;
          unitPriceMinor: number;
          subtotalMinor: number;
        }[] = [];
        // Items are processed sequentially (not in parallel) so repeated
        // productIds within the same sale see each other's stock decrements.
        for (const item of dto.items) {
          // Unlocked snapshot, taken before contending for the row lock:
          // reveals whether this item was already unsatisfiable before our
          // own transaction could possibly have raced anyone for it.
          const before = await tx.product.findFirst({
            where: { id: item.productId, contextId: actor.account.contextId },
          });
          if (!before)
            throw new BadRequestException(
              `Product ${item.productId} does not exist in this context`,
            );
          if (item.quantity > before.stock)
            throw new BadRequestException(
              `Insufficient stock for product ${item.productId}`,
            );

          await tx.$queryRaw`SELECT id FROM "Product" WHERE id = ${item.productId}::uuid AND "contextId" = ${actor.account.contextId} FOR UPDATE`;
          const product = await tx.product.findFirst({
            where: { id: item.productId, contextId: actor.account.contextId },
          });
          if (!product)
            throw new BadRequestException(
              `Product ${item.productId} does not exist in this context`,
            );
          if (item.quantity > product.stock)
            // Sufficient a moment ago, insufficient now that we hold the
            // lock: a concurrently-processed sale won the race for this
            // stock while we waited. Not the requester's fault.
            throw new SaleStockConflictError(
              `stock insuficiente al sincronizar: producto ${item.productId}, solicitado ${item.quantity}, disponible ${product.stock}`,
            );

          await tx.product.update({
            where: { id: product.id },
            data: { stock: product.stock - item.quantity },
          });
          const unitPriceMinor = product.unitPriceMinor;
          const subtotalMinor = toMinorUnits(
            multiply(toDinero(unitPriceMinor), item.quantity),
          );
          totalDinero = add(totalDinero, toDinero(subtotalMinor));
          lines.push({
            productId: product.id,
            quantity: item.quantity,
            unitPriceMinor,
            subtotalMinor,
          });
        }
        const totalMinor = toMinorUnits(totalDinero);
        if (dto.cashReceivedMinor < totalMinor)
          throw new BadRequestException(
            'Cash received is insufficient for the calculated total',
          );
        const changeMinor = toMinorUnits(
          subtract(toDinero(dto.cashReceivedMinor), toDinero(totalMinor)),
        );
        const receivedAt = new Date();
        const occurredAt = new Date(dto.occurredAt);
        // Flagged, never blocking: the cash and stock are already
        // real/committed by this point, so an implausible occurredAt is
        // handled as a data-quality signal for a socio to review, not a
        // reason to refuse a sale that is otherwise entirely valid.
        const dateIssue = occurredAtIssue(occurredAt, receivedAt);
        const created = await tx.sale.create({
          data: {
            id: dto.id,
            requestFingerprint: requestFingerprint(dto),
            memberId,
            deviceId,
            occurredAt,
            receivedAt,
            currency: dto.currency,
            status: 'completada',
            totalMinor,
            cashReceivedMinor: dto.cashReceivedMinor,
            changeMinor,
            items: {
              create: lines.map((line) => ({
                productId: line.productId,
                quantity: line.quantity,
                unitPriceMinor: line.unitPriceMinor,
                subtotalMinor: line.subtotalMinor,
              })),
            },
            ...(dateIssue
              ? {
                  incidencias: {
                    create: {
                      type: 'incidencia_fecha',
                      reason: dateIssue,
                    },
                  },
                }
              : {}),
          },
          include: { items: true },
        });
        return created;
      });
      return { sale: response(sale), created: true };
    } catch (err) {
      if (
        isSaleIdConflict(err) ||
        err instanceof SaleStockConflictError ||
        err instanceof BadRequestException
      ) {
        // Two requests carrying the same brand-new id raced each other:
        // both passed the pre-check above as "does not exist yet", but
        // only one `tx.sale.create` could win the id's primary key. The
        // loser re-reads what the winner actually persisted and applies
        // the exact same idempotency rule as a normal resend (see
        // isIdempotentReplay) — it must not surface as a generic 500, and
        // it must not silently pretend to have created a second sale.
        const persisted = await this.prisma.sale.findUnique({
          where: { id: dto.id },
          include: { items: true },
        });
        if (persisted && isIdempotentReplay(persisted, dto))
          return { sale: response(persisted), created: false };
        if (persisted || isSaleIdConflict(err))
          throw new ConflictException(
            `Sale ${dto.id} already exists with different data`,
          );
      }
      if (!(err instanceof SaleStockConflictError)) throw err;
      // The failed attempt above was fully rolled back (no stock touched,
      // no Sale/SaleItem rows from it survive); this is a fresh, separate
      // write recording the rejection itself, together with the
      // Incidencia a socio will use to review/resolve it manually.
      const rejected = await this.prisma.sale
        .create({
          data: {
            id: dto.id,
            requestFingerprint: requestFingerprint(dto),
            memberId: dto.memberId,
            deviceId: dto.deviceId,
            occurredAt: new Date(dto.occurredAt),
            currency: dto.currency,
            status: 'rechazada_por_conflicto',
            cashReceivedMinor: dto.cashReceivedMinor,
            conflictReason: err.message,
            conflictDetectedAt: new Date(),
            incidencias: {
              create: {
                type: 'conflicto_stock',
                reason: err.message,
              },
            },
          },
          include: { items: true },
        })
        .then((sale) => ({ sale: response(sale), created: true }))
        .catch(async (error: unknown) => {
          if (!isSaleIdConflict(error)) throw error;
          const persisted = await this.prisma.sale.findUnique({
            where: { id: dto.id },
            include: { items: true },
          });
          if (persisted && isIdempotentReplay(persisted, dto))
            return { sale: response(persisted), created: false };
          throw new ConflictException(
            `Sale ${dto.id} already exists with different data`,
          );
        });
      return rejected;
    }
  }

  /**
   * Retrieves a previously persisted sale by id, scoped to the
   * authenticated context via the Member relation (Sale itself carries no
   * `contextId` column). Used, among other things, so a client that lost
   * the HTTP response to a sale it already submitted can re-fetch the
   * confirmed result instead of assuming it failed. Returns a
   * "rechazada_por_conflicto" sale the same way as a "completada" one; the
   * `status` field is how a caller distinguishes them.
   *
   * @throws NotFoundException when the sale does not exist or belongs to
   * another context (both must be indistinguishable to the caller).
   */
  async findOne(contextId: string, id: string) {
    const sale = await this.prisma.sale.findFirst({
      where: { id, member: { contextId } },
      include: { items: true },
    });
    if (!sale) throw new NotFoundException();
    return response(sale);
  }

  /**
   * Lists sales for the authenticated context, optionally filtered to a
   * single `status`. Exists primarily so `rechazada_por_conflicto` sales
   * — which are never surfaced by {@link create}'s caller as a normal
   * success — can still be found and manually reviewed/resolved with the
   * customer; there is no endpoint that resolves them automatically.
   *
   * Restricted to socios at the controller (see {@link SocioGuard}): a
   * colaborador may register sales but should not see the full
   * "movimientos" history of everyone else's sales, only their own
   * receipts via {@link findOne}. Paginated, searchable by the selling
   * Member's name and orderable by `receivedAt`, mirroring
   * ProductsService.list's pattern (BE-04) so a socio's review workflow
   * behaves consistently across both listings.
   */
  async list(contextId: string, query: SaleListDto) {
    const where = {
      member: {
        contextId,
        ...(query.search
          ? { name: { contains: query.search, mode: 'insensitive' as const } }
          : {}),
      },
      ...(query.status ? { status: query.status } : {}),
    };
    const [sales, total] = await this.prisma.$transaction(
      [
        this.prisma.sale.findMany({
          where,
          include: { items: true },
          orderBy: [{ receivedAt: query.sort }, { id: 'asc' }],
          skip: (query.page - 1) * query.limit,
          take: query.limit,
        }),
        this.prisma.sale.count({ where }),
      ],
      { isolationLevel: 'RepeatableRead' },
    );
    return {
      items: sales.map(response),
      total,
      page: query.page,
      limit: query.limit,
    };
  }
}

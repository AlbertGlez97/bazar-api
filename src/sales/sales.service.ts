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
import type { Prisma, Sale, SaleItem } from '../generated/prisma/client.js';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import type { CreateSaleDto } from './dto/create-sale.dto.js';

type Actor = Pick<AuthenticatedRequest, 'account' | 'selection'>;
type SaleWithItems = Sale & { items: SaleItem[] };

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
   * Registers a single in-person, cash-only, multi-item sale.
   *
   * The client's per-item `unitPriceMinor` (if sent) is only for the
   * frontend's own traceability/logging; the server always recalculates
   * every line from the *current* `Product.unitPriceMinor`, so a stale
   * offline price cache or a tampered payload cannot change what is
   * actually charged. Stock validation, the price/total/change
   * calculation and the Sale+SaleItem write all happen inside one
   * transaction: any failure — a nonexistent/foreign-context product,
   * insufficient stock on any single line, insufficient cash, or a
   * persistence error — rolls back every line already processed in this
   * request, so a sale is never applied partially.
   *
   * There is no fiado/apartado (deferred payment) path here: insufficient
   * cash simply rejects the whole sale rather than recording a partial
   * payment or a debtor.
   *
   * @throws ForbiddenException when the body's `memberId`/`deviceId` do not
   * match the authenticated `x-member-id`/`x-device-id` selection (a
   * device cannot attribute a sale to a different member/device than the
   * one it was authorized for), or via {@link authorize}.
   * @throws BadRequestException when any item's product does not exist in
   * this context, any item's `quantity` exceeds that product's current
   * stock (for `unica` products, stock is always 1, so any `quantity > 1`
   * is rejected the same way), or `cashReceivedMinor` is less than the
   * server-calculated total.
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
        await tx.$queryRaw`SELECT id FROM "Product" WHERE id = ${item.productId}::uuid AND "contextId" = ${actor.account.contextId} FOR UPDATE`;
        const product = await tx.product.findFirst({
          where: { id: item.productId, contextId: actor.account.contextId },
        });
        if (!product)
          throw new BadRequestException(
            `Product ${item.productId} does not exist in this context`,
          );
        if (item.quantity > product.stock)
          throw new BadRequestException(
            `Insufficient stock for product ${item.productId}`,
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
      return tx.sale.create({
        data: {
          id: dto.id,
          memberId,
          deviceId,
          occurredAt: new Date(dto.occurredAt),
          currency: dto.currency,
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
        },
        include: { items: true },
      });
    });
    return response(sale);
  }

  /**
   * Retrieves a previously persisted sale by id, scoped to the
   * authenticated context via the Member relation (Sale itself carries no
   * `contextId` column). Used, among other things, so a client that lost
   * the HTTP response to a sale it already submitted can re-fetch the
   * confirmed result instead of assuming it failed.
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
}

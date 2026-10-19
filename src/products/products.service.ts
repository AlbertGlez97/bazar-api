import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma, type Product } from '../generated/prisma/client.js';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import type {
  CreateProductDto,
  PatchProductDto,
  ProductListDto,
  RestockProductDto,
} from './dto/product.dto.js';
import { StorageService } from '../storage/storage.service.js';
import { createServerId } from '../common/server-id.js';
import { isRequestingSocio } from '../auth/socio-check.util.js';
import { MAX_MINOR_UNITS } from '../common/money.js';
import { nextProductCost } from './restock-cost.js';

type Actor = Pick<AuthenticatedRequest, 'account' | 'selection'>;
/**
 * The Product's own current fields are already the source of truth for a
 * product's audit history, so a full field-by-field snapshot (rather than
 * only the price) is stored on every audit row — otherwise a metadata-only
 * edit (e.g. notes, supplier) would leave no record of what changed.
 */
function snapshot(product: Product): Prisma.InputJsonObject {
  return {
    name: product.name,
    tipo: product.tipo,
    unitPriceMinor: product.unitPriceMinor,
    initialStock: product.initialStock,
    stock: product.stock,
    imagePath: product.imagePath,
    category: product.category,
    purchaseCostMinor: product.purchaseCostMinor,
    supplier: product.supplier,
    notes: product.notes,
    brand: product.brand,
    presentation: product.presentation,
    description: product.description,
  };
}

/** Most distinct brands (and presentations) offered as suggestions. */
const MAX_SUGGESTIONS = 200;

/**
 * Distinct values with the first spelling of each, ignoring upper/lower case
 * ("Nike", "NIKE" and "nike" are one suggestion). The input is already sorted.
 */
function distinctIgnoringCase(values: Array<string | null>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (value === null) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

/** Fields only a socio may read: what the product cost, who supplies it and the internal notes. */
const SOCIO_ONLY_FIELDS = ['purchaseCostMinor', 'supplier', 'notes'];

/** A JSON audit snapshot without the socio-only fields (a colaborador never sees them). */
function withoutCost(snapshotValue: unknown): unknown {
  if (
    typeof snapshotValue !== 'object' ||
    snapshotValue === null ||
    Array.isArray(snapshotValue)
  )
    return snapshotValue;
  return Object.fromEntries(
    Object.entries(snapshotValue).filter(([key]) => !SOCIO_ONLY_FIELDS.includes(key)),
  );
}

@Injectable()
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name);
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(StorageService) private readonly storage: StorageService,
  ) {}

  /**
   * `withCost: false` (anyone who is not an active socio reading the catalog) leaves
   * out the purchase cost, the supplier and the notes: the keys are absent, not null,
   * because null would read as "none yet". Every write endpoint is socio-only and keeps them.
   */
  private response(product: Product, withCost = true) {
    const { imagePath, purchaseCostMinor, supplier, notes, ...data } = product;
    return {
      ...data,
      ...(withCost ? { purchaseCostMinor, supplier, notes } : {}),
      // The stored imagePath is an internal storage key, not a public URL;
      // never leak it — only expose the derived, servable URL.
      image: imagePath ? this.storage.getUrl(imagePath) : null,
    };
  }

  /**
   * Re-checks, inside the same transaction that will write the mutation,
   * that the account is active and that the selected member/device both
   * belong to it and that the member has the `socio` role. This does not
   * merely repeat {@link SocioGuard}: the guard runs before the
   * transaction starts, so without this re-check a revoked device, a
   * role change or a member deactivated concurrently would not be
   * honored for a request already past the guard but not yet committed.
   *
   * @throws ForbiddenException when there is no selection, or the account,
   * member (with role `socio`) or device do not resolve within the actor's
   * `contextId`.
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
        id: actor.selection?.memberId ?? '',
        contextId: actor.account.contextId,
        role: 'socio',
        active: true,
      },
    });
    const device = await tx.device.findFirst({
      where: {
        id: actor.selection?.deviceId ?? '',
        contextId: actor.account.contextId,
        authorized: true,
      },
    });
    if (!account || !member || !device) throw new ForbiddenException();
    return member.id;
  }
  /**
   * Creates a single audit row per mutation, capturing actor, timestamp and
   * before/after snapshots so price and metadata changes remain traceable
   * without ever deleting or overwriting history (creations have no
   * `before`). `oldUnitPriceMinor`/`newUnitPriceMinor` are denormalized
   * alongside the JSON snapshots specifically to keep price-change queries
   * (e.g. "who changed this product's price and when") simple and indexed,
   * without parsing JSON.
   */
  private async audit(
    tx: Prisma.TransactionClient,
    memberId: string,
    product: Product,
    before?: Product,
  ) {
    await tx.productAudit.create({
      data: {
        id: createServerId(),
        productId: product.id,
        memberId,
        contextId: product.contextId,
        // Capture time after acquiring the row lock, not transaction start time.
        changedAt: new Date(),
        oldUnitPriceMinor: before?.unitPriceMinor ?? null,
        newUnitPriceMinor: product.unitPriceMinor,
        before: before ? snapshot(before) : Prisma.DbNull,
        after: snapshot(product),
      },
    });
  }
  /**
   * Creates a product for the actor's context.
   *
   * A `unica` (unique-piece) product always starts at stock 1 regardless
   * of any `initialStock` the DTO may carry — a unique piece cannot have
   * more or less than one unit by definition, so the field is silently
   * normalized rather than rejected. Creation and its audit row are
   * written in the same transaction so a product is never persisted
   * without a corresponding "who created this and at what price" record.
   *
   * @throws ForbiddenException via {@link authorize} when the actor is not
   * an authorized socio for this context.
   */
  create(actor: Actor, dto: CreateProductDto) {
    const initialStock = dto.tipo === 'unica' ? 1 : dto.initialStock!;
    return this.prisma.$transaction(async (tx) => {
      const memberId = await this.authorize(tx, actor);
      const product = await tx.product.create({
        data: {
          id: createServerId(),
          name: dto.name,
          tipo: dto.tipo,
          unitPriceMinor: dto.unitPriceMinor,
          category: dto.category,
          purchaseCostMinor: dto.purchaseCostMinor,
          supplier: dto.supplier,
          notes: dto.notes,
          brand: dto.brand,
          presentation: dto.presentation,
          description: dto.description,
          contextId: actor.account.contextId,
          initialStock,
          stock: initialStock,
        },
      });
      await this.audit(tx, memberId, product);
      return this.response(product);
    });
  }
  /**
   * Shared by `patch` and `image`: locks the product row first (before
   * authorization/read), so concurrent edits to the same product serialize
   * instead of racing. Without that lock ordering, two concurrent PATCHes
   * could both read the same "before" state and each record a different,
   * both-wrong predecessor price in their audit rows; the lock guarantees
   * the second edit's `before` snapshot is the true result of the first.
   *
   * @throws NotFoundException when the product does not exist in this
   * context (including a product belonging to another context, which must
   * be indistinguishable from nonexistent).
   * @throws BadRequestException when `data.purchaseCostMinor` would clear
   * (set to `null`) a cost the product already has (BE-13): once a
   * product's cost is known, later profit reports must keep being able to
   * rely on it, so it can only ever be corrected to another value, never
   * blanked out again. A product that never had a cost is unaffected —
   * `undefined` (field simply not present in the update) never triggers
   * this check.
   */
  private async mutate(
    actor: Actor,
    id: string,
    data: Prisma.ProductUpdateInput,
  ) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Product" WHERE id = ${id}::uuid AND "contextId" = ${actor.account.contextId} FOR UPDATE`;
      const memberId = await this.authorize(tx, actor);
      const before = await tx.product.findFirst({
        where: { id, contextId: actor.account.contextId },
      });
      if (!before) throw new NotFoundException();
      if (before.purchaseCostMinor !== null && data.purchaseCostMinor === null)
        throw new BadRequestException(
          'purchaseCostMinor cannot be cleared once it has been set',
        );
      const product = await tx.product.update({ where: { id }, data });
      await this.audit(tx, memberId, product, before);
      return this.response(product);
    });
  }
  /**
   * Edits price/metadata fields only. `tipo`, `initialStock` and `stock`
   * are intentionally not editable here: type and initial stock describe
   * how the product was created, and current `stock` is only meant to
   * change through sales/inventory movements, not a direct administrative
   * overwrite that could silently hide a sale or a discrepancy.
   *
   * @throws BadRequestException when every field in the DTO is `undefined`
   * (a PATCH with no actual change is rejected rather than creating a
   * vacuous audit row).
   */
  patch(actor: Actor, id: string, dto: PatchProductDto) {
    if (Object.values(dto).every((value) => value === undefined))
      throw new BadRequestException('At least one editable field is required');
    return this.mutate(actor, id, {
      name: dto.name,
      unitPriceMinor: dto.unitPriceMinor,
      category: dto.category,
      purchaseCostMinor: dto.purchaseCostMinor,
      supplier: dto.supplier,
      notes: dto.notes,
      brand: dto.brand,
      presentation: dto.presentation,
      description: dto.description,
    });
  }
  /**
   * Adds pieces to a "por cantidad" product (a restock) and records it.
   *
   * The stock is raised with a database-side increment (`stock = stock + n`),
   * never by reading it and writing back a computed value, so two restocks
   * running at once both count. That statement also takes the row lock, which
   * the rest of the transaction holds until commit: a concurrent restock waits
   * at its own increment and then sees this one's cost and stock. The
   * increment's `where` carries every rule (right context, `cantidad`, active,
   * no overflow of the Int range) so none of them can change between a check
   * and the write.
   *
   * In the same transaction: the weighted-average product cost
   * ({@link nextProductCost}, only when the purchase cost was given), one
   * {@link ProductAudit} row (stock and cost before/after, who, when) and one
   * append-only `StockMovement`.
   *
   * Rejections: 404 when the product does not exist in this context; 400 for
   * a unique piece (única products are never restocked), a deactivated
   * product (reactivate it first) or a stock that would exceed the maximum.
   *
   * @returns the updated product and the movement.
   */
  restock(actor: Actor, id: string, dto: RestockProductDto) {
    return this.prisma.$transaction(async (tx) => {
      const memberId = await this.authorize(tx, actor);
      const contextId = actor.account.contextId;
      let incremented: Product;
      try {
        incremented = await tx.product.update({
          where: {
            id,
            contextId,
            tipo: 'cantidad',
            active: true,
            stock: { lte: MAX_MINOR_UNITS - dto.quantity },
          },
          data: { stock: { increment: dto.quantity } },
        });
      } catch (error) {
        if (
          !(error instanceof Prisma.PrismaClientKnownRequestError) ||
          error.code !== 'P2025'
        )
          throw error;
        throw await this.explainRestockRejection(tx, id, contextId);
      }

      const stockBefore = incremented.stock - dto.quantity;
      // The cost has not been written yet, so what came back is the cost
      // before this restock (and, holding the row lock, the latest committed).
      const before: Product = { ...incremented, stock: stockBefore };
      const nextCost = nextProductCost({
        stockBefore,
        costBeforeMinor: incremented.purchaseCostMinor,
        quantity: dto.quantity,
        unitCostMinor: dto.unitCostMinor,
      });
      const product =
        nextCost === undefined || nextCost === incremented.purchaseCostMinor
          ? incremented
          : await tx.product.update({
              where: { id },
              data: { purchaseCostMinor: nextCost },
            });

      await this.audit(tx, memberId, product, before);
      const movement = await tx.stockMovement.create({
        data: {
          id: createServerId(),
          contextId,
          productId: id,
          memberId,
          type: 'REPOSICION',
          quantity: dto.quantity,
          stockBefore,
          stockAfter: product.stock,
          unitCostMinor: dto.unitCostMinor ?? null,
          note: dto.note ?? null,
        },
      });
      return { product: this.response(product), movement };
    });
  }

  /** Why the guarded increment of {@link restock} matched no row. */
  private async explainRestockRejection(
    tx: Prisma.TransactionClient,
    id: string,
    contextId: string,
  ) {
    const product = await tx.product.findFirst({ where: { id, contextId } });
    if (!product) return new NotFoundException();
    if (product.tipo !== 'cantidad')
      return new BadRequestException(
        'Only products sold by quantity can be restocked',
      );
    if (!product.active)
      return new BadRequestException(
        'A deactivated product cannot be restocked; reactivate it first',
      );
    return new BadRequestException(
      'The resulting stock would exceed the maximum allowed',
    );
  }

  /**
   * Lists a context's catalog, optionally filtered by a case-insensitive
   * name search, paginated (added in BE-04). Count and page are read in
   * the same `RepeatableRead` transaction so a page and its reported
   * `total` describe one consistent snapshot even if products are being
   * created/edited concurrently — otherwise a page boundary could shift
   * mid-scroll and duplicate or skip an item.
   *
   * `umbral` (BE-14), when present, additionally filters to `stock <=
   * umbral` — same name/semantics as {@link DashboardService.summary}'s own
   * `umbral`, but with no server-applied default: absent means unfiltered,
   * only the caller opts into a threshold.
   *
   * `agotados` (stock = 0), `sinCosto` (no purchase cost) and `tipo` follow
   * the same opt-in rule: they only narrow the result when truthy/present
   * (`false` is the same as omitted) and are applied in the database, never
   * on the returned page, so `total` and pagination stay correct.
   *
   * Deactivated products are excluded by default (BE-10). `includeInactive:
   * true` is only honored when the request also identifies an active
   * socio via the optional `x-member-id` header ({@link isRequestingSocio})
   * — this is a deliberately lightweight check (no `x-device-id`/full
   * {@link ContextGuard} selection required) because this listing is also
   * used *before* any Member has been selected (e.g. to populate the
   * person selector), so it cannot require a selection to already exist.
   * For a colaborador (or a request with no/invalid member header), the
   * parameter is silently ignored rather than rejected with 403: the
   * overwhelmingly likely cause is a stale/accidental query parameter
   * from the frontend, not a malicious attempt to browse a deactivated
   * catalog, and showing a deactivated product's name/id carries low risk
   * even if it did happen — so there is no need to surface an error for
   * it.
   */
  async list(
    contextId: string,
    query: ProductListDto,
    requestingMemberId: string | undefined,
    accountMemberId: string | null,
  ) {
    const isSocio = await isRequestingSocio(
      this.prisma,
      contextId,
      requestingMemberId,
      accountMemberId,
    );
    const includeInactive = query.includeInactive && isSocio;
    const where = {
      contextId,
      ...(includeInactive ? {} : { active: true }),
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' as const } },
              { brand: { contains: query.search, mode: 'insensitive' as const } },
              {
                presentation: {
                  contains: query.search,
                  mode: 'insensitive' as const,
                },
              },
            ],
          }
        : {}),
      ...(query.brand
        ? { brand: { equals: query.brand, mode: 'insensitive' as const } }
        : {}),
      // `agotados` (stock = 0) wins over `umbral`: umbral is validated >= 0,
      // so "stock <= umbral AND stock = 0" is always just "stock = 0".
      ...(query.agotados
        ? { stock: 0 }
        : query.umbral !== undefined
          ? { stock: { lte: query.umbral } }
          : {}),
      ...(query.sinCosto ? { purchaseCostMinor: null } : {}),
      ...(query.tipo ? { tipo: query.tipo } : {}),
    };
    const [items, total] = await this.prisma.$transaction(
      [
        this.prisma.product.findMany({
          where,
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          skip: (query.page - 1) * query.limit,
          take: query.limit,
        }),
        this.prisma.product.count({ where }),
      ],
      { isolationLevel: 'RepeatableRead' },
    );
    return {
      items: items.map((product) => this.response(product, isSocio)),
      total,
      page: query.page,
      limit: query.limit,
    };
  }
  /**
   * Retrieves a single product's detail (any authenticated account may
   * read it, matching {@link list}). Deliberately does *not* filter by
   * `active`: a deactivated product must still be individually fetchable
   * (e.g. from a historical sale's line item, or a catalog-management
   * screen showing "why is this hidden"), only the default *listing* hides
   * it.
   *
   * @throws NotFoundException when the product does not exist in this
   * context (including a product belonging to another context, which
   * must be indistinguishable from nonexistent).
   */
  async findOne(
    contextId: string,
    id: string,
    requestingMemberId: string | undefined,
    accountMemberId: string | null,
  ) {
    const product = await this.prisma.product.findFirst({
      where: { id, contextId },
    });
    if (!product) throw new NotFoundException();
    const isSocio = await isRequestingSocio(
      this.prisma,
      contextId,
      requestingMemberId,
      accountMemberId,
    );
    return this.response(product, isSocio);
  }
  /**
   * Distinct brands and presentations already used by the context's ACTIVE
   * products, to offer them as suggestions in the product form (socios only).
   * Nothing else about the products is read or returned. At most
   * {@link MAX_SUGGESTIONS} of each, alphabetical; spellings that differ only
   * in upper/lower case count once.
   */
  async suggestions(contextId: string) {
    const [brands, presentations] = await Promise.all([
      this.prisma.product.findMany({
        where: { contextId, active: true, brand: { not: null } },
        distinct: ['brand'],
        select: { brand: true },
        orderBy: { brand: 'asc' },
        take: MAX_SUGGESTIONS,
      }),
      this.prisma.product.findMany({
        where: { contextId, active: true, presentation: { not: null } },
        distinct: ['presentation'],
        select: { presentation: true },
        orderBy: { presentation: 'asc' },
        take: MAX_SUGGESTIONS,
      }),
    ]);
    return {
      brands: distinctIgnoringCase(brands.map((row) => row.brand)),
      presentations: distinctIgnoringCase(
        presentations.map((row) => row.presentation),
      ),
    };
  }
  /**
   * Soft-deletes (`active: false`) a product. Never a physical delete:
   * every historical reference (SaleItem, ProductAudit, Deuda) must keep
   * resolving exactly as before, and a socio may want to re-list the same
   * product later without losing its price/audit history.
   *
   * Idempotent: deactivating an already-inactive product is a no-op that
   * still returns 200 with the current state, rather than a 409 — there
   * is no data-provenance concern here (unlike, e.g., resolving an
   * Incidencia twice), so treating a repeat request as an error would
   * only make the frontend's retry/refresh logic more complicated for no
   * safety benefit.
   *
   * Selling a now-inactive product is separately rejected in
   * {@link SalesService}/{@link DeudasService}, even though its `stock`
   * field is left untouched here — deactivation is about visibility/
   * sellability, not an inventory adjustment. Deliberately does not write
   * a {@link ProductAudit} row: that trail exists for price/metadata
   * changes a socio needs to reconstruct ("who changed the price and
   * when"), not for the active flag, which is already fully described by
   * the current row state.
   *
   * @throws NotFoundException when the product does not exist in this
   * context.
   */
  async deactivate(actor: Actor, id: string) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Product" WHERE id = ${id}::uuid AND "contextId" = ${actor.account.contextId} FOR UPDATE`;
      await this.authorize(tx, actor);
      const product = await tx.product.findFirst({
        where: { id, contextId: actor.account.contextId },
      });
      if (!product) throw new NotFoundException();
      if (!product.active) return this.response(product);
      const updated = await tx.product.update({
        where: { id },
        data: { active: false },
      });
      return this.response(updated);
    });
  }
  /**
   * Reverses {@link deactivate}. A dedicated endpoint (rather than
   * folding `active` into {@link patch}'s general DTO) so reactivation
   * stays a one-field, no-body operation and never gets tangled with
   * `PatchProductDto`'s "at least one field required" rule for metadata
   * edits.
   *
   * Idempotent for the same reason as {@link deactivate}: reactivating an
   * already-active product is a harmless no-op, not an error.
   *
   * @throws NotFoundException when the product does not exist in this
   * context.
   */
  async reactivate(actor: Actor, id: string) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Product" WHERE id = ${id}::uuid AND "contextId" = ${actor.account.contextId} FOR UPDATE`;
      await this.authorize(tx, actor);
      const product = await tx.product.findFirst({
        where: { id, contextId: actor.account.contextId },
      });
      if (!product) throw new NotFoundException();
      if (product.active) return this.response(product);
      const updated = await tx.product.update({
        where: { id },
        data: { active: true },
      });
      return this.response(updated);
    });
  }
  /**
   * Lists a product's paginated audit trail (any authenticated account may
   * read it; only socios may write it). Existence is checked scoped to
   * `contextId` first and returns `NotFoundException` for a foreign-context
   * product, so an account cannot use this endpoint to probe which product
   * ids exist in another bazar's catalog.
   */
  async audits(
    contextId: string,
    id: string,
    query: ProductListDto,
    requestingMemberId: string | undefined,
    accountMemberId: string | null,
  ) {
    if (!(await this.prisma.product.findFirst({ where: { id, contextId } })))
      throw new NotFoundException();
    const isSocio = await isRequestingSocio(
      this.prisma,
      contextId,
      requestingMemberId,
      accountMemberId,
    );
    const where = { productId: id, product: { contextId } };
    const [items, total] = await this.prisma.$transaction(
      [
        this.prisma.productAudit.findMany({
          where,
          orderBy: [{ changedAt: 'asc' }, { id: 'asc' }],
          skip: (query.page - 1) * query.limit,
          take: query.limit,
        }),
        this.prisma.productAudit.count({ where }),
      ],
      { isolationLevel: 'RepeatableRead' },
    );
    return {
      items: isSocio
        ? items
        : items.map((audit) => ({
            ...audit,
            before: withoutCost(audit.before),
            after: withoutCost(audit.after),
          })),
      total,
      page: query.page,
      limit: query.limit,
    };
  }
  /**
   * Replaces a product's image. The file is decoded/validated and saved to
   * storage *before* the database mutation runs, and is deleted again if
   * that mutation then fails — an uploaded file must never be referenced
   * by a product row that doesn't (or no longer) exists, but a failure to
   * delete the orphan is only logged, not thrown, so a storage cleanup
   * hiccup does not mask the original database error to the caller.
   *
   * @throws NotFoundException when the product does not exist in this
   * context.
   */
  async image(actor: Actor, id: string, file: Express.Multer.File) {
    if (
      !(await this.prisma.product.findFirst({
        where: { id, contextId: actor.account.contextId },
      }))
    )
      throw new NotFoundException();
    const saved = await this.storage.save(file);
    try {
      return await this.mutate(actor, id, { imagePath: saved.path });
    } catch (error) {
      try {
        await this.storage.remove(saved.path);
      } catch {
        this.logger.error(
          `Failed to remove orphaned product image ${saved.path}`,
        );
      }
      throw error;
    }
  }
}

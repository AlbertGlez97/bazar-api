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
} from './dto/product.dto.js';
import { StorageService } from '../storage/storage.service.js';

type Actor = Pick<AuthenticatedRequest, 'account' | 'selection'>;
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
  };
}

@Injectable()
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name);
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(StorageService) private readonly storage: StorageService,
  ) {}

  private response(product: Product) {
    const { imagePath, ...data } = product;
    return {
      ...data,
      image: imagePath ? this.storage.getUrl(imagePath) : null,
    };
  }

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
  private async audit(
    tx: Prisma.TransactionClient,
    memberId: string,
    product: Product,
    before?: Product,
  ) {
    await tx.productAudit.create({
      data: {
        productId: product.id,
        memberId,
        // Capture time after acquiring the row lock, not transaction start time.
        changedAt: new Date(),
        oldUnitPriceMinor: before?.unitPriceMinor ?? null,
        newUnitPriceMinor: product.unitPriceMinor,
        before: before ? snapshot(before) : Prisma.DbNull,
        after: snapshot(product),
      },
    });
  }
  create(actor: Actor, dto: CreateProductDto) {
    const initialStock = dto.tipo === 'unica' ? 1 : dto.initialStock!;
    return this.prisma.$transaction(async (tx) => {
      const memberId = await this.authorize(tx, actor);
      const product = await tx.product.create({
        data: {
          name: dto.name,
          tipo: dto.tipo,
          unitPriceMinor: dto.unitPriceMinor,
          category: dto.category,
          purchaseCostMinor: dto.purchaseCostMinor,
          supplier: dto.supplier,
          notes: dto.notes,
          contextId: actor.account.contextId,
          initialStock,
          stock: initialStock,
        },
      });
      await this.audit(tx, memberId, product);
      return this.response(product);
    });
  }
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
      const product = await tx.product.update({ where: { id }, data });
      await this.audit(tx, memberId, product, before);
      return this.response(product);
    });
  }
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
    });
  }
  async list(contextId: string, query: ProductListDto) {
    const where = {
      contextId,
      ...(query.search
        ? { name: { contains: query.search, mode: 'insensitive' as const } }
        : {}),
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
      items: items.map((product) => this.response(product)),
      total,
      page: query.page,
      limit: query.limit,
    };
  }
  async audits(contextId: string, id: string, query: ProductListDto) {
    if (!(await this.prisma.product.findFirst({ where: { id, contextId } })))
      throw new NotFoundException();
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
    return { items, total, page: query.page, limit: query.limit };
  }
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

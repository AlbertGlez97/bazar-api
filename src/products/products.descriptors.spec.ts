import { describe, expect, it, vi } from 'vitest';
import { ProductsService } from './products.service.js';
import { ProductListDto } from './dto/product.dto.js';
import type { PrismaService } from '../database/prisma.service.js';
import type { StorageService } from '../storage/storage.service.js';

const CTX = 'ctx-1';
const SOCIO_ID = '11111111-1111-4111-8111-111111111111';
const COLAB_ID = '22222222-2222-4222-8222-222222222222';

function stored(overrides: Record<string, unknown> = {}) {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    name: 'Playera',
    tipo: 'cantidad',
    unitPriceMinor: 15000,
    contextId: CTX,
    imagePath: null,
    initialStock: 3,
    stock: 3,
    category: null,
    purchaseCostMinor: 9000,
    supplier: 'Proveedor X',
    notes: 'nota interna',
    brand: null,
    presentation: null,
    description: null,
    createdAt: new Date('2026-10-19T00:00:00Z'),
    active: true,
    ...overrides,
  };
}

function setup() {
  const audits: Array<{ data: Record<string, unknown> }> = [];
  const created: Array<{ data: Record<string, unknown> }> = [];
  const updated: Array<{ data: Record<string, unknown> }> = [];
  const tx = {
    account: { findFirst: vi.fn().mockResolvedValue({ id: 'a' }) },
    member: { findFirst: vi.fn().mockResolvedValue({ id: SOCIO_ID }) },
    device: { findFirst: vi.fn().mockResolvedValue({ id: 'd' }) },
    $queryRaw: vi.fn().mockResolvedValue([]),
    product: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        created.push(args);
        // Like the database: a column not written keeps its default (NULL).
        return stored(
          Object.fromEntries(
            Object.entries(args.data).filter(([, value]) => value !== undefined),
          ),
        );
      }),
      findFirst: vi.fn().mockResolvedValue(stored()),
      update: vi.fn(async (args: { data: Record<string, unknown> }) => {
        updated.push(args);
        // Like the database: a column not written keeps its default (NULL).
        return stored(
          Object.fromEntries(
            Object.entries(args.data).filter(([, value]) => value !== undefined),
          ),
        );
      }),
    },
    productAudit: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        audits.push(args);
      }),
    },
  };
  const findMany = vi.fn().mockReturnValue('findMany-query');
  const count = vi.fn().mockReturnValue('count-query');
  const prisma = {
    product: { findMany, count, findFirst: vi.fn() },
    member: { findFirst: vi.fn() },
    productAudit: { findMany: vi.fn(), count: vi.fn() },
    $transaction: vi.fn(async (arg: unknown) =>
      typeof arg === 'function'
        ? (arg as (t: typeof tx) => unknown)(tx)
        : [[], 0],
    ),
  };
  const service = new ProductsService(
    prisma as unknown as PrismaService,
    { getUrl: (p: string) => `/img/${p}` } as unknown as StorageService,
  );
  const actor = {
    account: { id: 'a', contextId: CTX },
    selection: { memberId: SOCIO_ID, deviceId: 'd' },
  } as never;
  return { service, prisma, tx, audits, created, updated, actor, findMany, count };
}

const CREATE = {
  name: 'Playera',
  tipo: 'cantidad' as const,
  unitPriceMinor: 15000,
  initialStock: 3,
  purchaseCostMinor: 9000,
};

describe('ProductsService.create: marca, presentación y descripción', () => {
  it('los guarda en el registro', async () => {
    const { service, created, actor } = setup();

    const result = await service.create(actor, {
      ...CREATE,
      brand: 'Nike',
      presentation: 'Azul · 28',
      description: 'Algodón',
    } as never);

    expect(created[0].data).toMatchObject({
      brand: 'Nike',
      presentation: 'Azul · 28',
      description: 'Algodón',
    });
    expect(result).toMatchObject({ brand: 'Nike', presentation: 'Azul · 28', description: 'Algodón' });
  });

  it('si no se mandan, no se escriben (quedan null en la base)', async () => {
    const { service, created, actor } = setup();

    const result = await service.create(actor, CREATE as never);

    expect(created[0].data.brand).toBeUndefined();
    expect(result).toMatchObject({ brand: null, presentation: null, description: null });
  });

  it('la auditoría los registra al crear', async () => {
    const { service, audits, actor } = setup();

    await service.create(actor, { ...CREATE, brand: 'Nike', presentation: 'XL', description: 'Algodón' } as never);

    expect(audits[0].data.after).toMatchObject({ brand: 'Nike', presentation: 'XL', description: 'Algodón' });
  });
});

describe('ProductsService.patch: marca, presentación y descripción', () => {
  it('los edita y la auditoría guarda el antes y el después', async () => {
    const { service, tx, audits, updated, actor } = setup();
    tx.product.findFirst.mockResolvedValue(stored({ brand: 'Vieja', presentation: 'M', description: 'a' }));

    await service.patch(actor, '33333333-3333-4333-8333-333333333333', {
      brand: 'Nueva',
      presentation: 'L',
      description: 'b',
    } as never);

    expect(updated[0].data).toMatchObject({ brand: 'Nueva', presentation: 'L', description: 'b' });
    expect(audits[0].data.before).toMatchObject({ brand: 'Vieja', presentation: 'M', description: 'a' });
    expect(audits[0].data.after).toMatchObject({ brand: 'Nueva', presentation: 'L', description: 'b' });
  });

  it('null borra el dato', async () => {
    const { service, updated, actor } = setup();

    await service.patch(actor, '33333333-3333-4333-8333-333333333333', { brand: null } as never);

    expect(updated[0].data.brand).toBeNull();
  });

  it('un campo ausente no se toca', async () => {
    const { service, updated, actor } = setup();

    await service.patch(actor, '33333333-3333-4333-8333-333333333333', { name: 'Otra' } as never);

    expect(updated[0].data.brand).toBeUndefined();
    expect(updated[0].data.presentation).toBeUndefined();
    expect(updated[0].data.description).toBeUndefined();
  });
});

describe('ProductsService.list: búsqueda y filtro por marca', () => {
  const list = (service: ProductsService, query: Partial<ProductListDto>, member?: string) =>
    service.list(CTX, Object.assign(new ProductListDto(), query), member, null);
  const whereOf = (findMany: ReturnType<typeof vi.fn>) =>
    (findMany.mock.calls[0][0] as { where: Record<string, unknown> }).where;

  it('el texto busca en nombre, marca y presentación, sin distinguir mayúsculas', async () => {
    const { service, findMany } = setup();

    await list(service, { search: 'nike' });

    expect(whereOf(findMany).OR).toEqual([
      { name: { contains: 'nike', mode: 'insensitive' } },
      { brand: { contains: 'nike', mode: 'insensitive' } },
      { presentation: { contains: 'nike', mode: 'insensitive' } },
    ]);
  });

  it('sin texto no hay OR', async () => {
    const { service, findMany } = setup();

    await list(service, {});

    expect(whereOf(findMany)).not.toHaveProperty('OR');
  });

  it('el filtro de marca es igualdad exacta sin distinguir mayúsculas', async () => {
    const { service, findMany } = setup();

    await list(service, { brand: 'Casa Vieja' });

    expect(whereOf(findMany).brand).toEqual({ equals: 'Casa Vieja', mode: 'insensitive' });
  });

  it('sin marca no se filtra', async () => {
    const { service, findMany } = setup();

    await list(service, {});

    expect(whereOf(findMany)).not.toHaveProperty('brand');
  });
});

describe('ProductsService: el costo nunca llega a un colaborador', () => {
  const row = stored({ brand: 'Nike', presentation: 'XL', description: 'Algodón' });

  function withRows() {
    const ctx = setup();
    ctx.prisma.$transaction.mockImplementation(async () => [[row], 1] as never);
    ctx.prisma.product.findFirst.mockResolvedValue(row);
    return ctx;
  }

  it('list: un colaborador recibe marca, presentación y descripción pero NO el costo', async () => {
    const { service, prisma } = withRows();
    prisma.member.findFirst.mockResolvedValue(null);

    const page = await service.list(CTX, new ProductListDto(), COLAB_ID, null);

    expect(page.items[0]).toMatchObject({ brand: 'Nike', presentation: 'XL', description: 'Algodón' });
    expect(page.items[0]).not.toHaveProperty('purchaseCostMinor');
    expect(page.items[0]).not.toHaveProperty('supplier');
    expect(page.items[0]).not.toHaveProperty('notes');
  });

  it('list: sin encabezado de persona tampoco hay costo', async () => {
    const { service } = withRows();

    const page = await service.list(CTX, new ProductListDto(), undefined, null);

    expect(page.items[0]).not.toHaveProperty('purchaseCostMinor');
  });

  it('list: un socio sí lo recibe', async () => {
    const { service, prisma } = withRows();
    prisma.member.findFirst.mockResolvedValue({ id: SOCIO_ID });

    const page = await service.list(CTX, new ProductListDto(), SOCIO_ID, null);

    expect(page.items[0]).toMatchObject({ purchaseCostMinor: 9000, supplier: 'Proveedor X', notes: 'nota interna' });
  });

  it('findOne: un colaborador no recibe el costo; un socio sí', async () => {
    const { service, prisma } = withRows();
    prisma.member.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: SOCIO_ID });

    const asColab = await service.findOne(CTX, row.id, COLAB_ID, null);
    const asSocio = await service.findOne(CTX, row.id, SOCIO_ID, null);

    expect(asColab).not.toHaveProperty('purchaseCostMinor');
    expect(asColab).not.toHaveProperty('supplier');
    expect(asColab).not.toHaveProperty('notes');
    expect(asColab).toMatchObject({ brand: 'Nike' });
    expect(asSocio).toMatchObject({ purchaseCostMinor: 9000 });
  });

  it('audits: un colaborador ve el historial sin costo (antes y después)', async () => {
    const { service, prisma } = withRows();
    prisma.member.findFirst.mockResolvedValue(null);
    prisma.productAudit.findMany.mockReturnValue('q1');
    prisma.productAudit.count.mockReturnValue('q2');
    prisma.$transaction.mockResolvedValue([
      [
        {
          id: 'au1',
          oldUnitPriceMinor: 100,
          newUnitPriceMinor: 200,
          before: { name: 'a', purchaseCostMinor: 5, supplier: 's', notes: 'n' },
          after: { name: 'b', purchaseCostMinor: 6, supplier: 's', notes: 'n' },
        },
      ],
      1,
    ] as never);

    const page = await service.audits(CTX, row.id, new ProductListDto(), COLAB_ID, null);

    const item = page.items[0] as { before: Record<string, unknown>; after: Record<string, unknown> };
    expect(item.before).not.toHaveProperty('purchaseCostMinor');
    expect(item.after).not.toHaveProperty('purchaseCostMinor');
    for (const side of [item.before, item.after]) {
      expect(side).not.toHaveProperty('supplier');
      expect(side).not.toHaveProperty('notes');
    }
    expect(item.after).toMatchObject({ name: 'b' });
  });
});

describe('ProductsService.suggestions', () => {
  it('solo marcas y presentaciones distintas, de productos activos del negocio, máximo 200', async () => {
    const { service, prisma } = setup();
    prisma.product.findMany
      .mockResolvedValueOnce([{ brand: 'Adidas' }, { brand: 'Nike' }])
      .mockResolvedValueOnce([{ presentation: '24 oz' }, { presentation: 'XL' }]);

    const result = await service.suggestions(CTX);

    expect(result).toEqual({ brands: ['Adidas', 'Nike'], presentations: ['24 oz', 'XL'] });
    const [brandCall, presentationCall] = prisma.product.findMany.mock.calls.map(
      (c) => c[0] as Record<string, unknown>,
    );
    expect(brandCall).toMatchObject({
      where: { contextId: CTX, active: true, brand: { not: null } },
      distinct: ['brand'],
      select: { brand: true },
      take: 200,
    });
    expect(presentationCall).toMatchObject({
      where: { contextId: CTX, active: true, presentation: { not: null } },
      distinct: ['presentation'],
      select: { presentation: true },
      take: 200,
    });
  });

  it('junta las variantes que solo cambian en mayúsculas ("Nike" y "nike")', async () => {
    const { service, prisma } = setup();
    prisma.product.findMany
      .mockResolvedValueOnce([{ brand: 'Nike' }, { brand: 'NIKE' }, { brand: 'nike' }, { brand: 'Puma' }])
      .mockResolvedValueOnce([]);

    const result = await service.suggestions(CTX);

    expect(result.brands).toEqual(['Nike', 'Puma']);
  });
});

import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { withTestTenant } from './tenant-scope.js';

/** Marca, presentación y descripción de un producto, contra PostgreSQL real. */
describe('product brand, presentation and description', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const contextA = `pd-a-${randomUUID()}`;
  const contextB = `pd-b-${randomUUID()}`;
  let tokenA: string;
  let tokenB: string;
  let socioA: string;
  let colabA: string;
  let deviceA: string;
  let socioB: string;
  let deviceB: string;

  type Who = { token: string; member: string; device: string };
  const socio = (): Who => ({ token: tokenA, member: socioA, device: deviceA });
  const colab = (): Who => ({ token: tokenA, member: colabA, device: deviceA });
  const otherSocio = (): Who => ({ token: tokenB, member: socioB, device: deviceB });
  const as = (req: request.Test, who: Who) =>
    req
      .auth(who.token, { type: 'bearer' })
      .set('x-member-id', who.member)
      .set('x-device-id', who.device);
  const http = () => request(app.getHttpServer());

  const body = (extra: Record<string, unknown> = {}) => ({
    name: `Playera ${randomUUID()}`,
    tipo: 'cantidad',
    unitPriceMinor: 15000,
    initialStock: 5,
    purchaseCostMinor: 9000,
    ...extra,
  });
  const create = (extra: Record<string, unknown> = {}, who = socio()) =>
    as(http().post('/products'), who).send(body(extra));
  const row = (id: string, contextId = contextA) =>
    withTestTenant(contextId, () => prisma.product.findUniqueOrThrow({ where: { id } }));
  const seed = (data: Record<string, unknown>, contextId = contextA) =>
    withTestTenant(contextId, () =>
      prisma.product.create({
        data: {
          name: `Seed ${randomUUID()}`,
          tipo: 'cantidad',
          unitPriceMinor: 5000,
          initialStock: 1,
          stock: 1,
          purchaseCostMinor: 1000,
          contextId,
          ...data,
        },
      }),
    );

  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    const jwt = app.get(JwtService);
    const account = (contextId: string) =>
      prisma.account.create({
        data: { username: randomUUID(), passwordHash: 'not-a-login-fixture', contextId },
      });
    tokenA = await jwt.signAsync({ sub: (await account(contextA)).id });
    tokenB = await jwt.signAsync({ sub: (await account(contextB)).id });
    await withTestTenant(contextA, async () => {
      socioA = (await prisma.member.create({ data: { name: 'Socio A', role: 'socio', contextId: contextA } })).id;
      colabA = (await prisma.member.create({ data: { name: 'Colab A', role: 'colaborador', contextId: contextA } })).id;
      deviceA = (await prisma.device.create({ data: { name: 'Tablet A', identifier: randomUUID(), contextId: contextA, authorized: true } })).id;
    });
    await withTestTenant(contextB, async () => {
      socioB = (await prisma.member.create({ data: { name: 'Socio B', role: 'socio', contextId: contextB } })).id;
      deviceB = (await prisma.device.create({ data: { name: 'Tablet B', identifier: randomUUID(), contextId: contextB, authorized: true } })).id;
    });
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('crear y editar', () => {
    it('crea con los tres campos, limpios, y los devuelve', async () => {
      const res = await create({
        brand: '  Casa   Vieja ',
        presentation: 'Azul​ · 28',
        description: 'Línea uno\nlínea dos',
      }).expect(201);

      expect(res.body).toMatchObject({
        brand: 'Casa Vieja',
        presentation: 'Azul · 28',
        description: 'Línea uno línea dos',
      });
      expect(await row(res.body.id)).toMatchObject({
        brand: 'Casa Vieja',
        presentation: 'Azul · 28',
        description: 'Línea uno línea dos',
      });
    });

    it('sin los campos, quedan null (compatibilidad con clientes viejos)', async () => {
      const res = await create().expect(201);

      expect(res.body).toMatchObject({ brand: null, presentation: null, description: null });
    });

    it('vacío al crear es null', async () => {
      const res = await create({ brand: '   ', presentation: '', description: '\n' }).expect(201);

      expect(res.body).toMatchObject({ brand: null, presentation: null, description: null });
    });

    it.each([
      ['brand', 40],
      ['presentation', 40],
      ['description', 200],
    ])('%s: el máximo (%i) pasa y uno más se rechaza con 400', async (field, max) => {
      await create({ [field]: 'x'.repeat(max) }).expect(201);
      await create({ [field]: 'x'.repeat(max + 1) }).expect(400);
    });

    it('edita, borra con null y no toca lo que no se manda', async () => {
      const made = await create({ brand: 'Nike', presentation: 'XL', description: 'Algodón' }).expect(201);
      const id = made.body.id as string;

      await as(http().patch(`/products/${id}`), socio()).send({ presentation: 'L' }).expect(200);
      expect(await row(id)).toMatchObject({ brand: 'Nike', presentation: 'L', description: 'Algodón' });

      await as(http().patch(`/products/${id}`), socio()).send({ brand: null, description: '  ' }).expect(200);
      expect(await row(id)).toMatchObject({ brand: null, presentation: 'L', description: null });
    });

    it('un colaborador no puede crear ni editar (403)', async () => {
      const made = await create({ brand: 'Nike' }).expect(201);

      await create({ brand: 'Otra' }, colab()).expect(403);
      await as(http().patch(`/products/${made.body.id}`), colab()).send({ brand: 'Otra' }).expect(403);
      expect((await row(made.body.id)).brand).toBe('Nike');
    });

    it('la auditoría guarda los campos nuevos al crear y al editar', async () => {
      const made = await create({ brand: 'Nike', presentation: 'XL' }).expect(201);
      await as(http().patch(`/products/${made.body.id}`), socio()).send({ brand: 'Puma' }).expect(200);

      const audit = await as(http().get(`/products/${made.body.id}/audit`), socio()).expect(200);

      expect(audit.body.items[0].after).toMatchObject({ brand: 'Nike', presentation: 'XL', description: null });
      expect(audit.body.items[1].before).toMatchObject({ brand: 'Nike' });
      expect(audit.body.items[1].after).toMatchObject({ brand: 'Puma', presentation: 'XL' });
    });
  });

  describe('búsqueda y filtro', () => {
    const tag = randomUUID().slice(0, 8);
    let ids: Record<string, string>;

    beforeAll(async () => {
      ids = {
        porNombre: (await seed({ name: `Bolsa ${tag}` })).id,
        porMarca: (await seed({ name: `Otra cosa ${randomUUID()}`, brand: `Marca${tag}` })).id,
        porPresentacion: (await seed({ name: `Algo ${randomUUID()}`, presentation: `Talla${tag}` })).id,
        casa: (await seed({ name: `Taza ${randomUUID()}`, brand: `Casa Vieja ${tag}` })).id,
        otraCasa: (await seed({ name: `Vaso ${randomUUID()}`, brand: `Casa Nueva ${tag}` })).id,
        inactiva: (await seed({ name: `Baja ${randomUUID()}`, brand: `Marca${tag}`, active: false })).id,
        ajena: (await seed({ name: `Ajena ${randomUUID()}`, brand: `Marca${tag}` }, contextB)).id,
      };
    });

    const found = async (query: string, who = socio()) =>
      (await as(http().get(`/products?limit=100&${query}`), who).expect(200)).body.items.map(
        (item: { id: string }) => item.id,
      ) as string[];

    it('el texto encuentra por nombre, por marca y por presentación, sin distinguir mayúsculas', async () => {
      expect(await found(`search=bolsa ${tag}`)).toEqual([ids.porNombre]);
      expect(await found(`search=MARCA${tag}`)).toEqual([ids.porMarca]);
      expect(await found(`search=talla${tag}`)).toEqual([ids.porPresentacion]);
    });

    it('la búsqueda no cruza negocios', async () => {
      expect(await found(`search=Marca${tag}`, otherSocio())).toEqual([ids.ajena]);
    });

    it('el filtro de marca es exacto, sin distinguir mayúsculas, y no mezcla marcas parecidas', async () => {
      expect(await found(`brand=casa vieja ${tag}`)).toEqual([ids.casa]);
      expect(await found(`brand=${encodeURIComponent(`  CASA   VIEJA ${tag} `)}`)).toEqual([ids.casa]);
      expect(await found(`brand=Casa ${tag}`)).toEqual([]);
    });

    it('el filtro de marca se combina con el texto', async () => {
      expect(await found(`brand=Casa Vieja ${tag}&search=taza`)).toEqual([ids.casa]);
      expect(await found(`brand=Casa Vieja ${tag}&search=vaso`)).toEqual([]);
    });

    it('marca vacía es "sin filtro"', async () => {
      const all = await found('brand=');
      expect(all).toEqual(expect.arrayContaining([ids.casa, ids.otraCasa]));
    });

    it('una marca de más de 40 caracteres se rechaza', async () => {
      await as(http().get(`/products?brand=${'x'.repeat(41)}`), socio()).expect(400);
    });
  });

  describe('sugerencias (solo socios)', () => {
    const tag = randomUUID().slice(0, 8);
    let ctx: string;
    let who: Who;

    beforeAll(async () => {
      // Un negocio propio para contar exactamente lo que hay.
      ctx = `pd-s-${randomUUID()}`;
      const jwt = app.get(JwtService);
      const acc = await prisma.account.create({
        data: { username: randomUUID(), passwordHash: 'not-a-login-fixture', contextId: ctx },
      });
      const token = await jwt.signAsync({ sub: acc.id });
      let member = '';
      let device = '';
      await withTestTenant(ctx, async () => {
        member = (await prisma.member.create({ data: { name: 'S', role: 'socio', contextId: ctx } })).id;
        device = (await prisma.device.create({ data: { name: 'T', identifier: randomUUID(), contextId: ctx, authorized: true } })).id;
      });
      who = { token, member, device };
      await seed({ brand: `Nike ${tag}`, presentation: 'XL' }, ctx);
      await seed({ brand: `Nike ${tag}`, presentation: '24 oz' }, ctx);
      await seed({ brand: `NIKE ${tag}`, presentation: 'xl' }, ctx);
      await seed({ brand: `Adidas ${tag}` }, ctx);
      await seed({ brand: `Baja ${tag}`, presentation: 'Solo inactivo', active: false }, ctx);
      await seed({ name: 'Sin datos' }, ctx);
    });

    it('devuelve marcas y presentaciones distintas de productos activos, y nada más', async () => {
      const res = await as(http().get('/products/suggestions'), who).expect(200);

      expect(Object.keys(res.body).sort()).toEqual(['brands', 'presentations']);
      // "Nike" y "NIKE" son una sola sugerencia (la ortografía que queda depende del orden de la base).
      expect(res.body.brands.map((brand: string) => brand.toLowerCase())).toEqual([`adidas ${tag}`, `nike ${tag}`]);
      expect(res.body.presentations.map((p: string) => p.toLowerCase())).toEqual(['24 oz', 'xl']);
    });

    it('no incluye lo de otros negocios', async () => {
      const res = await as(http().get('/products/suggestions'), socio()).expect(200);

      expect(JSON.stringify(res.body)).not.toContain(tag);
    });

    it('un colaborador recibe 403 y sin sesión 401', async () => {
      await as(http().get('/products/suggestions'), colab()).expect(403);
      await http().get('/products/suggestions').expect(401);
    });

    it('con más de 200 valores devuelve a lo sumo 200', async () => {
      const big = `pd-big-${randomUUID()}`;
      const acc = await prisma.account.create({
        data: { username: randomUUID(), passwordHash: 'not-a-login-fixture', contextId: big },
      });
      const token = await app.get(JwtService).signAsync({ sub: acc.id });
      let member = '';
      let device = '';
      await withTestTenant(big, async () => {
        member = (await prisma.member.create({ data: { name: 'S', role: 'socio', contextId: big } })).id;
        device = (await prisma.device.create({ data: { name: 'T', identifier: randomUUID(), contextId: big, authorized: true } })).id;
        await prisma.product.createMany({
          data: Array.from({ length: 205 }, (_, index) => ({
            name: `P${index}`,
            tipo: 'cantidad' as const,
            unitPriceMinor: 100,
            initialStock: 1,
            stock: 1,
            brand: `Marca ${String(index).padStart(3, '0')}`,
            contextId: big,
          })),
        });
      });

      const res = await as(http().get('/products/suggestions'), { token, member, device }).expect(200);

      expect(res.body.brands).toHaveLength(200);
    });
  });

  describe('el costo nunca llega a un colaborador', () => {
    it('GET /products: el colaborador ve marca, presentación y descripción pero NO el costo; el socio sí', async () => {
      const made = await create({ brand: 'Nike', presentation: 'XL', description: 'Algodón' }).expect(201);

      const asColab = await as(http().get('/products?limit=100&search=Nike'), colab()).expect(200);
      const asSocio = await as(http().get('/products?limit=100&search=Nike'), socio()).expect(200);

      const colabItem = asColab.body.items.find((i: { id: string }) => i.id === made.body.id);
      const socioItem = asSocio.body.items.find((i: { id: string }) => i.id === made.body.id);
      expect(colabItem).toMatchObject({ brand: 'Nike', presentation: 'XL', description: 'Algodón' });
      expect(colabItem).not.toHaveProperty('purchaseCostMinor');
      expect(socioItem).toMatchObject({ purchaseCostMinor: 9000 });
    });

    it('GET /products/:id igual', async () => {
      const made = await create({ brand: 'Nike' }).expect(201);

      const asColab = await as(http().get(`/products/${made.body.id}`), colab()).expect(200);
      const asSocio = await as(http().get(`/products/${made.body.id}`), socio()).expect(200);

      expect(asColab.body).toMatchObject({ brand: 'Nike' });
      expect(asColab.body).not.toHaveProperty('purchaseCostMinor');
      expect(asSocio.body.purchaseCostMinor).toBe(9000);
    });

    it('sin x-member-id tampoco hay costo', async () => {
      const made = await create().expect(201);

      const res = await http().get(`/products/${made.body.id}`).auth(tokenA, { type: 'bearer' }).expect(200);

      expect(res.body).not.toHaveProperty('purchaseCostMinor');
    });

    it('el historial no revela el costo a un colaborador', async () => {
      const made = await create({ brand: 'Nike' }).expect(201);
      await as(http().patch(`/products/${made.body.id}`), socio()).send({ purchaseCostMinor: 9500 }).expect(200);

      const asColab = await as(http().get(`/products/${made.body.id}/audit`), colab()).expect(200);
      const asSocio = await as(http().get(`/products/${made.body.id}/audit`), socio()).expect(200);

      for (const item of asColab.body.items) {
        expect(item.after).not.toHaveProperty('purchaseCostMinor');
        expect(item.before ?? {}).not.toHaveProperty('purchaseCostMinor');
      }
      expect(asSocio.body.items.at(-1).after.purchaseCostMinor).toBe(9500);
    });

    it('un colaborador no puede usar el encabezado de un socio (la cuenta ligada a un miembro)', async () => {
      const made = await create().expect(201);
      const bound = await prisma.account.create({
        data: {
          username: randomUUID(),
          passwordHash: 'not-a-login-fixture',
          contextId: contextA,
          memberId: colabA,
        },
      });
      const token = await app.get(JwtService).signAsync({ sub: bound.id });

      const res = await http()
        .get(`/products/${made.body.id}`)
        .auth(token, { type: 'bearer' })
        .set('x-member-id', socioA)
        .set('x-device-id', deviceA)
        .expect(200);

      expect(res.body).not.toHaveProperty('purchaseCostMinor');
    });
  });

  describe('compatibilidad', () => {
    it('un producto viejo (sin los campos) se lista con null y su resto intacto', async () => {
      const old = await seed({ name: `Viejo ${randomUUID()}`, category: 'Ropa', supplier: 'P', notes: 'n' });

      const res = await as(http().get(`/products/${old.id}`), socio()).expect(200);

      expect(res.body).toMatchObject({
        id: old.id,
        category: 'Ropa',
        supplier: 'P',
        notes: 'n',
        purchaseCostMinor: 1000,
        brand: null,
        presentation: null,
        description: null,
      });
    });

    it('los campos son opcionales: otro negocio no ve ni edita el producto', async () => {
      const made = await create({ brand: 'Nike' }).expect(201);

      await as(http().patch(`/products/${made.body.id}`), otherSocio()).send({ brand: 'X' }).expect(404);
      await as(http().get(`/products/${made.body.id}`), otherSocio()).expect(404);
      expect((await row(made.body.id)).brand).toBe('Nike');
    });
  });
  describe('costo, proveedor y notas: solo para socios, en cada endpoint', () => {
    const SECRET = { supplier: 'Proveedor Secreto', notes: 'nota interna' };
    const hasSocioOnly = (value: unknown) => /purchaseCostMinor|unitCostMinor|"supplier"|"notes"|costoMinor|gananciaMinor/.test(JSON.stringify(value));

    it('GET /products, /products/:id y /audit: el colaborador no ve costo, proveedor ni notas; el socio sí', async () => {
      const made = await create({ ...SECRET }).expect(201);
      await as(http().patch(`/products/${made.body.id}`), socio()).send({ notes: 'otra nota' }).expect(200);

      const list = await as(http().get('/products?limit=100'), colab()).expect(200);
      const one = await as(http().get(`/products/${made.body.id}`), colab()).expect(200);
      const audit = await as(http().get(`/products/${made.body.id}/audit`), colab()).expect(200);
      expect(hasSocioOnly(list.body)).toBe(false);
      expect(hasSocioOnly(one.body)).toBe(false);
      expect(hasSocioOnly(audit.body)).toBe(false);

      const socioOne = await as(http().get(`/products/${made.body.id}`), socio()).expect(200);
      expect(socioOne.body).toMatchObject({ purchaseCostMinor: 9000, supplier: 'Proveedor Secreto', notes: 'otra nota' });
      const socioAudit = await as(http().get(`/products/${made.body.id}/audit`), socio()).expect(200);
      expect(socioAudit.body.items.at(-1).after).toMatchObject({ supplier: 'Proveedor Secreto', purchaseCostMinor: 9000 });
    });

    it('una cuenta ligada a un colaborador no obtiene nada de esto aunque nombre a un socio', async () => {
      const made = await create({ ...SECRET }).expect(201);
      // Una cuenta ligada a un miembro solo puede haber una: se reutiliza la del test anterior.
      const bound = await prisma.account.findFirstOrThrow({ where: { contextId: contextA, memberId: colabA } });
      const token = await app.get(JwtService).signAsync({ sub: bound.id });
      const res = await http()
        .get(`/products/${made.body.id}`)
        .auth(token, { type: 'bearer' })
        .set('x-member-id', socioA)
        .set('x-device-id', deviceA)
        .expect(200);
      expect(hasSocioOnly(res.body)).toBe(false);
    });

    it('POST /sales, GET /sales/:id y GET /sales: ninguna línea trae costo ni ganancia (colaborador y socio)', async () => {
      const made = await create({ ...SECRET, initialStock: 50 }).expect(201);
      const sell = async (who: Who) => {
        const res = await as(http().post('/sales'), who)
          .send({
            id: randomUUID(),
            memberId: who.member,
            deviceId: who.device,
            occurredAt: new Date().toISOString(),
            currency: 'MXN',
            cashReceivedMinor: 100000,
            items: [{ productId: made.body.id, quantity: 1 }],
          })
          .expect(201);
        expect(hasSocioOnly(res.body)).toBe(false);
        // Reenviar la misma venta (la cola reintenta) tampoco lo revela.
        const replay = await as(http().post('/sales'), who).send({
          id: res.body.id,
          memberId: who.member,
          deviceId: who.device,
          occurredAt: res.body.occurredAt,
          currency: 'MXN',
          cashReceivedMinor: 100000,
          items: [{ productId: made.body.id, quantity: 1 }],
        });
        expect(hasSocioOnly(replay.body)).toBe(false);
        const detail = await as(http().get(`/sales/${res.body.id}`), who).expect(200);
        expect(hasSocioOnly(detail.body)).toBe(false);
        return res.body.id as string;
      };
      await sell(colab());
      await sell(socio());

      const list = await as(http().get('/sales?limit=100'), socio()).expect(200);
      expect(list.body.items.length).toBeGreaterThan(0);
      expect(hasSocioOnly(list.body)).toBe(false);
      await as(http().get('/sales'), colab()).expect(403);
    });
  });

});

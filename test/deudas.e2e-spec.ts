import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { expectUuidV7 } from './uuid-v7.js';
import { withTestTenant } from './tenant-scope.js';

/**
 * BE-09: fiado/apartado unified under "Deuda" — immediate stock decrement
 * on creation, socio-only creation, any-member abono collection, and
 * automatic status derivation from the running abono balance.
 */
describe('deudas (BE-09)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let socioToken: string;
  let colaboradorToken: string;
  let socioMemberId: string;
  let colaboradorMemberId: string;
  let deviceId: string;
  const contextId = `be09-${randomUUID()}`;

  const asSocio = (req: request.Test) =>
    req
      .auth(socioToken, { type: 'bearer' })
      .set('x-member-id', socioMemberId)
      .set('x-device-id', deviceId);

  const asColaborador = (req: request.Test) =>
    req
      .auth(colaboradorToken, { type: 'bearer' })
      .set('x-member-id', colaboradorMemberId)
      .set('x-device-id', deviceId);

  // BE-11: strict deny-by-default RLS now requires an explicit tenant
  // scope for direct Prisma fixture setup/assertion calls.
  const createProduct = (data: {
    name: string;
    tipo: 'unica' | 'cantidad';
    unitPriceMinor: number;
    stock: number;
  }) =>
    withTestTenant(contextId, () =>
      prisma.product.create({
        data: {
          name: data.name,
          tipo: data.tipo,
          unitPriceMinor: data.unitPriceMinor,
          initialStock: data.stock,
          stock: data.stock,
          contextId,
        },
      }),
    );

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    const jwt = app.get(JwtService);

    const socioAccount = await prisma.account.create({
      data: {
        username: randomUUID(),
        passwordHash: 'not-a-login-fixture',
        contextId,
      },
    });
    socioToken = await jwt.signAsync({ sub: socioAccount.id });
    await withTestTenant(contextId, async () => {
      socioMemberId = (
        await prisma.member.create({
          data: { name: 'Alberto Socio', role: 'socio', contextId },
        })
      ).id;
    });

    const colaboradorAccount = await prisma.account.create({
      data: {
        username: randomUUID(),
        passwordHash: 'not-a-login-fixture',
        contextId,
      },
    });
    colaboradorToken = await jwt.signAsync({ sub: colaboradorAccount.id });
    await withTestTenant(contextId, async () => {
      colaboradorMemberId = (
        await prisma.member.create({
          data: {
            name: 'Ayudante Colaborador',
            role: 'colaborador',
            contextId,
          },
        })
      ).id;

      deviceId = (
        await prisma.device.create({
          data: {
            name: 'BE09 tablet',
            identifier: randomUUID(),
            contextId,
            authorized: true,
          },
        })
      ).id;
    });
  });

  it.each([
    { type: 'fiado' as const, stock: 1 },
    { type: 'apartado' as const, stock: 1 },
    { type: 'fiado' as const, stock: 2 },
    { type: 'apartado' as const, stock: 2 },
  ])(
    'concurrent client-ID $type retries with stock=$stock apply all effects once',
    async ({ type, stock }) => {
      const product = await createProduct({
        name: 'Offline retry',
        tipo: 'cantidad',
        unitPriceMinor: 1000,
        stock,
      });
      const id = randomUUID();
      const body = {
        id,
        type,
        productId: product.id,
        cantidad: 1,
        deudor: { nombre: `Retry ${id}` },
        abonoInicialMinor: 100,
        cuotasPlaneadas: [
          { fechaEsperada: '2026-10-15', montoEsperadoMinor: 900 },
        ],
      };
      const send = (data = body) =>
        asSocio(request(app.getHttpServer()).post('/deudas')).send(data);
      const results = await Promise.all([send(), send()]);
      expect(results.map((result) => result.status)).toEqual([201, 201]);
      expect(results[0].body).toEqual(results[1].body);
      expect(results[0].body.id).toBe(id);
      expect(results[0].body).not.toHaveProperty('creationResponse');
      expect(results[0].body).not.toHaveProperty('requestFingerprint');
      await withTestTenant(contextId, async () => {
        expect(
          (
            await prisma.product.findUniqueOrThrow({
              where: { id: product.id },
            })
          ).stock,
        ).toBe(stock - 1);
        expect(await prisma.deuda.count({ where: { id } })).toBe(1);
        expect(
          await prisma.deudor.count({ where: { nombre: body.deudor.nombre } }),
        ).toBe(1);
        expect(await prisma.abono.count({ where: { deudaId: id } })).toBe(1);
        expect(
          await prisma.cuotaPlaneada.count({ where: { deudaId: id } }),
        ).toBe(1);
      });
      await send({ ...body, abonoInicialMinor: 200 }).expect(409);
      await asSocio(request(app.getHttpServer()).post(`/deudas/${id}/abonos`))
        .send({ montoMinor: 900 })
        .expect(201);
      expect((await send().expect(201)).body).toEqual(results[0].body);
    },
  );

  afterAll(async () => {
    if (prisma) {
      await withTestTenant(contextId, async () => {
        await prisma.abono.deleteMany({
          where: { deuda: { createdByMember: { contextId } } },
        });
        await prisma.cuotaPlaneada.deleteMany({
          where: { deuda: { createdByMember: { contextId } } },
        });
        await prisma.deuda.deleteMany({
          where: { createdByMember: { contextId } },
        });
        await prisma.deudor.deleteMany({ where: { contextId } });
        await prisma.product.deleteMany({ where: { contextId } });
        await prisma.device.deleteMany({ where: { contextId } });
        await prisma.member.deleteMany({ where: { contextId } });
      });
      await prisma.account.deleteMany({ where: { contextId } });
    }
    await app?.close();
  });

  it('creating a fiado decrements inventory immediately (unica: 1 -> 0)', async () => {
    const product = await createProduct({
      name: `Fiado unica ${randomUUID()}`,
      tipo: 'unica',
      unitPriceMinor: 50_00,
      stock: 1,
    });
    const res = await asSocio(request(app.getHttpServer()).post('/deudas'))
      .send({
        type: 'fiado',
        abonoInicialMinor: 0,
        productId: product.id,
        cantidad: 1,
        deudor: { nombre: 'Cliente Fiado Unica' },
      })
      .expect(201);
    expect(res.body.totalMinor).toBe(50_00);
    expect(res.body.status).toBe('pendiente');
    expectUuidV7(res.body.id);
    expectUuidV7(res.body.deudorId);

    const updated = await withTestTenant(contextId, () =>
      prisma.product.findUniqueOrThrow({
        where: { id: product.id },
      }),
    );
    expect(updated.stock).toBe(0);
  });

  it('creating an apartado decrements inventory immediately, same as fiado', async () => {
    const product = await createProduct({
      name: `Apartado cantidad ${randomUUID()}`,
      tipo: 'cantidad',
      unitPriceMinor: 20_00,
      stock: 10,
    });
    await asSocio(request(app.getHttpServer()).post('/deudas'))
      .send({
        type: 'apartado',
        abonoInicialMinor: 0,
        productId: product.id,
        cantidad: 3,
        deudor: { nombre: 'Cliente Apartado' },
      })
      .expect(201);

    const updated = await withTestTenant(contextId, () =>
      prisma.product.findUniqueOrThrow({
        where: { id: product.id },
      }),
    );
    expect(updated.stock).toBe(7);
  });

  it('rejects a colaborador attempting to create a deuda with 403', async () => {
    const product = await createProduct({
      name: `Rechazo colaborador ${randomUUID()}`,
      tipo: 'cantidad',
      unitPriceMinor: 10_00,
      stock: 5,
    });
    await asColaborador(request(app.getHttpServer()).post('/deudas'))
      .send({
        type: 'fiado',
        abonoInicialMinor: 0,
        productId: product.id,
        cantidad: 1,
        deudor: { nombre: 'No debería crearse' },
      })
      .expect(403);

    const updated = await withTestTenant(contextId, () =>
      prisma.product.findUniqueOrThrow({
        where: { id: product.id },
      }),
    );
    expect(updated.stock).toBe(5);
  });

  it('rejects with 400 when cantidad exceeds available stock, no partial changes', async () => {
    const product = await createProduct({
      name: `Stock insuficiente ${randomUUID()}`,
      tipo: 'cantidad',
      unitPriceMinor: 15_00,
      stock: 2,
    });
    await asSocio(request(app.getHttpServer()).post('/deudas'))
      .send({
        type: 'fiado',
        abonoInicialMinor: 0,
        productId: product.id,
        cantidad: 3,
        deudor: { nombre: 'Cliente Sin Stock' },
      })
      .expect(400);

    const updated = await withTestTenant(contextId, () =>
      prisma.product.findUniqueOrThrow({
        where: { id: product.id },
      }),
    );
    expect(updated.stock).toBe(2);
    const deudaCount = await withTestTenant(contextId, () =>
      prisma.deuda.count({
        where: { productId: product.id },
      }),
    );
    expect(deudaCount).toBe(0);
  });

  it('an abono that exactly covers the total marks the deuda as saldada', async () => {
    const product = await createProduct({
      name: `Saldada exacta ${randomUUID()}`,
      tipo: 'cantidad',
      unitPriceMinor: 30_00,
      stock: 5,
    });
    const created = await asSocio(request(app.getHttpServer()).post('/deudas'))
      .send({
        type: 'fiado',
        abonoInicialMinor: 0,
        productId: product.id,
        cantidad: 2,
        deudor: { nombre: 'Cliente Paga Todo' },
      })
      .expect(201);
    expect(created.body.totalMinor).toBe(60_00);

    await asColaborador(
      request(app.getHttpServer()).post(`/deudas/${created.body.id}/abonos`),
    )
      .send({ montoMinor: 20_00 })
      .expect(201);
    const res = await asColaborador(
      request(app.getHttpServer()).post(`/deudas/${created.body.id}/abonos`),
    )
      .send({ montoMinor: 40_00 })
      .expect(201);
    expect(res.body.status).toBe('saldada');
    expect(res.body.abonos).toHaveLength(2);
    res.body.abonos.forEach((abono: { id: string }) => expectUuidV7(abono.id));
  });

  it('an abono exceeding the remaining balance is rejected with 400 and not applied', async () => {
    const product = await createProduct({
      name: `Sobrepago ${randomUUID()}`,
      tipo: 'cantidad',
      unitPriceMinor: 40_00,
      stock: 5,
    });
    const created = await asSocio(request(app.getHttpServer()).post('/deudas'))
      .send({
        type: 'apartado',
        abonoInicialMinor: 0,
        productId: product.id,
        cantidad: 1,
        deudor: { nombre: 'Cliente Sobrepago' },
      })
      .expect(201);

    await asColaborador(
      request(app.getHttpServer()).post(`/deudas/${created.body.id}/abonos`),
    )
      .send({ montoMinor: 40_01 })
      .expect(400);

    const deuda = await withTestTenant(contextId, () =>
      prisma.deuda.findUniqueOrThrow({
        where: { id: created.body.id },
        include: { abonos: true },
      }),
    );
    expect(deuda.status).toBe('pendiente');
    expect(deuda.abonos).toHaveLength(0);
  });

  it('allows a colaborador to register an abono (unlike creating the deuda itself)', async () => {
    const product = await createProduct({
      name: `Abono colaborador ${randomUUID()}`,
      tipo: 'cantidad',
      unitPriceMinor: 25_00,
      stock: 4,
    });
    const created = await asSocio(request(app.getHttpServer()).post('/deudas'))
      .send({
        type: 'fiado',
        abonoInicialMinor: 0,
        productId: product.id,
        cantidad: 2,
        deudor: { nombre: 'Cliente Abono Parcial' },
      })
      .expect(201);

    const res = await asColaborador(
      request(app.getHttpServer()).post(`/deudas/${created.body.id}/abonos`),
    )
      .send({ montoMinor: 20_00, nota: 'primer abono' })
      .expect(201);
    expect(res.body.status).toBe('pendiente');
    expect(res.body.abonos).toHaveLength(1);
    expect(res.body.abonos[0].receivedByMemberId).toBe(colaboradorMemberId);
  });

  it('lists deudas filtered by status=pendiente and by deudor name', async () => {
    const product = await createProduct({
      name: `Listado deudas ${randomUUID()}`,
      tipo: 'cantidad',
      unitPriceMinor: 10_00,
      stock: 20,
    });
    const searchableName = `Deudor Buscable Unico ${randomUUID()}`;
    const pending = await asSocio(request(app.getHttpServer()).post('/deudas'))
      .send({
        type: 'fiado',
        abonoInicialMinor: 0,
        productId: product.id,
        cantidad: 1,
        deudor: { nombre: searchableName },
      })
      .expect(201);

    const settled = await asSocio(request(app.getHttpServer()).post('/deudas'))
      .send({
        type: 'fiado',
        abonoInicialMinor: 0,
        productId: product.id,
        cantidad: 1,
        deudorId: pending.body.deudorId,
      })
      .expect(201);
    await asColaborador(
      request(app.getHttpServer()).post(`/deudas/${settled.body.id}/abonos`),
    )
      .send({ montoMinor: 10_00 })
      .expect(201);

    const res = await asSocio(
      request(app.getHttpServer()).get(
        `/deudas?status=pendiente&search=${encodeURIComponent(searchableName)}`,
      ),
    ).expect(200);
    const ids = (res.body.items as { id: string; status: string }[]).map(
      (d) => d.id,
    );
    expect(ids).toContain(pending.body.id);
    expect(ids).not.toContain(settled.body.id);
  });

  // BE-15: explicit initial abono, planned installments (CuotaPlaneada —
  // purely informative, never affects the balance), cost snapshot,
  // settlement timestamp, and GET /deudas atrasado filter/sort.
  describe('abono inicial (BE-15 D1)', () => {
    it('abonoInicialMinor: 0 creates zero Abonos', async () => {
      const product = await createProduct({
        name: `Abono inicial cero ${randomUUID()}`,
        tipo: 'cantidad',
        unitPriceMinor: 30_00,
        stock: 5,
      });
      const res = await asSocio(request(app.getHttpServer()).post('/deudas'))
        .send({
          type: 'fiado',
          abonoInicialMinor: 0,
          productId: product.id,
          cantidad: 2,
          deudor: { nombre: 'Cliente Sin Abono Inicial' },
        })
        .expect(201);
      expect(res.body.abonos).toHaveLength(0);
      expect(res.body.status).toBe('pendiente');
    });

    it('abonoInicialMinor > 0 creates exactly one Abono dated today', async () => {
      const product = await createProduct({
        name: `Abono inicial parcial ${randomUUID()}`,
        tipo: 'cantidad',
        unitPriceMinor: 100_00,
        stock: 5,
      });
      const before = new Date();
      const res = await asSocio(request(app.getHttpServer()).post('/deudas'))
        .send({
          type: 'fiado',
          abonoInicialMinor: 40_00,
          productId: product.id,
          cantidad: 1,
          deudor: { nombre: 'Cliente Abono Inicial Parcial' },
        })
        .expect(201);
      expect(res.body.abonos).toHaveLength(1);
      expect(res.body.abonos[0].montoMinor).toBe(40_00);
      const receivedAt = new Date(res.body.abonos[0].receivedAt);
      expect(receivedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(res.body.status).toBe('pendiente');
    });

    it('an abonoInicialMinor that alone equals the total settles the deuda immediately (saldadaAt set)', async () => {
      const product = await createProduct({
        name: `Abono inicial total ${randomUUID()}`,
        tipo: 'cantidad',
        unitPriceMinor: 25_00,
        stock: 5,
      });
      const res = await asSocio(request(app.getHttpServer()).post('/deudas'))
        .send({
          type: 'apartado',
          abonoInicialMinor: 25_00,
          productId: product.id,
          cantidad: 1,
          deudor: { nombre: 'Cliente Abono Inicial Total' },
        })
        .expect(201);
      expect(res.body.status).toBe('saldada');
      expect(res.body.abonos).toHaveLength(1);

      const stored = await withTestTenant(contextId, () =>
        prisma.deuda.findUniqueOrThrow({ where: { id: res.body.id } }),
      );
      expect(stored.saldadaAt).not.toBeNull();
    });

    it('an abonoInicialMinor that alone exceeds the total is rejected with the same error shape as registerAbono, no Deuda created', async () => {
      const product = await createProduct({
        name: `Abono inicial excesivo ${randomUUID()}`,
        tipo: 'cantidad',
        unitPriceMinor: 10_00,
        stock: 5,
      });
      const res = await asSocio(request(app.getHttpServer()).post('/deudas'))
        .send({
          type: 'fiado',
          abonoInicialMinor: 10_01,
          productId: product.id,
          cantidad: 1,
          deudor: { nombre: 'Cliente Abono Inicial Excesivo' },
        })
        .expect(400);
      expect(res.body.message).toBe(
        'Abono of 1001 exceeds the remaining balance of 1000',
      );

      const deudaCount = await withTestTenant(contextId, () =>
        prisma.deuda.count({ where: { productId: product.id } }),
      );
      expect(deudaCount).toBe(0);
      const updated = await withTestTenant(contextId, () =>
        prisma.product.findUniqueOrThrow({ where: { id: product.id } }),
      );
      expect(updated.stock).toBe(5);
    });
  });

  describe('cuotas planeadas (BE-15 D2/D3) never affect the balance', () => {
    it('CuotaPlaneada rows that do not match any real payment never move the saldo or status', async () => {
      const product = await createProduct({
        name: `Cuotas no reales ${randomUUID()}`,
        tipo: 'cantidad',
        unitPriceMinor: 100_00,
        stock: 5,
      });
      const created = await asSocio(
        request(app.getHttpServer()).post('/deudas'),
      )
        .send({
          type: 'fiado',
          abonoInicialMinor: 0,
          productId: product.id,
          cantidad: 1,
          deudor: { nombre: 'Cliente Cuotas Ficticias' },
          cuotasPlaneadas: [
            { fechaEsperada: '2020-01-01', montoEsperadoMinor: 100_00 },
            { fechaEsperada: '2020-02-01', montoEsperadoMinor: 100_00 },
          ],
        })
        .expect(201);
      expect(created.body.status).toBe('pendiente');
      expect(created.body.cuotasPlaneadas).toHaveLength(2);

      // The cuotas above total 200_00 (more than the real 100_00 total) and
      // are already "paid off" on paper — none of that is real money, so
      // the deuda must still show its real, unaffected balance/status.
      const stored = await withTestTenant(contextId, () =>
        prisma.deuda.findUniqueOrThrow({
          where: { id: created.body.id },
          include: { abonos: true },
        }),
      );
      expect(stored.status).toBe('pendiente');
      expect(stored.abonos).toHaveLength(0);

      // A real abono for the actual total still settles it normally,
      // completely independent of the (unrelated) planned schedule.
      const res = await asColaborador(
        request(app.getHttpServer()).post(`/deudas/${created.body.id}/abonos`),
      )
        .send({ montoMinor: 100_00 })
        .expect(201);
      expect(res.body.status).toBe('saldada');
    });

    it('saldadaAt is set exactly once, at the exact transaction that settles the deuda, and never otherwise', async () => {
      const product = await createProduct({
        name: `saldadaAt una vez ${randomUUID()}`,
        tipo: 'cantidad',
        unitPriceMinor: 50_00,
        stock: 5,
      });
      const created = await asSocio(
        request(app.getHttpServer()).post('/deudas'),
      )
        .send({
          type: 'fiado',
          abonoInicialMinor: 0,
          productId: product.id,
          cantidad: 1,
          deudor: { nombre: 'Cliente saldadaAt' },
        })
        .expect(201);

      const beforeSettling = await withTestTenant(contextId, () =>
        prisma.deuda.findUniqueOrThrow({ where: { id: created.body.id } }),
      );
      expect(beforeSettling.saldadaAt).toBeNull();

      // A partial abono (deuda stays pendiente) must not set saldadaAt.
      await asColaborador(
        request(app.getHttpServer()).post(`/deudas/${created.body.id}/abonos`),
      )
        .send({ montoMinor: 20_00 })
        .expect(201);
      const stillPending = await withTestTenant(contextId, () =>
        prisma.deuda.findUniqueOrThrow({ where: { id: created.body.id } }),
      );
      expect(stillPending.saldadaAt).toBeNull();

      const settlingAbono = await asColaborador(
        request(app.getHttpServer()).post(`/deudas/${created.body.id}/abonos`),
      )
        .send({ montoMinor: 30_00 })
        .expect(201);
      expect(settlingAbono.body.status).toBe('saldada');
      const settled = await withTestTenant(contextId, () =>
        prisma.deuda.findUniqueOrThrow({ where: { id: created.body.id } }),
      );
      expect(settled.saldadaAt).not.toBeNull();
      const firstSaldadaAt = settled.saldadaAt!.getTime();

      // Attempting a further abono against an already-saldada deuda is
      // rejected (0 remaining balance) and must not touch saldadaAt again.
      await asColaborador(
        request(app.getHttpServer()).post(`/deudas/${created.body.id}/abonos`),
      )
        .send({ montoMinor: 1 })
        .expect(400);
      const stillSettled = await withTestTenant(contextId, () =>
        prisma.deuda.findUniqueOrThrow({ where: { id: created.body.id } }),
      );
      expect(stillSettled.saldadaAt!.getTime()).toBe(firstSaldadaAt);
    });
  });

  describe('cost snapshot (BE-15 D5)', () => {
    it('a product without purchaseCostMinor yields unitCostMinor: null on the Deuda, never estimated', async () => {
      const product = await createProduct({
        name: `Sin costo ${randomUUID()}`,
        tipo: 'cantidad',
        unitPriceMinor: 20_00,
        stock: 5,
      });
      const res = await asSocio(request(app.getHttpServer()).post('/deudas'))
        .send({
          type: 'fiado',
          abonoInicialMinor: 0,
          productId: product.id,
          cantidad: 1,
          deudor: { nombre: 'Cliente Sin Costo' },
        })
        .expect(201);
      expect(res.body.unitCostMinor).toBeNull();
    });

    it('a product with purchaseCostMinor snapshots it onto the Deuda at creation', async () => {
      const product = await withTestTenant(contextId, () =>
        prisma.product.create({
          data: {
            name: `Con costo ${randomUUID()}`,
            tipo: 'cantidad',
            unitPriceMinor: 20_00,
            initialStock: 5,
            stock: 5,
            contextId,
            purchaseCostMinor: 12_00,
          },
        }),
      );
      const res = await asSocio(request(app.getHttpServer()).post('/deudas'))
        .send({
          type: 'fiado',
          abonoInicialMinor: 0,
          productId: product.id,
          cantidad: 1,
          deudor: { nombre: 'Cliente Con Costo' },
        })
        .expect(201);
      expect(res.body.unitCostMinor).toBe(12_00);
    });
  });

  describe('cuotas endpoints (BE-15 D3, socio-only)', () => {
    it('POST /deudas/:id/cuotas adds one, PATCH edits it, DELETE removes it', async () => {
      const product = await createProduct({
        name: `Cuotas CRUD ${randomUUID()}`,
        tipo: 'cantidad',
        unitPriceMinor: 100_00,
        stock: 5,
      });
      const created = await asSocio(
        request(app.getHttpServer()).post('/deudas'),
      )
        .send({
          type: 'fiado',
          abonoInicialMinor: 0,
          productId: product.id,
          cantidad: 1,
          deudor: { nombre: 'Cliente Cuotas CRUD' },
        })
        .expect(201);

      const added = await asSocio(
        request(app.getHttpServer()).post(`/deudas/${created.body.id}/cuotas`),
      )
        .send({ fechaEsperada: '2030-01-01', montoEsperadoMinor: 50_00 })
        .expect(201);
      expect(added.body.montoEsperadoMinor).toBe(50_00);
      expectUuidV7(added.body.id);

      const edited = await asSocio(
        request(app.getHttpServer()).patch(
          `/deudas/${created.body.id}/cuotas/${added.body.id}`,
        ),
      )
        .send({ montoEsperadoMinor: 60_00 })
        .expect(200);
      expect(edited.body.montoEsperadoMinor).toBe(60_00);

      await asSocio(
        request(app.getHttpServer()).delete(
          `/deudas/${created.body.id}/cuotas/${added.body.id}`,
        ),
      ).expect(200);

      const remaining = await withTestTenant(contextId, () =>
        prisma.cuotaPlaneada.count({ where: { deudaId: created.body.id } }),
      );
      expect(remaining).toBe(0);
    });

    it('cuotasPlaneadas can be sent at Deuda creation and land correctly', async () => {
      const product = await createProduct({
        name: `Cuotas en creacion ${randomUUID()}`,
        tipo: 'cantidad',
        unitPriceMinor: 90_00,
        stock: 5,
      });
      const res = await asSocio(request(app.getHttpServer()).post('/deudas'))
        .send({
          type: 'fiado',
          abonoInicialMinor: 0,
          productId: product.id,
          cantidad: 1,
          deudor: { nombre: 'Cliente Cuotas En Creacion' },
          cuotasPlaneadas: [
            { fechaEsperada: '2030-01-01', montoEsperadoMinor: 45_00 },
            { fechaEsperada: '2030-02-01', montoEsperadoMinor: 45_00 },
          ],
        })
        .expect(201);
      expect(res.body.cuotasPlaneadas).toHaveLength(2);
    });

    it('rejects a colaborador on all three cuotas endpoints with 403', async () => {
      const product = await createProduct({
        name: `Cuotas 403 ${randomUUID()}`,
        tipo: 'cantidad',
        unitPriceMinor: 100_00,
        stock: 5,
      });
      const created = await asSocio(
        request(app.getHttpServer()).post('/deudas'),
      )
        .send({
          type: 'fiado',
          abonoInicialMinor: 0,
          productId: product.id,
          cantidad: 1,
          deudor: { nombre: 'Cliente Cuotas 403' },
        })
        .expect(201);
      const cuota = await withTestTenant(contextId, () =>
        prisma.cuotaPlaneada.create({
          data: {
            id: randomUUID(),
            deudaId: created.body.id,
            contextId,
            fechaEsperada: new Date('2030-01-01T00:00:00.000Z'),
            montoEsperadoMinor: 10_00,
          },
        }),
      );

      await asColaborador(
        request(app.getHttpServer()).post(`/deudas/${created.body.id}/cuotas`),
      )
        .send({ fechaEsperada: '2030-01-01', montoEsperadoMinor: 10_00 })
        .expect(403);
      await asColaborador(
        request(app.getHttpServer()).patch(
          `/deudas/${created.body.id}/cuotas/${cuota.id}`,
        ),
      )
        .send({ montoEsperadoMinor: 20_00 })
        .expect(403);
      await asColaborador(
        request(app.getHttpServer()).delete(
          `/deudas/${created.body.id}/cuotas/${cuota.id}`,
        ),
      ).expect(403);
    });
  });

  describe('GET /deudas atrasado filter + extended sort (BE-15 D6)', () => {
    it('atrasado: false when there are no cuotas at all', async () => {
      const product = await createProduct({
        name: `Atrasado sin cuotas ${randomUUID()}`,
        tipo: 'cantidad',
        unitPriceMinor: 10_00,
        stock: 5,
      });
      const created = await asSocio(
        request(app.getHttpServer()).post('/deudas'),
      )
        .send({
          type: 'fiado',
          abonoInicialMinor: 0,
          productId: product.id,
          cantidad: 1,
          deudor: { nombre: `Deudor Sin Cuotas ${randomUUID()}` },
        })
        .expect(201);

      const res = await asSocio(
        request(app.getHttpServer()).get(`/deudas/${created.body.id}`),
      ).expect(200);
      expect(res.body.id).toBe(created.body.id);

      const list = await asSocio(
        request(app.getHttpServer()).get('/deudas?atrasado=true&limit=100'),
      ).expect(200);
      const ids = (list.body.items as { id: string }[]).map((d) => d.id);
      expect(ids).not.toContain(created.body.id);
    });

    it('atrasado: false when planned cuotas are all met by real abonos', async () => {
      const product = await createProduct({
        name: `Atrasado cuotas cumplidas ${randomUUID()}`,
        tipo: 'cantidad',
        unitPriceMinor: 100_00,
        stock: 5,
      });
      const created = await asSocio(
        request(app.getHttpServer()).post('/deudas'),
      )
        .send({
          type: 'fiado',
          abonoInicialMinor: 0,
          productId: product.id,
          cantidad: 1,
          deudor: { nombre: `Deudor Cuotas Cumplidas ${randomUUID()}` },
          cuotasPlaneadas: [
            { fechaEsperada: '2020-01-01', montoEsperadoMinor: 100_00 },
          ],
        })
        .expect(201);
      await asColaborador(
        request(app.getHttpServer()).post(`/deudas/${created.body.id}/abonos`),
      )
        .send({ montoMinor: 100_00 })
        .expect(201);

      const list = await asSocio(
        request(app.getHttpServer()).get('/deudas?atrasado=true&limit=100'),
      ).expect(200);
      const ids = (list.body.items as { id: string }[]).map((d) => d.id);
      expect(ids).not.toContain(created.body.id);

      const listFalse = await asSocio(
        request(app.getHttpServer()).get('/deudas?atrasado=false&limit=100'),
      ).expect(200);
      const idsFalse = (listFalse.body.items as { id: string }[]).map(
        (d) => d.id,
      );
      expect(idsFalse).toContain(created.body.id);
    });

    it('atrasado: true when a planned cuota is overdue and not covered by real abonos', async () => {
      const product = await createProduct({
        name: `Atrasado cuotas vencidas ${randomUUID()}`,
        tipo: 'cantidad',
        unitPriceMinor: 100_00,
        stock: 5,
      });
      const created = await asSocio(
        request(app.getHttpServer()).post('/deudas'),
      )
        .send({
          type: 'fiado',
          abonoInicialMinor: 0,
          productId: product.id,
          cantidad: 1,
          deudor: { nombre: `Deudor Cuotas Vencidas ${randomUUID()}` },
          cuotasPlaneadas: [
            { fechaEsperada: '2020-01-01', montoEsperadoMinor: 50_00 },
          ],
        })
        .expect(201);

      const list = await asSocio(
        request(app.getHttpServer()).get('/deudas?atrasado=true&limit=100'),
      ).expect(200);
      const ids = (list.body.items as { id: string }[]).map((d) => d.id);
      expect(ids).toContain(created.body.id);
    });

    it('sorts by pending balance descending (orderBy=saldoPendiente)', async () => {
      const product = await createProduct({
        name: `Orden saldo ${randomUUID()}`,
        tipo: 'cantidad',
        unitPriceMinor: 100_00,
        stock: 10,
      });
      const higher = await asSocio(request(app.getHttpServer()).post('/deudas'))
        .send({
          type: 'fiado',
          abonoInicialMinor: 0,
          productId: product.id,
          cantidad: 3,
          deudor: { nombre: `Deudor Saldo Alto ${randomUUID()}` },
        })
        .expect(201);
      const lower = await asSocio(request(app.getHttpServer()).post('/deudas'))
        .send({
          type: 'fiado',
          abonoInicialMinor: 0,
          productId: product.id,
          cantidad: 1,
          deudor: { nombre: `Deudor Saldo Bajo ${randomUUID()}` },
        })
        .expect(201);

      const res = await asSocio(
        request(app.getHttpServer()).get(
          '/deudas?orderBy=saldoPendiente&limit=100',
        ),
      ).expect(200);
      const ids = (res.body.items as { id: string }[]).map((d) => d.id);
      const higherIndex = ids.indexOf(higher.body.id);
      const lowerIndex = ids.indexOf(lower.body.id);
      expect(higherIndex).toBeGreaterThanOrEqual(0);
      expect(lowerIndex).toBeGreaterThanOrEqual(0);
      expect(higherIndex).toBeLessThan(lowerIndex);
    });

    it('sorts by earliest overdue cuota (orderBy=cuotaVencida)', async () => {
      const product = await createProduct({
        name: `Orden cuota vencida ${randomUUID()}`,
        tipo: 'cantidad',
        unitPriceMinor: 50_00,
        stock: 10,
      });
      const moreOverdue = await asSocio(
        request(app.getHttpServer()).post('/deudas'),
      )
        .send({
          type: 'fiado',
          abonoInicialMinor: 0,
          productId: product.id,
          cantidad: 1,
          deudor: { nombre: `Deudor Mas Vencido ${randomUUID()}` },
          cuotasPlaneadas: [
            { fechaEsperada: '2019-01-01', montoEsperadoMinor: 50_00 },
          ],
        })
        .expect(201);
      const lessOverdue = await asSocio(
        request(app.getHttpServer()).post('/deudas'),
      )
        .send({
          type: 'fiado',
          abonoInicialMinor: 0,
          productId: product.id,
          cantidad: 1,
          deudor: { nombre: `Deudor Menos Vencido ${randomUUID()}` },
          cuotasPlaneadas: [
            { fechaEsperada: '2021-01-01', montoEsperadoMinor: 50_00 },
          ],
        })
        .expect(201);
      const noCuotas = await asSocio(
        request(app.getHttpServer()).post('/deudas'),
      )
        .send({
          type: 'fiado',
          abonoInicialMinor: 0,
          productId: product.id,
          cantidad: 1,
          deudor: { nombre: `Deudor Sin Vencer ${randomUUID()}` },
        })
        .expect(201);

      const res = await asSocio(
        request(app.getHttpServer()).get(
          '/deudas?orderBy=cuotaVencida&limit=100',
        ),
      ).expect(200);
      const ids = (res.body.items as { id: string }[]).map((d) => d.id);
      const moreIdx = ids.indexOf(moreOverdue.body.id);
      const lessIdx = ids.indexOf(lessOverdue.body.id);
      const noneIdx = ids.indexOf(noCuotas.body.id);
      expect(moreIdx).toBeGreaterThanOrEqual(0);
      expect(lessIdx).toBeGreaterThan(moreIdx);
      expect(noneIdx).toBeGreaterThan(lessIdx);
    });
  });
});

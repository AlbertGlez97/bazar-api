import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/database/prisma.service.js';

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

  const createProduct = (data: {
    name: string;
    tipo: 'unica' | 'cantidad';
    unitPriceMinor: number;
    stock: number;
  }) =>
    prisma.product.create({
      data: {
        name: data.name,
        tipo: data.tipo,
        unitPriceMinor: data.unitPriceMinor,
        initialStock: data.stock,
        stock: data.stock,
        contextId,
      },
    });

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
    socioMemberId = (
      await prisma.member.create({
        data: { name: 'Alberto Socio', role: 'socio', contextId },
      })
    ).id;

    const colaboradorAccount = await prisma.account.create({
      data: {
        username: randomUUID(),
        passwordHash: 'not-a-login-fixture',
        contextId,
      },
    });
    colaboradorToken = await jwt.signAsync({ sub: colaboradorAccount.id });
    colaboradorMemberId = (
      await prisma.member.create({
        data: { name: 'Ayudante Colaborador', role: 'colaborador', contextId },
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

  afterAll(async () => {
    if (prisma) {
      await prisma.abono.deleteMany({
        where: { deuda: { createdByMember: { contextId } } },
      });
      await prisma.deuda.deleteMany({
        where: { createdByMember: { contextId } },
      });
      await prisma.deudor.deleteMany({ where: { contextId } });
      await prisma.product.deleteMany({ where: { contextId } });
      await prisma.account.deleteMany({ where: { contextId } });
      await prisma.device.deleteMany({ where: { contextId } });
      await prisma.member.deleteMany({ where: { contextId } });
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
        productId: product.id,
        cantidad: 1,
        deudor: { nombre: 'Cliente Fiado Unica' },
      })
      .expect(201);
    expect(res.body.totalMinor).toBe(50_00);
    expect(res.body.status).toBe('pendiente');

    const updated = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });
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
        productId: product.id,
        cantidad: 3,
        deudor: { nombre: 'Cliente Apartado' },
      })
      .expect(201);

    const updated = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });
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
        productId: product.id,
        cantidad: 1,
        deudor: { nombre: 'No debería crearse' },
      })
      .expect(403);

    const updated = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });
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
        productId: product.id,
        cantidad: 3,
        deudor: { nombre: 'Cliente Sin Stock' },
      })
      .expect(400);

    const updated = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });
    expect(updated.stock).toBe(2);
    const deudaCount = await prisma.deuda.count({
      where: { productId: product.id },
    });
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

    const deuda = await prisma.deuda.findUniqueOrThrow({
      where: { id: created.body.id },
      include: { abonos: true },
    });
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
        productId: product.id,
        cantidad: 1,
        deudor: { nombre: searchableName },
      })
      .expect(201);

    const settled = await asSocio(request(app.getHttpServer()).post('/deudas'))
      .send({
        type: 'fiado',
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
});

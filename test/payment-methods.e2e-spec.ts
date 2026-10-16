import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import type { INestApplication } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';
import { v7 } from 'uuid';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { withTestTenant } from './tenant-scope.js';

/**
 * Payment methods (EFECTIVO / TRANSFERENCIA / TARJETA) on sales and abonos,
 * and the per-method totals of the sales-by-period report, against a real
 * PostgreSQL.
 */
describe('payment methods', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const contextA = `pm-a-${randomUUID()}`;
  const contextB = `pm-b-${randomUUID()}`;
  let tokenA: string;
  let tokenB: string;
  let socioA: string;
  let deviceA: string;
  let socioB: string;
  let deviceB: string;

  type Who = { token: string; member: string; device: string };
  const A = (): Who => ({ token: tokenA, member: socioA, device: deviceA });
  const B = (): Who => ({ token: tokenB, member: socioB, device: deviceB });
  const as = (req: request.Test, who: Who) =>
    req.auth(who.token, { type: 'bearer' }).set('x-member-id', who.member).set('x-device-id', who.device);

  const newProduct = (overrides: Record<string, unknown> = {}, contextId = contextA) =>
    withTestTenant(contextId, () =>
      prisma.product.create({
        data: {
          name: `Producto ${randomUUID()}`,
          tipo: 'cantidad',
          unitPriceMinor: 500,
          initialStock: 100,
          stock: 100,
          purchaseCostMinor: 200,
          contextId,
          ...overrides,
        },
      }),
    );
  const stockOf = (id: string, contextId = contextA) =>
    withTestTenant(contextId, async () => (await prisma.product.findUniqueOrThrow({ where: { id } })).stock);

  const saleBody = (productId: string, overrides: Record<string, unknown> = {}, who = A()) => ({
    id: randomUUID(),
    memberId: who.member,
    deviceId: who.device,
    occurredAt: new Date().toISOString(),
    currency: 'MXN',
    cashReceivedMinor: 1000,
    items: [{ productId, quantity: 1 }],
    ...overrides,
  });
  const postSale = (body: Record<string, unknown>, who = A()) =>
    as(request(app.getHttpServer()).post('/sales'), who).send(body);
  const withoutCash = ({ cashReceivedMinor: _cash, ...rest }: Record<string, unknown>) => rest;

  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    const jwt = app.get(JwtService);
    const account = (contextId: string) =>
      prisma.account.create({ data: { username: randomUUID(), passwordHash: 'not-a-login-fixture', contextId } });
    tokenA = await jwt.signAsync({ sub: (await account(contextA)).id });
    tokenB = await jwt.signAsync({ sub: (await account(contextB)).id });
    await withTestTenant(contextA, async () => {
      socioA = (await prisma.member.create({ data: { name: 'Socio A', role: 'socio', contextId: contextA } })).id;
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

  describe('existing rows keep their meaning', () => {
    it('a Sale and an Abono written without a method are EFECTIVO', async () => {
      const product = await newProduct();
      const sale = await withTestTenant(contextA, () =>
        prisma.sale.create({
          data: {
            id: randomUUID(), memberId: socioA, deviceId: deviceA, contextId: contextA,
            occurredAt: new Date(), status: 'completada', totalMinor: 500, cashReceivedMinor: 1000, changeMinor: 500,
            items: { create: { contextId: contextA, productId: product.id, quantity: 1, unitPriceMinor: 500, subtotalMinor: 500 } },
          },
        }),
      );

      expect(sale.paymentMethod).toBe('EFECTIVO');
      expect(sale.cashReceivedMinor).toBe(1000);
      expect(sale.changeMinor).toBe(500);
    });

    it('the database refuses cash on a non-cash sale (CHECK), never storing 0 as "not applicable"', async () => {
      const product = await newProduct();
      const attempt = (cash: number | null, change: number | null) =>
        withTestTenant(contextA, () =>
          prisma.sale.create({
            data: {
              id: randomUUID(), memberId: socioA, deviceId: deviceA, contextId: contextA, occurredAt: new Date(),
              status: 'completada', totalMinor: 500, paymentMethod: 'TARJETA', cashReceivedMinor: cash, changeMinor: change,
              items: { create: { contextId: contextA, productId: product.id, quantity: 1, unitPriceMinor: 500, subtotalMinor: 500 } },
            },
          }),
        );

      await expect(attempt(0, null)).rejects.toThrow();
      await expect(attempt(null, 0)).rejects.toThrow();
      await expect(attempt(null, null)).resolves.toMatchObject({ paymentMethod: 'TARJETA', cashReceivedMinor: null });
    });
  });

  describe('POST /sales', () => {
    it('EFECTIVO: the existing rules (cash, change)', async () => {
      const product = await newProduct();

      const res = await postSale(saleBody(product.id, { paymentMethod: 'EFECTIVO', cashReceivedMinor: 1000 })).expect(201);

      expect(res.body).toMatchObject({ paymentMethod: 'EFECTIVO', totalMinor: 500, cashReceivedMinor: 1000, changeMinor: 500 });
      expect(await stockOf(product.id)).toBe(99);
    });

    it('no method (a device that predates the field): EFECTIVO', async () => {
      const product = await newProduct();

      const res = await postSale(saleBody(product.id)).expect(201);

      expect(res.body).toMatchObject({ paymentMethod: 'EFECTIVO', cashReceivedMinor: 1000, changeMinor: 500 });
    });

    it('EFECTIVO with less cash than the total is still 400', async () => {
      const product = await newProduct();

      await postSale(saleBody(product.id, { cashReceivedMinor: 499 })).expect(400);
      await postSale(saleBody(product.id, { paymentMethod: 'EFECTIVO', cashReceivedMinor: 499 })).expect(400);
      expect(await stockOf(product.id)).toBe(100);
    });

    it.each(['TRANSFERENCIA', 'TARJETA'])('%s: charges the full total, cash and change are null (not 0)', async (paymentMethod) => {
      const product = await newProduct();

      const res = await postSale(withoutCash(saleBody(product.id, { paymentMethod }))).expect(201);

      expect(res.body.paymentMethod).toBe(paymentMethod);
      expect(res.body.totalMinor).toBe(500);
      expect(res.body.cashReceivedMinor).toBeNull();
      expect(res.body.changeMinor).toBeNull();
      expect(res.body.status).toBe('completada');
      expect(await stockOf(product.id)).toBe(99);
    });

    it.each(['TRANSFERENCIA', 'TARJETA'])('%s with a cash received is 400, and nothing is sold', async (paymentMethod) => {
      const product = await newProduct();

      await postSale(saleBody(product.id, { paymentMethod, cashReceivedMinor: 500 })).expect(400);
      await postSale(saleBody(product.id, { paymentMethod, cashReceivedMinor: 0 })).expect(400);

      expect(await stockOf(product.id)).toBe(100);
    });

    it.each(['efectivo', 'Tarjeta', 'CHEQUE', 'CASH', '', 7])('rejects the unknown method %j with 400', async (paymentMethod) => {
      const product = await newProduct();

      await postSale(saleBody(product.id, { paymentMethod })).expect(400);

      expect(await stockOf(product.id)).toBe(100);
    });

    it('a non-cash sale for more pieces than the stock is still rejected', async () => {
      const product = await newProduct({ stock: 1 });

      await postSale(withoutCash(saleBody(product.id, { paymentMethod: 'TARJETA', items: [{ productId: product.id, quantity: 2 }] }))).expect(400);
    });

    it('a non-cash sale that loses a stock race is kept as rejected, with its method and null cash', async () => {
      const product = await newProduct({ stock: 1 });
      const first = postSale(withoutCash(saleBody(product.id, { paymentMethod: 'TARJETA' })));
      const second = postSale(withoutCash(saleBody(product.id, { paymentMethod: 'TRANSFERENCIA' })));

      const results = await Promise.all([first, second]);

      const rejected = results.map((r) => r.body).find((body) => body.status === 'rechazada_por_conflicto');
      expect(rejected).toBeDefined();
      expect(['TARJETA', 'TRANSFERENCIA']).toContain(rejected.paymentMethod);
      expect(rejected.cashReceivedMinor).toBeNull();
      expect(await stockOf(product.id)).toBe(0);
    });

    it('GET /sales/:id and GET /sales return the method', async () => {
      const product = await newProduct();
      const created = (await postSale(withoutCash(saleBody(product.id, { paymentMethod: 'TRANSFERENCIA' }))).expect(201)).body;

      const one = await as(request(app.getHttpServer()).get(`/sales/${created.id}`), A()).expect(200);
      const list = await as(request(app.getHttpServer()).get('/sales?limit=100'), A()).expect(200);

      expect(one.body).toMatchObject({ paymentMethod: 'TRANSFERENCIA', cashReceivedMinor: null });
      expect(list.body.items.find((s: { id: string }) => s.id === created.id)).toMatchObject({ paymentMethod: 'TRANSFERENCIA' });
      expect(list.body.items.every((s: { paymentMethod: string }) => ['EFECTIVO', 'TRANSFERENCIA', 'TARJETA'].includes(s.paymentMethod))).toBe(true);
    });
  });

  describe('POST /sales idempotency (a resend is never a 409)', () => {
    it('a sale with no method resent as-is, or as EFECTIVO, replays', async () => {
      const product = await newProduct();
      const body = saleBody(product.id);
      const first = await postSale(body).expect(201);

      const same = await postSale(body).expect(200);
      const explicit = await postSale({ ...body, paymentMethod: 'EFECTIVO' }).expect(200);

      expect(same.body).toEqual(first.body);
      expect(explicit.body).toEqual(first.body);
      expect(await stockOf(product.id)).toBe(99);
    });

    it('a sale with an explicit EFECTIVO resent with no method replays too', async () => {
      const product = await newProduct();
      const body = saleBody(product.id, { paymentMethod: 'EFECTIVO' });
      await postSale(body).expect(201);

      const { paymentMethod: _method, ...legacy } = body;
      await postSale(legacy).expect(200);
    });

    it('a sale stored by the previous version (legacy fingerprint, no method) replays instead of 409', async () => {
      const product = await newProduct();
      const body = saleBody(product.id);
      const occurredAt = new Date(body.occurredAt as string);
      // Exactly the fingerprint the previous version stored.
      const legacyFingerprint = createHash('sha256')
        .update(JSON.stringify({
          memberId: body.memberId, deviceId: body.deviceId, currency: 'MXN', cashReceivedMinor: 1000,
          occurredAt: occurredAt.toISOString(), items: [{ productId: product.id, quantity: 1 }],
        }))
        .digest('hex');
      await withTestTenant(contextA, () =>
        prisma.sale.create({
          data: {
            id: body.id as string, memberId: socioA, deviceId: deviceA, contextId: contextA, occurredAt,
            status: 'completada', totalMinor: 500, cashReceivedMinor: 1000, changeMinor: 500, requestFingerprint: legacyFingerprint,
            items: { create: { contextId: contextA, productId: product.id, quantity: 1, unitPriceMinor: 500, subtotalMinor: 500 } },
          },
        }),
      );

      const res = await postSale(body).expect(200);

      expect(res.body).toMatchObject({ id: body.id, paymentMethod: 'EFECTIVO', cashReceivedMinor: 1000 });
      expect(await stockOf(product.id)).toBe(100);
    });

    it.each(['TRANSFERENCIA', 'TARJETA'])('a %s sale resent unchanged replays', async (paymentMethod) => {
      const product = await newProduct();
      const body = withoutCash(saleBody(product.id, { paymentMethod }));
      const first = await postSale(body).expect(201);

      const again = await postSale(body).expect(200);

      expect(again.body).toEqual(first.body);
      expect(await stockOf(product.id)).toBe(99);
    });

    it('the same id with a different method is a different request: 409', async () => {
      const product = await newProduct();
      const cash = saleBody(product.id);
      await postSale(cash).expect(201);

      await postSale(withoutCash({ ...cash, paymentMethod: 'TARJETA' })).expect(409);
      expect(await stockOf(product.id)).toBe(99);
    });

    it('a TARJETA sale resent as TRANSFERENCIA, or as EFECTIVO, is a 409', async () => {
      const product = await newProduct();
      const card = withoutCash(saleBody(product.id, { paymentMethod: 'TARJETA' }));
      await postSale(card).expect(201);

      await postSale({ ...card, paymentMethod: 'TRANSFERENCIA' }).expect(409);
      await postSale({ ...card, paymentMethod: 'EFECTIVO', cashReceivedMinor: 500 }).expect(409);
    });
  });

  describe('debts: initial abono and later abonos', () => {
    const debtBody = (productId: string, overrides: Record<string, unknown> = {}) => ({
      id: v7(),
      type: 'fiado',
      productId,
      cantidad: 1,
      deudor: { nombre: `Cliente ${randomUUID()}` },
      abonoInicialMinor: 100,
      ...overrides,
    });
    const postDebt = (body: Record<string, unknown>, who = A()) =>
      as(request(app.getHttpServer()).post('/deudas'), who).send(body);
    const abonoOf = async (deudaId: string) =>
      (await as(request(app.getHttpServer()).get(`/deudas/${deudaId}`), A()).expect(200)).body;

    it('the initial abono defaults to EFECTIVO', async () => {
      const product = await newProduct();

      const res = await postDebt(debtBody(product.id)).expect(201);

      expect(res.body.abonos).toHaveLength(1);
      expect(res.body.abonos[0]).toMatchObject({ montoMinor: 100, paymentMethod: 'EFECTIVO' });
    });

    it.each(['TRANSFERENCIA', 'TARJETA'])('the initial abono can be paid by %s', async (abonoInicialPaymentMethod) => {
      const product = await newProduct();

      const res = await postDebt(debtBody(product.id, { abonoInicialPaymentMethod })).expect(201);

      expect(res.body.abonos[0]).toMatchObject({ montoMinor: 100, paymentMethod: abonoInicialPaymentMethod });
      expect(res.body.totalMinor).toBe(500);
      expect(await stockOf(product.id)).toBe(99);
    });

    it('the method changes neither the inventory nor the balance: a card initial abono settles like cash', async () => {
      const cash = await newProduct();
      const card = await newProduct();

      const a = await postDebt(debtBody(cash.id, { abonoInicialMinor: 500 })).expect(201);
      const b = await postDebt(debtBody(card.id, { abonoInicialMinor: 500, abonoInicialPaymentMethod: 'TARJETA' })).expect(201);

      expect(a.body.status).toBe('saldada');
      expect(b.body.status).toBe('saldada');
      expect(await stockOf(cash.id)).toBe(await stockOf(card.id));
    });

    it('GET /deudas/:id returns each abono with its method', async () => {
      const product = await newProduct();
      const debt = (await postDebt(debtBody(product.id, { abonoInicialPaymentMethod: 'TARJETA' })).expect(201)).body;
      await as(request(app.getHttpServer()).post(`/deudas/${debt.id}/abonos`), A()).send({ montoMinor: 150, paymentMethod: 'TRANSFERENCIA' }).expect(201);
      await as(request(app.getHttpServer()).post(`/deudas/${debt.id}/abonos`), A()).send({ montoMinor: 50 }).expect(201);

      const detail = await abonoOf(debt.id);

      const methods = detail.abonos.map((a: { montoMinor: number; paymentMethod: string }) => [a.montoMinor, a.paymentMethod]);
      expect(methods).toEqual(expect.arrayContaining([[100, 'TARJETA'], [150, 'TRANSFERENCIA'], [50, 'EFECTIVO']]));
      expect(detail.abonos).toHaveLength(3);
    });

    it('POST /deudas/:id/abonos returns the debt with the new abono and its method', async () => {
      const product = await newProduct();
      const debt = (await postDebt(debtBody(product.id)).expect(201)).body;

      const res = await as(request(app.getHttpServer()).post(`/deudas/${debt.id}/abonos`), A())
        .send({ montoMinor: 200, paymentMethod: 'TARJETA' }).expect(201);

      expect(res.body.abonos.find((a: { montoMinor: number }) => a.montoMinor === 200)).toMatchObject({ paymentMethod: 'TARJETA' });
    });

    it('an abono over the balance is rejected whatever the method', async () => {
      const product = await newProduct();
      const debt = (await postDebt(debtBody(product.id)).expect(201)).body;

      await as(request(app.getHttpServer()).post(`/deudas/${debt.id}/abonos`), A())
        .send({ montoMinor: 401, paymentMethod: 'TRANSFERENCIA' }).expect(400);
    });

    it.each(['efectivo', 'CHEQUE', 3])('rejects the unknown method %j with 400', async (paymentMethod) => {
      const product = await newProduct();
      const debt = (await postDebt(debtBody(product.id)).expect(201)).body;

      await as(request(app.getHttpServer()).post(`/deudas/${debt.id}/abonos`), A()).send({ montoMinor: 100, paymentMethod }).expect(400);
      await postDebt(debtBody(product.id, { abonoInicialPaymentMethod: paymentMethod })).expect(400);
    });

    it('the method of an abono cannot be edited afterwards (no such route)', async () => {
      const product = await newProduct();
      const debt = (await postDebt(debtBody(product.id)).expect(201)).body;
      const abonoId = debt.abonos[0].id;

      const res = await as(request(app.getHttpServer()).patch(`/deudas/${debt.id}/abonos/${abonoId}`), A()).send({ paymentMethod: 'TARJETA' });

      expect([404, 405]).toContain(res.status);
      expect((await abonoOf(debt.id)).abonos[0].paymentMethod).toBe('EFECTIVO');
    });

    describe('POST /deudas idempotency', () => {
      it('a debt with no method resent as-is, or as EFECTIVO, replays the same receipt', async () => {
        const product = await newProduct();
        const body = debtBody(product.id);
        const first = await postDebt(body).expect(201);

        const same = await postDebt(body).expect(201);
        const explicit = await postDebt({ ...body, abonoInicialPaymentMethod: 'EFECTIVO' }).expect(201);

        expect(same.body).toEqual(first.body);
        expect(explicit.body).toEqual(first.body);
        expect(await stockOf(product.id)).toBe(99);
      });

      it('the same id with another method for the initial abono is a 409', async () => {
        const product = await newProduct();
        const body = debtBody(product.id);
        await postDebt(body).expect(201);

        await postDebt({ ...body, abonoInicialPaymentMethod: 'TARJETA' }).expect(409);
      });

      it('a debt created with TARJETA resent unchanged replays, and 409s as EFECTIVO', async () => {
        const product = await newProduct();
        const body = debtBody(product.id, { abonoInicialPaymentMethod: 'TARJETA' });
        const first = await postDebt(body).expect(201);

        const again = await postDebt(body).expect(201);
        expect(again.body).toEqual(first.body);
        await postDebt({ ...body, abonoInicialPaymentMethod: undefined }).expect(409);
      });
    });
  });

  describe('GET /reports/sales-by-period — total per payment method', () => {
    const period = 'from=2026-01-01&to=2026-12-31';
    const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

    /** A context of its own, so nothing else falls in the period. */
    async function freshContext() {
      const contextId = `pm-report-${randomUUID()}`;
      const account = await prisma.account.create({ data: { username: randomUUID(), passwordHash: 'x', contextId } });
      const token = await app.get(JwtService).signAsync({ sub: account.id });
      const ids = await withTestTenant(contextId, async () => ({
        socio: (await prisma.member.create({ data: { name: 'Socio R', role: 'socio', contextId } })).id,
        colab: (await prisma.member.create({ data: { name: 'Colab R', role: 'colaborador', commissionRateBps: 1000, contextId } })).id,
        device: (await prisma.device.create({ data: { name: 'Tablet R', identifier: randomUUID(), contextId, authorized: true } })).id,
      }));
      const socio: Who = { token, member: ids.socio, device: ids.device };
      const colab: Who = { token, member: ids.colab, device: ids.device };
      // price 1000, cost 400 -> 600 of profit per piece, whatever the method
      const product = await newProduct({ stock: 100, unitPriceMinor: 1000, purchaseCostMinor: 400 }, contextId);
      return { contextId, socio, colab, product };
    }
    const report = async (who: Who) =>
      (await as(request(app.getHttpServer()).get(`/reports/sales-by-period?${period}`), who).expect(200)).body;

    it('the three methods add up to the combined total and to what was taken in', async () => {
      const { socio, product } = await freshContext();
      const sellCash = (quantity: number) =>
        postSale(saleBody(product.id, { items: [{ productId: product.id, quantity }], cashReceivedMinor: 100000 }, socio), socio).expect(201);
      const sellBy = (paymentMethod: string, quantity: number) =>
        postSale(withoutCash(saleBody(product.id, { paymentMethod, items: [{ productId: product.id, quantity }] }, socio)), socio).expect(201);
      await sellCash(2); // EFECTIVO 2000
      await sellBy('TARJETA', 3); // 3000
      await sellBy('TRANSFERENCIA', 1); // 1000
      await sellBy('TARJETA', 1); // 1000 -> TARJETA 4000
      // A debt of 2000 (2 pieces): initial 300 by transfer, then 200 by card and 100 in cash.
      const debt = (
        await as(request(app.getHttpServer()).post('/deudas'), socio)
          .send({ id: v7(), type: 'fiado', productId: product.id, cantidad: 2, deudor: { nombre: 'Cliente R' }, abonoInicialMinor: 300, abonoInicialPaymentMethod: 'TRANSFERENCIA' })
          .expect(201)
      ).body;
      await as(request(app.getHttpServer()).post(`/deudas/${debt.id}/abonos`), socio).send({ montoMinor: 200, paymentMethod: 'TARJETA' }).expect(201);
      await as(request(app.getHttpServer()).post(`/deudas/${debt.id}/abonos`), socio).send({ montoMinor: 100 }).expect(201);

      const body = await report(socio);

      expect(body.porMetodoPago).toEqual({
        EFECTIVO: { ventasMinor: 2000, abonosMinor: 100, totalMinor: 2100 },
        TRANSFERENCIA: { ventasMinor: 1000, abonosMinor: 300, totalMinor: 1300 },
        TARJETA: { ventasMinor: 4000, abonosMinor: 200, totalMinor: 4200 },
      });
      expect(body.totalSoldMinor).toBe(7000);
      expect(body.abonosRecibidosMinor).toBe(600);
      expect(body.totalIngresadoMinor).toBe(7600);
      // The invariant: the three methods are exactly the combined total.
      const methods = Object.values(body.porMetodoPago) as { ventasMinor: number; abonosMinor: number; totalMinor: number }[];
      expect(sum(methods.map((m) => m.totalMinor))).toBe(body.totalIngresadoMinor);
      expect(sum(methods.map((m) => m.ventasMinor))).toBe(body.totalSoldMinor);
      expect(sum(methods.map((m) => m.abonosMinor))).toBe(body.abonosRecibidosMinor);
      expect(body.saleCount).toBe(4);
      expect(body.abonosRecibidos.map((a: { paymentMethod: string }) => a.paymentMethod).sort()).toEqual(['EFECTIVO', 'TARJETA', 'TRANSFERENCIA']);
    });

    it('a period with nothing lists the three methods at zero', async () => {
      const { socio } = await freshContext();

      const body = await report(socio);

      expect(Object.keys(body.porMetodoPago).sort()).toEqual(['EFECTIVO', 'TARJETA', 'TRANSFERENCIA']);
      expect(body.totalIngresadoMinor).toBe(0);
    });

    it('a sale rejected for a stock conflict is not counted under any method', async () => {
      const { socio, product, contextId } = await freshContext();
      await withTestTenant(contextId, () => prisma.product.update({ where: { id: product.id }, data: { stock: 1 } }));
      const sell = (paymentMethod: string) => postSale(withoutCash(saleBody(product.id, { paymentMethod }, socio)), socio);

      await Promise.all([sell('TARJETA'), sell('TRANSFERENCIA')]);

      const body = await report(socio);
      expect(body.saleCount).toBe(1);
      expect(body.totalIngresadoMinor).toBe(1000);
      expect(sum(Object.values(body.porMetodoPago).map((m) => (m as { totalMinor: number }).totalMinor))).toBe(1000);
    });

    it('commissions, profit and per-seller totals do not depend on the method', async () => {
      const { colab, socio, product } = await freshContext();
      await postSale(saleBody(product.id, { cashReceivedMinor: 5000 }, colab), colab).expect(201); // cash 1000
      await postSale(withoutCash(saleBody(product.id, { paymentMethod: 'TARJETA' }, colab)), colab).expect(201); // card 1000
      await postSale(withoutCash(saleBody(product.id, { paymentMethod: 'TRANSFERENCIA' }, colab)), colab).expect(201); // transfer 1000

      const commissions = (await as(request(app.getHttpServer()).get(`/commissions?${period}`), socio).expect(200)).body;
      const bySeller = (await as(request(app.getHttpServer()).get(`/reports/sales-by-member?${period}`), socio).expect(200)).body;
      const detail = (await as(request(app.getHttpServer()).get(`/reports/sales-detail?${period}`), socio).expect(200)).body;

      expect(commissions.items[0]).toMatchObject({ totalSoldMinor: 3000, rateBps: 1000, commissionMinor: 300 });
      expect(bySeller.items[0]).toMatchObject({ role: 'colaborador', totalSoldMinor: 3000 });
      expect(detail.totals).toMatchObject({ ingresoMinor: 3000, gananciaMinor: 1800 });
    });

    it('is scoped to the context: another business sees none of it', async () => {
      const { socio, product } = await freshContext();
      await postSale(withoutCash(saleBody(product.id, { paymentMethod: 'TARJETA' }, socio)), socio).expect(201);

      const other = await report(B());

      expect(other.porMetodoPago.TARJETA.ventasMinor).toBe(0);
      expect(other.porMetodoPago.TARJETA.totalMinor).toBe(other.porMetodoPago.TARJETA.abonosMinor);
    });
  });

  describe('multi-tenant isolation', () => {
    it("another context cannot read a business's sale, whatever its method", async () => {
      const product = await newProduct();
      const sale = (await postSale(withoutCash(saleBody(product.id, { paymentMethod: 'TARJETA' }))).expect(201)).body;

      await as(request(app.getHttpServer()).get(`/sales/${sale.id}`), B()).expect(404);
      const list = (await as(request(app.getHttpServer()).get('/sales?limit=100'), B()).expect(200)).body;
      expect(list.items.find((s: { id: string }) => s.id === sale.id)).toBeUndefined();
    });

    it("another context cannot add an abono to a business's debt", async () => {
      const product = await newProduct();
      const debt = (
        await as(request(app.getHttpServer()).post('/deudas'), A())
          .send({ id: v7(), type: 'fiado', productId: product.id, cantidad: 1, deudor: { nombre: 'Cliente' }, abonoInicialMinor: 100 })
          .expect(201)
      ).body;

      await as(request(app.getHttpServer()).post(`/deudas/${debt.id}/abonos`), B()).send({ montoMinor: 100, paymentMethod: 'TARJETA' }).expect(404);
    });

    it("a context's reports only count its own payments", async () => {
      const product = await newProduct({}, contextB);
      await postSale(withoutCash(saleBody(product.id, { paymentMethod: 'TRANSFERENCIA' }, B())), B()).expect(201);

      const seenByB = await as(request(app.getHttpServer()).get('/reports/sales-by-period?from=2026-01-01&to=2026-12-31'), B()).expect(200);

      expect(seenByB.body.porMetodoPago.TRANSFERENCIA.ventasMinor).toBeGreaterThanOrEqual(500);
      expect(seenByB.body.porMetodoPago.TARJETA.ventasMinor).toBe(0);
    });
  });
});

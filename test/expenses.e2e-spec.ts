import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { v7 } from 'uuid';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { withTestTenant } from './tenant-scope.js';

describe('business expenses', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  let actorId: string;
  let payerSocioId: string;
  let collaboratorId: string;
  let inactiveId: string;
  let deviceId: string;
  let foreignMemberId: string;
  const contextId = `expenses-${randomUUID()}`;
  const otherContext = `expenses-other-${randomUUID()}`;
  const endpoint = '/finance/expenses';
  const auth = (req: request.Test, memberId = actorId) =>
    req
      .auth(token, { type: 'bearer' })
      .set('x-member-id', memberId)
      .set('x-device-id', deviceId);
  const post = (dto: unknown, memberId = actorId) =>
    auth(request(app.getHttpServer()).post(endpoint), memberId).send(
      dto as object,
    );
  const get = (path = endpoint, query: Record<string, unknown> = {}) =>
    auth(request(app.getHttpServer()).get(path)).query(query);
  const body = (overrides: Record<string, unknown> = {}) => ({
    id: v7(),
    amountMinor: 12500,
    occurredAt: '2026-10-05T10:00:00-06:00',
    nature: 'OPERATING_EXPENSE',
    category: 'transport',
    description: 'Taxi to the bazaar',
    paidByMemberId: payerSocioId,
    fundsSource: 'BUSINESS',
    createdByMemberId: actorId,
    deviceId,
    ...overrides,
  });
  const reversalBody = (overrides: Record<string, unknown> = {}) => ({
    id: v7(),
    createdByMemberId: actorId,
    deviceId,
    occurredAt: '2026-10-05T12:00:00Z',
    reason: 'Incorrect amount',
    ...overrides,
  });
  const reversalPath = (id: string) => `${endpoint}/${id}/reversals`;
  const createOriginal = async (overrides: Record<string, unknown> = {}) => {
    const dto = body(overrides);
    await post(dto).expect(201);
    return dto;
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    const account = await prisma.account.create({
      data: {
        username: randomUUID(),
        passwordHash: 'not-a-login-fixture',
        contextId,
      },
    });
    token = await app.get(JwtService).signAsync({ sub: account.id });
    await withTestTenant(contextId, async () => {
      const member = (
        name: string,
        role: 'socio' | 'colaborador',
        active = true,
      ) => prisma.member.create({ data: { name, role, active, contextId } });
      actorId = (await member('Recorder', 'socio')).id;
      payerSocioId = (await member('Payer socio', 'socio')).id;
      collaboratorId = (await member('Collaborator', 'colaborador')).id;
      inactiveId = (await member('Former member', 'colaborador', false)).id;
      deviceId = (
        await prisma.device.create({
          data: { name: 'Tablet', authorized: true, contextId },
        })
      ).id;
    });
    foreignMemberId = await withTestTenant(
      otherContext,
      async () =>
        (
          await prisma.member.create({
            data: { name: 'Other', role: 'socio', contextId: otherContext },
          })
        ).id,
    );
  });

  afterAll(async () => {
    // Fixtures are isolated by unique context; the database is never reset.
    if (prisma) {
      for (const ctx of [contextId, otherContext])
        await withTestTenant(ctx, async () => {
          await prisma.expenseReversal.deleteMany({
            where: { contextId: ctx },
          });
          await prisma.expense.deleteMany({ where: { contextId: ctx } });
          await prisma.device.deleteMany({ where: { contextId: ctx } });
          await prisma.member.deleteMany({ where: { contextId: ctx } });
        });
      await prisma.account.deleteMany({ where: { contextId } });
    }
    await app?.close();
  });

  describe('creation', () => {
    it('records an integer MXN expense and returns the receipt', async () => {
      const dto = body();
      const res = await post(dto).expect(201);
      expect(res.body).toMatchObject({
        ...dto,
        contextId,
        currency: 'MXN',
        occurredAt: '2026-10-05T16:00:00.000Z',
      });
      expect(res.body.createdByAccountId).toBeTruthy();
      expect(res.body.receivedAt).toBeTruthy();
      expect(res.body.requestFingerprint).toBeUndefined();
    });

    it('trims the description before storing it', async () => {
      const res = await post(
        body({ description: '  Packaging tape  ' }),
      ).expect(201);
      expect(res.body.description).toBe('Packaging tape');
    });

    it.each([0, -1, 1.5, 2147483648, '12500'])(
      'rejects invalid amount %s',
      async (amountMinor) => {
        await post(body({ amountMinor })).expect(400);
      },
    );

    it('rejects blank and oversized descriptions', async () => {
      await post(body({ description: '   ' })).expect(400);
      await post(body({ description: 'x'.repeat(281) })).expect(400);
    });

    it('accepts every operating category and rejects unknown ones', async () => {
      for (const category of ['fuel', 'food', 'bazaar_rent', 'other'])
        await post(body({ category })).expect(201);
      await post(body({ category: 'gifts' })).expect(400);
    });

    it('requires inventory purchases to use the inventory category and nothing else', async () => {
      await post(
        body({ nature: 'INVENTORY_PURCHASE', category: 'inventory' }),
      ).expect(201);
      await post(
        body({ nature: 'INVENTORY_PURCHASE', category: 'transport' }),
      ).expect(400);
      await post(
        body({ nature: 'OPERATING_EXPENSE', category: 'inventory' }),
      ).expect(400);
      await post(body({ nature: 'SALE' })).expect(400);
    });

    it('accepts BUSINESS and PERSONAL funds and rejects anything else', async () => {
      await post(body({ fundsSource: 'PERSONAL' })).expect(201);
      await post(body({ fundsSource: 'BANK' })).expect(400);
    });

    it('requires UUID v7, a zoned instant and rejects client context', async () => {
      for (const overrides of [
        { id: randomUUID() },
        { occurredAt: '2026-10-05' },
        { contextId: otherContext },
      ])
        await post(body(overrides)).expect(400);
    });

    it('allows any active member of the business as payer, whatever the role', async () => {
      await post(body({ paidByMemberId: collaboratorId })).expect(201);
    });

    it('rejects a payer from another business or an inactive payer', async () => {
      await post(body({ paidByMemberId: foreignMemberId })).expect(403);
      await post(body({ paidByMemberId: inactiveId })).expect(403);
    });

    it('blocks collaborators from every endpoint', async () => {
      await post(
        body({ createdByMemberId: collaboratorId }),
        collaboratorId,
      ).expect(403);
      await auth(
        request(app.getHttpServer()).get(endpoint),
        collaboratorId,
      ).expect(403);
      await auth(
        request(app.getHttpServer()).get(endpoint + '/summary'),
        collaboratorId,
      ).expect(403);
      await auth(
        request(app.getHttpServer()).post(reversalPath(v7())),
        collaboratorId,
      )
        .send(reversalBody({ createdByMemberId: collaboratorId }))
        .expect(403);
    });

    it('binds the original actor and device carried offline', async () => {
      await post(body({ createdByMemberId: payerSocioId })).expect(403);
      await post(body({ deviceId: randomUUID() })).expect(403);
    });

    it('replays exact content with 200 and conflicts on changed content', async () => {
      const dto = body();
      const first = await post(dto).expect(201);
      const replay = await post({
        ...dto,
        occurredAt: '2026-10-05T16:00:00Z',
        description: ` ${dto.description} `,
      }).expect(200);
      expect(replay.body).toEqual(first.body);
      await post({ ...dto, amountMinor: 99 }).expect(409);
      await post({ ...dto, category: 'fuel' }).expect(409);
    });

    it('creates once when identical submissions race', async () => {
      const dto = body();
      const results = await Promise.all([0, 1, 2].map(() => post(dto)));
      expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([
        200, 200, 201,
      ]);
      expect(results[0].body).toEqual(results[1].body);
      expect(
        await withTestTenant(contextId, () =>
          prisma.expense.count({ where: { id: dto.id } }),
        ),
      ).toBe(1);
    });

    it('returns a safe conflict for a UUID already owned by another tenant', async () => {
      const dto = body();
      await withTestTenant(otherContext, async () => {
        const device = await prisma.device.create({
          data: { name: 'Other', contextId: otherContext, authorized: true },
        });
        await prisma.expense.create({
          data: {
            id: dto.id,
            contextId: otherContext,
            amountMinor: 1,
            occurredAt: new Date(),
            nature: 'OPERATING_EXPENSE',
            category: 'other',
            description: 'fixture',
            paidByMemberId: foreignMemberId,
            fundsSource: 'BUSINESS',
            createdByMemberId: foreignMemberId,
            createdByAccountId: v7(),
            deviceId: device.id,
            requestFingerprint: 'fixture',
            creationResponse: {},
          },
        });
      });
      await post(dto).expect(409);
    });
  });

  describe('listing', () => {
    it('filters by instant, payer, nature and category with stable cursor pagination', async () => {
      const day = '2025-01-02T00:00:00-06:00';
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const dto = body({ occurredAt: day });
        ids.push(dto.id);
        await post(dto).expect(201);
      }
      await post(
        body({
          occurredAt: day,
          paidByMemberId: collaboratorId,
          nature: 'INVENTORY_PURCHASE',
          category: 'inventory',
        }),
      ).expect(201);
      const window = {
        from: '2025-01-02T06:00:00Z',
        to: '2025-01-03T06:00:00Z',
      };
      const query = {
        ...window,
        paidByMemberId: payerSocioId,
        nature: 'OPERATING_EXPENSE',
        category: 'transport',
        limit: 2,
      };
      const first = await get(endpoint, query).expect(200);
      expect(first.body.items).toHaveLength(2);
      expect(first.body.items[0].paidByMember).toEqual({
        id: payerSocioId,
        name: 'Payer socio',
        active: true,
      });
      expect(first.body.items[0].reversal).toBeNull();
      expect(first.body.items[0].requestFingerprint).toBeUndefined();
      expect(first.body.items[0].creationResponse).toBeUndefined();
      const second = await get(endpoint, {
        ...query,
        cursor: first.body.nextCursor,
      }).expect(200);
      expect(
        [...first.body.items, ...second.body.items].map(
          (r: { id: string }) => r.id,
        ),
      ).toEqual([...ids].sort().reverse());
      expect(second.body.nextCursor).toBeNull();

      const inventory = await get(endpoint, {
        ...window,
        nature: 'INVENTORY_PURCHASE',
      }).expect(200);
      expect(inventory.body.items).toHaveLength(1);
      const byPayer = await get(endpoint, {
        ...window,
        paidByMemberId: collaboratorId,
      }).expect(200);
      expect(byPayer.body.items).toHaveLength(1);
      const empty = await get(endpoint, {
        ...window,
        category: 'fuel',
      }).expect(200);
      expect(empty.body.items).toEqual([]);
    });

    it('rejects invalid filters, reversed ranges and malformed cursors', async () => {
      await get(endpoint, { nature: 'NOPE' }).expect(400);
      await get(endpoint, { category: 'NOPE' }).expect(400);
      await get(endpoint, { paidByMemberId: 'not-a-uuid' }).expect(400);
      await get(endpoint, { cursor: 'garbage' }).expect(400);
      const range = {
        from: '2025-02-02T00:00:00Z',
        to: '2025-02-01T00:00:00Z',
      };
      await get(endpoint, range).expect(400);
      await get(endpoint, { ...range, to: range.from }).expect(400);
    });
  });

  describe('summary', () => {
    const window = { from: '2020-03-01T00:00:00Z', to: '2020-04-01T00:00:00Z' };
    const at = '2020-03-10T12:00:00Z';

    it('is all zeros for an empty period', async () => {
      const res = await get(endpoint + '/summary', {
        from: '2019-01-01T00:00:00Z',
        to: '2019-02-01T00:00:00Z',
      }).expect(200);
      expect(res.body).toEqual({
        operatingMinor: 0,
        inventoryMinor: 0,
        personalMinor: 0,
        businessMinor: 0,
      });
    });

    it('totals by nature and funds source and excludes reversed expenses', async () => {
      await post(body({ occurredAt: at, amountMinor: 1000 })).expect(201);
      await post(
        body({ occurredAt: at, amountMinor: 200, fundsSource: 'PERSONAL' }),
      ).expect(201);
      await post(
        body({
          occurredAt: at,
          amountMinor: 30000,
          nature: 'INVENTORY_PURCHASE',
          category: 'inventory',
          fundsSource: 'PERSONAL',
        }),
      ).expect(201);
      const reversed = await post(
        body({
          occurredAt: at,
          amountMinor: 5000,
          nature: 'INVENTORY_PURCHASE',
          category: 'inventory',
        }),
      ).expect(201);
      // Outside the window: never counted.
      await post(
        body({ occurredAt: '2020-05-01T00:00:00Z', amountMinor: 7 }),
      ).expect(201);

      const before = await get(endpoint + '/summary', window).expect(200);
      expect(before.body).toEqual({
        operatingMinor: 1200,
        inventoryMinor: 35000,
        personalMinor: 30200,
        businessMinor: 6000,
      });

      await auth(
        request(app.getHttpServer()).post(reversalPath(reversed.body.id)),
      )
        .send(reversalBody())
        .expect(201);
      const after = await get(endpoint + '/summary', window).expect(200);
      expect(after.body).toEqual({
        operatingMinor: 1200,
        inventoryMinor: 30000,
        personalMinor: 30200,
        businessMinor: 1000,
      });
    });

    it('counts a replacement and rejects a reversed range', async () => {
      const win = { from: '2020-06-01T00:00:00Z', to: '2020-07-01T00:00:00Z' };
      const original = await createOriginal({
        occurredAt: '2020-06-10T00:00:00Z',
        amountMinor: 900,
      });
      await auth(request(app.getHttpServer()).post(reversalPath(original.id)))
        .send(
          reversalBody({
            replacement: body({
              occurredAt: '2020-06-10T00:00:00Z',
              amountMinor: 400,
            }),
          }),
        )
        .expect(201);
      const res = await get(endpoint + '/summary', win).expect(200);
      expect(res.body.operatingMinor).toBe(400);
      await get(endpoint + '/summary', { from: win.to, to: win.from }).expect(
        400,
      );
    });
  });

  describe('reversal', () => {
    it('reverses an expense, replays exactly and keeps the original receipt', async () => {
      const original = await createOriginal();
      const dto = reversalBody();
      const reversal = await auth(
        request(app.getHttpServer()).post(reversalPath(original.id)),
      )
        .send(dto)
        .expect(201);
      expect(reversal.body).toMatchObject({
        id: dto.id,
        expenseId: original.id,
        reason: dto.reason,
        replacementExpenseId: null,
        replacement: null,
      });
      expect(reversal.body.original.amountMinor).toBe(original.amountMinor);
      const replay = await auth(
        request(app.getHttpServer()).post(reversalPath(original.id)),
      )
        .send(dto)
        .expect(200);
      expect(replay.body).toEqual(reversal.body);
      const receipt = await post(original).expect(200);
      expect(receipt.body.amountMinor).toBe(original.amountMinor);
    });

    it('shows the reversal on the listed expense', async () => {
      const original = await createOriginal({
        occurredAt: '2024-01-01T00:00:00Z',
      });
      const dto = reversalBody();
      await auth(request(app.getHttpServer()).post(reversalPath(original.id)))
        .send(dto)
        .expect(201);
      const list = await get(endpoint, {
        from: '2024-01-01T00:00:00Z',
        to: '2024-01-02T00:00:00Z',
      }).expect(200);
      expect(list.body.items).toHaveLength(1);
      expect(list.body.items[0].reversal).toMatchObject({
        id: dto.id,
        replacementExpenseId: null,
        reason: dto.reason,
      });
    });

    it('rejects blank reasons, changed replays and a second reversal', async () => {
      const original = await createOriginal();
      const dto = reversalBody();
      const path = reversalPath(original.id);
      const send = (payload: unknown) =>
        auth(request(app.getHttpServer()).post(path)).send(payload as object);
      await send({ ...dto, reason: '   ' }).expect(400);
      await send(dto).expect(201);
      await send({ ...dto, reason: 'Changed' }).expect(409);
      await send(reversalBody()).expect(409);
    });

    it('atomically corrects with a linked replacement', async () => {
      const original = await createOriginal();
      const replacement = body({ amountMinor: 600 });
      const dto = reversalBody({ replacement });
      const path = reversalPath(original.id);
      const corrected = await auth(request(app.getHttpServer()).post(path))
        .send(dto)
        .expect(201);
      expect(corrected.body.replacementExpenseId).toBe(replacement.id);
      expect(corrected.body.replacement).toMatchObject({
        id: replacement.id,
        amountMinor: 600,
      });
      const replay = await auth(request(app.getHttpServer()).post(path))
        .send(dto)
        .expect(200);
      expect(replay.body).toEqual(corrected.body);
      // The replacement id is bound to the correction.
      await post(replacement).expect(409);
    });

    it('rolls back the reversal when the replacement is invalid', async () => {
      const taken = await createOriginal();
      const cases = [
        { replacement: body({ paidByMemberId: foreignMemberId }), status: 403 },
        { replacement: body({ paidByMemberId: inactiveId }), status: 403 },
        { replacement: body({ amountMinor: 0 }), status: 400 },
        { replacement: taken, status: 409 },
      ];
      for (const { replacement, status } of cases) {
        const original = await createOriginal();
        const path = reversalPath(original.id);
        await auth(request(app.getHttpServer()).post(path))
          .send(reversalBody({ replacement }))
          .expect(status);
        // Not reversed: a plain reversal still succeeds.
        await auth(request(app.getHttpServer()).post(path))
          .send(reversalBody())
          .expect(201);
      }
    });

    it('rejects an invalid nature/category pair in the replacement', async () => {
      const original = await createOriginal();
      await auth(request(app.getHttpServer()).post(reversalPath(original.id)))
        .send(
          reversalBody({
            replacement: body({
              nature: 'INVENTORY_PURCHASE',
              category: 'transport',
            }),
          }),
        )
        .expect(400);
    });

    it('requires distinct correction identities', async () => {
      const original = await createOriginal();
      await auth(request(app.getHttpServer()).post(reversalPath(original.id)))
        .send(reversalBody({ id: original.id }))
        .expect(400);
    });

    it('serializes concurrent distinct reversals to exactly one winner', async () => {
      const original = await createOriginal();
      const path = reversalPath(original.id);
      const results = await Promise.all(
        [0, 1].map(() =>
          auth(request(app.getHttpServer()).post(path)).send(reversalBody()),
        ),
      );
      expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([
        201, 409,
      ]);
    });

    it('serializes concurrent identical reversal replay', async () => {
      const original = await createOriginal();
      const path = reversalPath(original.id);
      const dto = reversalBody();
      const results = await Promise.all(
        [0, 1].map(() =>
          auth(request(app.getHttpServer()).post(path)).send(dto),
        ),
      );
      expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([
        200, 201,
      ]);
      expect(results[0].body).toEqual(results[1].body);
    });

    it('does not reverse an unknown expense or one from another business', async () => {
      await auth(request(app.getHttpServer()).post(reversalPath(v7())))
        .send(reversalBody())
        .expect(404);
      const foreign = v7();
      await withTestTenant(otherContext, async () => {
        const device = await prisma.device.create({
          data: { name: 'Other 2', contextId: otherContext, authorized: true },
        });
        await prisma.expense.create({
          data: {
            id: foreign,
            contextId: otherContext,
            amountMinor: 1,
            occurredAt: new Date(),
            nature: 'OPERATING_EXPENSE',
            category: 'other',
            description: 'foreign fixture',
            paidByMemberId: foreignMemberId,
            fundsSource: 'BUSINESS',
            createdByMemberId: foreignMemberId,
            createdByAccountId: v7(),
            deviceId: device.id,
            requestFingerprint: 'fixture',
            creationResponse: {},
          },
        });
      });
      await auth(request(app.getHttpServer()).post(reversalPath(foreign)))
        .send(reversalBody())
        .expect(404);
      await withTestTenant(otherContext, async () => {
        expect(
          await prisma.expenseReversal.count({ where: { expenseId: foreign } }),
        ).toBe(0);
      });
    });
  });

  describe('tenant isolation', () => {
    it('hides Expense and ExpenseReversal from another tenant in the extension and in raw SQL', async () => {
      const original = await createOriginal();
      await auth(request(app.getHttpServer()).post(reversalPath(original.id)))
        .send(reversalBody())
        .expect(201);
      await withTestTenant(otherContext, async () => {
        expect(
          await prisma.expense.findMany({
            where: { contextId: otherContext, id: original.id },
          }),
        ).toEqual([]);
        expect(
          await prisma.expenseReversal.findMany({
            where: { contextId: otherContext, expenseId: original.id },
          }),
        ).toEqual([]);
        await prisma.$transaction(async (tx) => {
          expect(
            await tx.$queryRaw`SELECT id FROM "Expense" WHERE id = ${original.id}::uuid`,
          ).toEqual([]);
          expect(
            await tx.$queryRaw`SELECT id FROM "ExpenseReversal" WHERE "expenseId" = ${original.id}::uuid`,
          ).toEqual([]);
        });
      });
      await withTestTenant(contextId, async () => {
        expect(await prisma.expense.count({ where: { id: original.id } })).toBe(
          1,
        );
      });
    });

    it('lists only the caller business', async () => {
      const list = await get(endpoint, { limit: 100 }).expect(200);
      expect(
        list.body.items.every(
          (r: { contextId: string }) => r.contextId === contextId,
        ),
      ).toBe(true);
    });
  });
});

import { vi } from 'vitest';
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import type { PrismaService } from '../database/prisma.service.js';
import type { CreateDistributionAgreementDto } from './finance-agreements.dto.js';
import {
  FinanceAgreementsService,
  isRetryableTransactionError,
  runWithRetry,
} from './finance-agreements.service.js';
import type { FinanceDistributionService } from './finance-distribution.service.js';

const ACCOUNT = '00000000-0000-7000-8000-0000000000a1';
const MEMBER = '00000000-0000-7000-8000-0000000000b1';
const DEVICE = '00000000-0000-7000-8000-0000000000c1';
const ID = '01939000-0000-7000-8000-000000000001';
const FINGERPRINT = 'sim1:' + 'a'.repeat(64);
const actor = {
  account: { id: ACCOUNT, contextId: 'tenant', memberId: null },
  selection: { memberId: MEMBER, deviceId: DEVICE },
} as never;
const dto = (patch: Partial<CreateDistributionAgreementDto> = {}) =>
  ({
    id: ID,
    from: '2026-10-01',
    to: '2026-10-02',
    requestedAmountMinor: 600000,
    partnerShareBps: 5000,
    workShareBps: 5000,
    workBasis: 'WORK_SHIFTS',
    title: ' Reparto ',
    note: null,
    simulationFingerprint: FINGERPRINT,
    occurredAt: '2026-10-09T12:00:00-06:00',
    createdByMemberId: MEMBER,
    deviceId: DEVICE,
    ...patch,
  }) as CreateDistributionAgreementDto;

const simulation = (fingerprint = FINGERPRINT) => ({
  period: { from: '2026-10-01', to: '2026-10-02' },
  simulation: true,
  persisted: false,
  currency: 'MXN',
  financialBase: {
    potentiallyAvailableMinor: 1_000_000,
    requestedAmountMinor: 600000,
    remainingAvailableMinor: 400000,
    status: 'complete',
  },
  rule: { partnerShareBps: 5000, workShareBps: 5000 },
  pools: { partnerPoolMinor: 300000, workPoolMinor: 300000 },
  members: [
    {
      memberId: MEMBER,
      name: 'Ana',
      role: 'socio',
      isActive: true,
      partnerEligible: true,
      partnerAmountMinor: 300000,
      workUnits: 1,
      shiftCount: 1,
      knownMinutes: 0,
      unknownDurationCount: 0,
      workAmountMinor: 300000,
      totalMinor: 600000,
    },
  ],
  totals: { distributedMinor: 600000, undistributedMinor: 0 },
  warnings: [{ code: 'SIMULATION_ONLY', message: 'x' }],
  simulationFingerprint: fingerprint,
});

function setup(
  options: {
    existing?: {
      requestFingerprint: string;
      creationResponse: unknown;
      reversal?: unknown;
      replacedBy?: unknown;
    } | null;
    fingerprint?: string;
    counter?: number;
    authorized?: boolean;
    replaced?: unknown;
    simulate?: () => Promise<unknown>;
    /** Minor units the live agreements of the period already distribute. */
    committed?: number;
  } = {},
) {
  const queries: string[] = [];
  const tx = {
    $queryRaw: vi.fn((strings: TemplateStringsArray) => {
      const text = strings.join('?');
      queries.push(text);
      if (text.includes('"DistributionAgreementCounter"'))
        return Promise.resolve([{ lastNumber: options.counter ?? 1 }]);
      if (text.includes('FROM "Member"'))
        return Promise.resolve(
          options.authorized === false ? [] : [{ id: MEMBER, name: 'Ana' }],
        );
      return Promise.resolve([{ id: 'x' }]);
    }),
    $executeRaw: vi.fn().mockResolvedValue(1),
    distributionAgreement: {
      findFirst: vi.fn(async (args: { where: { id: string } }) =>
        args.where.id === ID ? (options.existing ?? null) : options.replaced,
      ),
      create: vi.fn().mockResolvedValue({}),
      aggregate: vi.fn().mockResolvedValue({
        _sum: { distributedMinor: options.committed ?? 0 },
        _count: { _all: options.committed ? 1 : 0 },
      }),
    },
    distributionAgreementParticipant: {
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const transaction = vi.fn(async (fn: (client: typeof tx) => unknown) =>
    fn(tx),
  );
  const simulateInTx = vi.fn(
    options.simulate ?? (async () => simulation(options.fingerprint)),
  );
  const service = new FinanceAgreementsService(
    { $transaction: transaction } as unknown as PrismaService,
    { simulateInTx } as unknown as FinanceDistributionService,
  );
  return { service, tx, transaction, simulateInTx, queries };
}

const serializationFailure = () =>
  new Prisma.PrismaClientKnownRequestError('write conflict', {
    code: 'P2034',
    clientVersion: 'test',
  });
const noSleep = () => Promise.resolve();

describe('isRetryableTransactionError', () => {
  it('recognizes P2034, SQLSTATE 40001/40P01 and driver messages', () => {
    expect(isRetryableTransactionError(serializationFailure())).toBe(true);
    expect(
      isRetryableTransactionError(
        new Prisma.PrismaClientKnownRequestError('raw', {
          code: 'P2010',
          clientVersion: 'test',
          meta: { code: '40001' },
        }),
      ),
    ).toBe(true);
    expect(
      isRetryableTransactionError(
        new Error('could not serialize access due to concurrent update'),
      ),
    ).toBe(true);
    expect(isRetryableTransactionError(new Error('boom'))).toBe(false);
    expect(
      isRetryableTransactionError(
        new Prisma.PrismaClientKnownRequestError('x', {
          code: 'P2003',
          clientVersion: 'test',
        }),
      ),
    ).toBe(false);
  });
});

describe('runWithRetry', () => {
  it('retries a serialization failure and returns the later result', async () => {
    const unit = vi
      .fn()
      .mockRejectedValueOnce(serializationFailure())
      .mockRejectedValueOnce(serializationFailure())
      .mockResolvedValue('ok');
    await expect(runWithRetry(unit, { sleep: noSleep })).resolves.toBe('ok');
    expect(unit).toHaveBeenCalledTimes(3);
  });

  it('gives up after 5 attempts with a 503 busy code', async () => {
    const unit = vi.fn().mockRejectedValue(serializationFailure());
    const sleep = vi.fn(noSleep);
    const error: unknown = await runWithRetry(unit, { sleep }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getResponse()).toMatchObject({
      code: 'FINANCE_AGREEMENT_BUSY',
    });
    expect(unit).toHaveBeenCalledTimes(5);
    expect(sleep).toHaveBeenCalledTimes(4);
  });

  it('never retries domain errors', async () => {
    const unit = vi.fn().mockRejectedValue(new ConflictException('drift'));
    await expect(runWithRetry(unit, { sleep: noSleep })).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(unit).toHaveBeenCalledTimes(1);
  });

  it('reports a persistent unique violation as not found', async () => {
    const unit = vi.fn().mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dup', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    await expect(runWithRetry(unit, { sleep: noSleep })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(unit).toHaveBeenCalledTimes(5);
  });

  it('spreads retries with a growing jittered backoff', async () => {
    const unit = vi
      .fn()
      .mockRejectedValueOnce(serializationFailure())
      .mockRejectedValueOnce(serializationFailure())
      .mockResolvedValue('ok');
    const sleep = vi.fn(noSleep);
    await runWithRetry(unit, { sleep, random: () => 0.5 });
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([30, 60]);
  });
});

describe('FinanceAgreementsService.create', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-09T18:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('creates in one repeatable-read transaction with a business-year folio', async () => {
    const { service, tx, transaction, simulateInTx } = setup({ counter: 7 });
    const result = await service.create(actor, dto());
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'RepeatableRead',
    });
    expect(simulateInTx).toHaveBeenCalledWith(tx, 'tenant', {
      from: '2026-10-01',
      to: '2026-10-02',
      requestedAmountMinor: 600000,
      partnerShareBps: 5000,
      workShareBps: 5000,
      workBasis: 'WORK_SHIFTS',
    });
    expect(result.created).toBe(true);
    expect(result.receipt).toMatchObject({
      folio: 'AC-2026-00007',
      title: 'Reparto',
      status: 'active',
      createdBy: { memberId: MEMBER, name: 'Ana', accountId: ACCOUNT },
    });
    expect(tx.distributionAgreement.create).toHaveBeenCalledTimes(1);
    expect(
      tx.distributionAgreementParticipant.createMany,
    ).toHaveBeenCalledTimes(1);
    const stored = tx.distributionAgreement.create.mock.calls[0][0].data;
    expect(stored).toMatchObject({
      folio: 'AC-2026-00007',
      createdByMemberName: 'Ana',
      distributedMinor: 600000,
    });
    expect(stored.warningsSnapshot).toEqual([]);
  });

  it('derives the folio year from the business clock at the year boundary', async () => {
    vi.setSystemTime(new Date('2027-01-01T05:30:00.000Z')); // still 2026 in UTC-6
    const { service, tx } = setup({ counter: 3 });
    await service.create(actor, dto());
    expect(tx.distributionAgreement.create.mock.calls[0][0].data.folio).toBe(
      'AC-2026-00003',
    );
    vi.setSystemTime(new Date('2027-01-01T06:00:00.000Z'));
    const next = setup({ counter: 1 });
    await next.service.create(actor, dto());
    expect(
      next.tx.distributionAgreement.create.mock.calls[0][0].data.folio,
    ).toBe('AC-2027-00001');
    const counterCall = next.queries.find((q) =>
      q.includes('DistributionAgreementCounter'),
    );
    expect(counterCall).toContain(
      'ON CONFLICT ("contextId", "year") DO UPDATE',
    );
  });

  it('replays an identical request before drift detection and without touching the counter', async () => {
    const first = setup();
    const created = await first.service.create(actor, dto());
    const stored = first.tx.distributionAgreement.create.mock.calls[0][0].data;
    const replay = setup({
      existing: {
        requestFingerprint: stored.requestFingerprint as string,
        creationResponse: created.receipt,
      },
      fingerprint: 'sim1:' + 'f'.repeat(64), // the world drifted since
    });
    const result = await replay.service.create(actor, dto());
    expect(result).toEqual({ created: false, receipt: created.receipt });
    expect(replay.simulateInTx).not.toHaveBeenCalled();
    expect(
      replay.queries.some((q) => q.includes('DistributionAgreementCounter')),
    ).toBe(false);
    expect(replay.tx.distributionAgreement.create).not.toHaveBeenCalled();
  });

  it('replays a voided and replaced agreement with current links and the original hash', async () => {
    const first = setup();
    const created = await first.service.create(actor, dto());
    const stored = first.tx.distributionAgreement.create.mock.calls[0][0].data;
    const reversal = {
      id: DEVICE,
      agreementId: ID,
      reason: 'Correction',
      occurredAt: new Date(),
      receivedAt: new Date(),
      createdByMemberId: MEMBER,
      createdByAccountId: ACCOUNT,
      deviceId: DEVICE,
    };
    const replacedBy = { id: ACCOUNT, folio: 'AC-2026-00002' };
    const replay = setup({
      existing: {
        requestFingerprint: stored.requestFingerprint as string,
        creationResponse: created.receipt,
        reversal,
        replacedBy,
      },
    });
    const result = await replay.service.create(actor, dto());
    expect(result).toMatchObject({
      created: false,
      receipt: {
        ...created.receipt,
        status: 'voided',
        reversal: {
          ...reversal,
          occurredAt: reversal.occurredAt.toISOString(),
          receivedAt: reversal.receivedAt.toISOString(),
        },
        replacedBy,
      },
    });
    expect(replay.simulateInTx).not.toHaveBeenCalled();
    expect(
      replay.queries.some((q) => q.includes('DistributionAgreementCounter')),
    ).toBe(false);
  });

  it('rejects the same id with different content as an id conflict', async () => {
    const { service, simulateInTx } = setup({
      existing: { requestFingerprint: 'other', creationResponse: {} },
    });
    await expect(service.create(actor, dto())).rejects.toMatchObject({
      response: { code: 'FINANCE_AGREEMENT_ID_CONFLICT' },
    });
    expect(simulateInTx).not.toHaveBeenCalled();
  });

  it('answers drift with 409 and the current fingerprint, persisting and counting nothing', async () => {
    const current = 'sim1:' + 'e'.repeat(64);
    const { service, tx, queries } = setup({ fingerprint: current });
    await expect(service.create(actor, dto())).rejects.toMatchObject({
      response: {
        code: 'FINANCE_AGREEMENT_SIMULATION_CHANGED',
        currentSimulationFingerprint: current,
      },
    });
    expect(tx.distributionAgreement.create).not.toHaveBeenCalled();
    expect(
      tx.distributionAgreementParticipant.createMany,
    ).not.toHaveBeenCalled();
    expect(
      queries.some((q) => q.includes('DistributionAgreementCounter')),
    ).toBe(false);
  });

  it('counts only live agreements of this business and this exact period', async () => {
    const { service, tx } = setup();
    await service.create(actor, dto());
    expect(tx.distributionAgreement.aggregate).toHaveBeenCalledWith({
      where: {
        contextId: 'tenant',
        periodFrom: new Date('2026-10-01T00:00:00.000Z'),
        periodTo: new Date('2026-10-02T00:00:00.000Z'),
        reversal: { is: null },
      },
      _sum: { distributedMinor: true },
      _count: { _all: true },
    });
  });

  it('accepts an agreement that takes exactly what is still free', async () => {
    const { service, tx } = setup({ committed: 400_000 });
    // available 1,000,000 - committed 400,000 = free 600,000 = requested
    await expect(service.create(actor, dto())).resolves.toMatchObject({
      created: true,
    });
    expect(tx.distributionAgreement.create).toHaveBeenCalledTimes(1);
  });

  it('refuses one cent over what is free: 422 in Spanish with every figure, nothing persisted or counted', async () => {
    const { service, tx, queries } = setup({ committed: 400_001 });
    await expect(service.create(actor, dto())).rejects.toMatchObject({
      response: {
        code: 'FINANCE_AGREEMENT_EXCEEDS_UNCOMMITTED',
        availableMinor: 1_000_000,
        committedMinor: 400_001,
        freeMinor: 599_999,
        requestedMinor: 600_000,
        missingMinor: 1,
        message: expect.stringContaining('Faltan $0.01.'),
      },
    });
    expect(tx.distributionAgreement.create).not.toHaveBeenCalled();
    expect(
      queries.some((q) => q.includes('DistributionAgreementCounter')),
    ).toBe(false);
  });

  it('checks the free amount after drift, so a stale simulation is still a 409', async () => {
    const { service } = setup({
      committed: 999_999,
      fingerprint: 'sim1:' + 'e'.repeat(64),
    });
    await expect(service.create(actor, dto())).rejects.toMatchObject({
      response: { code: 'FINANCE_AGREEMENT_SIMULATION_CHANGED' },
    });
  });

  it('propagates simulator domain errors unchanged', async () => {
    const domain = new UnprocessableEntityException({
      code: 'FINANCE_DISTRIBUTION_EXCEEDS_AVAILABLE',
      message: 'too much',
    });
    const { service, tx } = setup({ simulate: () => Promise.reject(domain) });
    await expect(service.create(actor, dto())).rejects.toBe(domain);
    expect(tx.distributionAgreement.create).not.toHaveBeenCalled();
  });

  it('checks the origin before any database work and the live authorization inside', async () => {
    const mismatch = setup();
    await expect(
      service(mismatch).create(actor, dto({ deviceId: ACCOUNT })),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(mismatch.transaction).not.toHaveBeenCalled();
    const revoked = setup({ authorized: false });
    await expect(revoked.service.create(actor, dto())).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(revoked.simulateInTx).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown', null],
    [
      'active',
      { id: 'r', folio: 'AC-2026-00001', reversal: null, replacedBy: null },
    ],
    [
      'already replaced',
      {
        id: 'r',
        folio: 'AC-2026-00001',
        reversal: { id: 'v' },
        replacedBy: { id: 'n' },
      },
    ],
  ])('refuses to replace an %s agreement', async (_label, replaced) => {
    const { service, simulateInTx } = setup({ replaced });
    await expect(
      service.create(
        actor,
        dto({ replacesAgreementId: '01939000-0000-7000-8000-0000000000ff' }),
      ),
    ).rejects.toMatchObject({
      response: { code: 'FINANCE_AGREEMENT_REPLACEMENT_INVALID' },
    });
    expect(simulateInTx).not.toHaveBeenCalled();
  });

  it('refuses an agreement replacing itself and accepts a voided, unreplaced target', async () => {
    const selfReplace = setup();
    await expect(
      selfReplace.service.create(actor, dto({ replacesAgreementId: ID })),
    ).rejects.toMatchObject({
      response: { code: 'FINANCE_AGREEMENT_REPLACEMENT_INVALID' },
    });
    const { service: valid, tx } = setup({
      replaced: {
        id: '01939000-0000-7000-8000-0000000000ff',
        folio: 'AC-2026-00001',
        reversal: { id: 'v' },
        replacedBy: null,
      },
    });
    const result = await valid.create(
      actor,
      dto({ replacesAgreementId: '01939000-0000-7000-8000-0000000000ff' }),
    );
    expect(result.receipt).toMatchObject({
      replacesAgreementId: '01939000-0000-7000-8000-0000000000ff',
      replacesAgreement: { folio: 'AC-2026-00001' },
    });
    expect(
      tx.distributionAgreement.create.mock.calls[0][0].data.replacesAgreementId,
    ).toBe('01939000-0000-7000-8000-0000000000ff');
  });

  it('queues creations of one context in this process so they never overlap', async () => {
    const { service, transaction, tx } = setup();
    let running = 0;
    let peak = 0;
    transaction.mockImplementation(
      async (fn: (client: typeof tx) => unknown) => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        try {
          return await fn(tx);
        } finally {
          running--;
        }
      },
    );
    vi.useRealTimers();
    const results = await Promise.all(
      [1, 2, 3].map((n) =>
        service.create(
          actor,
          dto({ id: `01939000-0000-7000-8000-00000000000${n}` }),
        ),
      ),
    );
    expect(results.every((r) => r.created)).toBe(true);
    expect(peak).toBe(1);
  });

  it('keeps queueing after a failed creation', async () => {
    const { service, transaction } = setup();
    vi.useRealTimers();
    transaction.mockRejectedValueOnce(new ConflictException('boom'));
    await expect(service.create(actor, dto())).rejects.toBeInstanceOf(
      ConflictException,
    );
    await expect(service.create(actor, dto())).resolves.toMatchObject({
      created: true,
    });
  });

  it('retries the whole transaction and persists the FRESH simulation after a serialization failure', async () => {
    const first = simulation();
    const second = simulation();
    second.financialBase.potentiallyAvailableMinor = 1_100_000;
    const simulate = vi
      .fn<() => Promise<unknown>>()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const { service, tx, transaction, simulateInTx } = setup({ simulate });
    // The first attempt simulates, then fails on the counter statement.
    const counterQuery = tx.$queryRaw.getMockImplementation()!;
    let failed = false;
    tx.$queryRaw.mockImplementation((strings: TemplateStringsArray) => {
      if (
        !failed &&
        strings.join('?').includes('DistributionAgreementCounter')
      ) {
        failed = true;
        return Promise.reject(serializationFailure());
      }
      return counterQuery(strings);
    });
    vi.useRealTimers();
    const result = await service.create(actor, dto());
    expect(result.created).toBe(true);
    expect(failed).toBe(true);
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(simulateInTx).toHaveBeenCalledTimes(2);
    expect(tx.distributionAgreement.create).toHaveBeenCalledTimes(1);
    expect(
      tx.distributionAgreement.create.mock.calls[0][0].data
        .potentiallyAvailableMinor,
    ).toBe(1_100_000);
  });

  it('decides drift on the fresh simulation of the retry, not on the stale one', async () => {
    const current = 'sim1:' + 'e'.repeat(64);
    const simulate = vi
      .fn<() => Promise<unknown>>()
      .mockResolvedValueOnce(simulation())
      .mockResolvedValueOnce(simulation(current));
    const { service, tx, simulateInTx } = setup({ simulate });
    const original = tx.$queryRaw.getMockImplementation()!;
    let failed = false;
    tx.$queryRaw.mockImplementation((strings: TemplateStringsArray) => {
      if (
        !failed &&
        strings.join('?').includes('DistributionAgreementCounter')
      ) {
        failed = true;
        return Promise.reject(serializationFailure());
      }
      return original(strings);
    });
    vi.useRealTimers();
    await expect(service.create(actor, dto())).rejects.toMatchObject({
      response: {
        code: 'FINANCE_AGREEMENT_SIMULATION_CHANGED',
        currentSimulationFingerprint: current,
      },
    });
    expect(simulateInTx).toHaveBeenCalledTimes(2);
    expect(tx.distributionAgreement.create).not.toHaveBeenCalled();
  });
});

const service = (setupResult: ReturnType<typeof setup>) => setupResult.service;

describe('FinanceAgreementsService.reverse chronology', () => {
  const createdAt = '2026-10-09T18:00:00.000Z';
  const now = '2026-10-09T19:00:00.000Z';
  const reversalDto = (occurredAt: string) => ({
    id: DEVICE,
    reason: 'Correction',
    occurredAt,
    createdByMemberId: MEMBER,
    deviceId: DEVICE,
  });
  function reversalSetup() {
    const base = setup();
    const reversal = {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
    };
    const original = vi.fn().mockResolvedValue({
      occurredAt: new Date(createdAt),
      reversal: null,
      creationResponse: { id: ID },
    });
    Object.assign(base.tx, { distributionAgreementReversal: reversal });
    Object.assign(base.tx.distributionAgreement, {
      findFirstOrThrow: original,
    });
    return { ...base, reversal, original };
  }
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
  });
  afterEach(() => vi.useRealTimers());
  it.each(['2026-10-09T17:59:59.999Z', '2026-10-09T19:00:00.001Z'])(
    'rejects %s with structured 422 and no write',
    async (occurredAt) => {
      const { service, reversal } = reversalSetup();
      await expect(
        service.reverse(actor, ID, reversalDto(occurredAt)),
      ).rejects.toMatchObject({
        status: 422,
        response: { code: 'FINANCE_AGREEMENT_REVERSAL_TIME_INVALID' },
      });
      expect(reversal.create).not.toHaveBeenCalled();
    },
  );
  it.each([createdAt, '2026-10-09T18:30:00.000Z', now])(
    'accepts inclusive backend-clock boundary %s',
    async (occurredAt) => {
      const { service, reversal } = reversalSetup();
      const result = await service.reverse(actor, ID, reversalDto(occurredAt));
      expect(result).toMatchObject({
        created: true,
        receipt: { occurredAt, receivedAt: now },
      });
      expect(reversal.create).toHaveBeenCalledTimes(1);
    },
  );
  it('replays before time checks after the backend clock changes', async () => {
    const { service, reversal, original } = reversalSetup();
    const dto = reversalDto(now);
    const first = await service.reverse(actor, ID, dto);
    const saved = reversal.create.mock.calls[0][0].data;
    reversal.findFirst.mockResolvedValue(saved);
    vi.setSystemTime(new Date('2026-10-10T19:00:00Z'));
    expect(await service.reverse(actor, ID, dto)).toEqual({
      created: false,
      receipt: first.receipt,
    });
    vi.setSystemTime(new Date(createdAt)); // Accepted retries also survive a backend clock correction.
    expect(await service.reverse(actor, ID, dto)).toEqual({
      created: false,
      receipt: first.receipt,
    });
    expect(original).toHaveBeenCalledTimes(1);
    expect(reversal.create).toHaveBeenCalledTimes(1);
  });
});

import { vi } from 'vitest';
import type { PrismaService } from '../database/prisma.service.js';
import { FinanceDistributionService } from './finance-distribution.service.js';
import type { FinanceDistributionSimulationDto } from './finance-distribution.dto.js';
import type { FinanceOverviewService } from './finance-overview.service.js';

const A = '00000000-0000-7000-8000-00000000000a';
const B = '00000000-0000-7000-8000-00000000000b';
const C = '00000000-0000-7000-8000-00000000000c';
const base = {
  from: '2026-10-01',
  to: '2026-10-02',
  requestedAmountMinor: 600000,
  partnerShareBps: 5000,
  workShareBps: 5000,
  workBasis: 'WORK_SHIFTS' as const,
};
const dto = (patch: Partial<FinanceDistributionSimulationDto> = {}) =>
  ({ ...base, ...patch }) as FinanceDistributionSimulationDto;
const member = (id: string, role = 'socio', active = true) => ({
  id,
  name: `m-${id.slice(-1)}`,
  role,
  active,
});

function setup(
  options: {
    available?: number;
    status?: 'complete' | 'partial';
    members?: ReturnType<typeof member>[];
    shifts?: { memberId: string; count: number; minutes: number | null }[];
    unknown?: { memberId: string; count: number }[];
  } = {},
) {
  const tx = {
    workShift: {
      groupBy: vi
        .fn()
        .mockResolvedValueOnce(
          (options.shifts ?? []).map((row) => ({
            memberId: row.memberId,
            _count: { _all: row.count },
            _sum: { minutes: row.minutes },
          })),
        )
        .mockResolvedValueOnce(
          (options.unknown ?? []).map((row) => ({
            memberId: row.memberId,
            _count: { _all: row.count },
          })),
        ),
    },
    member: { findMany: vi.fn().mockResolvedValue(options.members ?? []) },
  };
  const status = options.status ?? 'complete';
  const compute = vi.fn().mockResolvedValue({
    currency: 'MXN',
    period: { from: base.from, to: base.to, interval: '[from,to)' },
    result: {
      potentiallyAvailableMinor: options.available ?? 1_000_000,
      status,
    },
    warnings:
      status === 'partial'
        ? [{ code: 'MISSING_SALE_COST', message: 'missing' }]
        : [],
  });
  const transaction = vi.fn(
    async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
  );
  const service = new FinanceDistributionService(
    { $transaction: transaction } as unknown as PrismaService,
    { compute } as unknown as FinanceOverviewService,
  );
  return { service, tx, compute, transaction };
}
const worked = {
  members: [member(A), member(B)],
  shifts: [
    { memberId: A, count: 2, minutes: null },
    { memberId: B, count: 3, minutes: null },
  ],
  unknown: [
    { memberId: A, count: 2 },
    { memberId: B, count: 3 },
  ],
};
const codes = (result: { warnings: { code: string }[] }) =>
  result.warnings.map((warning) => warning.code);

describe('FinanceDistributionService', () => {
  it('reproduces the worked example in one repeatable-read tenant transaction', async () => {
    const { service, tx, compute, transaction } = setup(worked);
    const result = await service.simulate('tenant', dto());
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'RepeatableRead',
    });
    expect(compute).toHaveBeenCalledWith(tx, 'tenant', base.from, base.to);
    expect(result.simulation).toBe(true);
    expect(result.persisted).toBe(false);
    expect(result.pools).toEqual({
      partnerPoolMinor: 300000,
      workPoolMinor: 300000,
    });
    expect(
      result.members.map((m) => [
        m.memberId,
        m.partnerAmountMinor,
        m.workAmountMinor,
        m.totalMinor,
      ]),
    ).toEqual([
      [A, 150000, 120000, 270000],
      [B, 150000, 180000, 330000],
    ]);
    expect(result.totals).toEqual({
      distributedMinor: 600000,
      undistributedMinor: 0,
    });
    expect(result.financialBase).toEqual({
      potentiallyAvailableMinor: 1_000_000,
      requestedAmountMinor: 600000,
      remainingAvailableMinor: 400000,
      status: 'complete',
    });
    expect(result.rule.partnerMode).toBe('EQUAL');
    expect(codes(result)).toEqual([
      'SIMULATION_ONLY',
      'NOT_A_PAYMENT_OR_OBLIGATION',
      'PARTNER_ELIGIBILITY_IS_CURRENT_STATE',
    ]);
  });
  it('scopes every aggregate to the caller context, active shifts and the half-open period', async () => {
    const { service, tx } = setup(worked);
    await service.simulate('tenant', dto());
    const where = {
      contextId: 'tenant',
      reversal: { is: null },
      workDate: {
        gte: new Date('2026-10-01T00:00:00Z'),
        lt: new Date('2026-10-02T00:00:00Z'),
      },
    };
    expect(tx.workShift.groupBy).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ by: ['memberId'], where }),
    );
    expect(tx.workShift.groupBy).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ where: { ...where, minutes: null } }),
    );
    expect(tx.member.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ contextId: 'tenant' }),
      }),
    );
  });
  it('rejects an invalid period before opening a transaction', async () => {
    const { service, transaction } = setup();
    await expect(
      service.simulate('tenant', dto({ from: '2026-10-02', to: '2026-10-01' })),
    ).rejects.toMatchObject({ status: 400 });
    expect(transaction).not.toHaveBeenCalled();
  });
  it.each([
    [600001, 600000],
    [1, 0],
    [1, -500],
  ])(
    'caps %s against %s available with 422 and never subtracts reserves again',
    async (requestedAmountMinor, available) => {
      const { service } = setup({ ...worked, available });
      await expect(
        service.simulate('tenant', dto({ requestedAmountMinor })),
      ).rejects.toMatchObject({
        response: { code: 'FINANCE_DISTRIBUTION_EXCEEDS_AVAILABLE' },
        status: 422,
      });
    },
  );
  it('allows requesting exactly the available amount', async () => {
    const { service } = setup({ ...worked, available: 600000 });
    const result = await service.simulate('tenant', dto());
    expect(result.financialBase.remainingAvailableMinor).toBe(0);
  });
  it('fails with NO_PARTNERS and never redistributes to workers', async () => {
    const { service } = setup({
      members: [member(A, 'colaborador'), member(B, 'socio', false)],
      shifts: [{ memberId: A, count: 1, minutes: 30 }],
    });
    await expect(service.simulate('tenant', dto())).rejects.toMatchObject({
      response: { code: 'FINANCE_DISTRIBUTION_NO_PARTNERS' },
      status: 422,
    });
  });
  it('fails with NO_WORK when no shift exists and distinguishes missing duration', async () => {
    const empty = setup({ members: [member(A)] });
    await expect(empty.service.simulate('tenant', dto())).rejects.toMatchObject(
      {
        response: {
          code: 'FINANCE_DISTRIBUTION_NO_WORK',
          message: expect.stringContaining('No active work shifts'),
        },
      },
    );
    const noDuration = setup({
      members: [member(A)],
      shifts: [{ memberId: A, count: 2, minutes: null }],
      unknown: [{ memberId: A, count: 2 }],
    });
    await expect(
      noDuration.service.simulate(
        'tenant',
        dto({ workBasis: 'KNOWN_MINUTES' }),
      ),
    ).rejects.toMatchObject({
      response: {
        code: 'FINANCE_DISTRIBUTION_NO_WORK',
        message: expect.stringContaining('lack a known duration'),
      },
    });
  });
  it('does not require partners for 0/100 or work for 100/0', async () => {
    const onlyWork = setup({
      members: [member(A, 'colaborador')],
      shifts: [{ memberId: A, count: 1, minutes: 10 }],
    });
    const zeroPartner = await onlyWork.service.simulate(
      'tenant',
      dto({ partnerShareBps: 0, workShareBps: 10000 }),
    );
    expect(zeroPartner.members).toHaveLength(1);
    expect(zeroPartner.members[0]).toMatchObject({
      partnerAmountMinor: 0,
      workAmountMinor: 600000,
      totalMinor: 600000,
    });
    expect(codes(zeroPartner)).not.toContain(
      'PARTNER_ELIGIBILITY_IS_CURRENT_STATE',
    );
    const onlyPartners = setup({ members: [member(A), member(B)] });
    const zeroWork = await onlyPartners.service.simulate(
      'tenant',
      dto({ partnerShareBps: 10000, workShareBps: 0 }),
    );
    expect(zeroWork.members.map((m) => m.totalMinor)).toEqual([300000, 300000]);
  });
  it('splits cents deterministically by member id and gives the odd cent to the work pool', async () => {
    const { service } = setup({
      members: [member(C), member(A), member(B)],
      shifts: [{ memberId: A, count: 1, minutes: null }],
      unknown: [{ memberId: A, count: 1 }],
    });
    const result = await service.simulate(
      'tenant',
      dto({
        requestedAmountMinor: 10001,
        partnerShareBps: 10000,
        workShareBps: 0,
      }),
    );
    expect(
      result.members.map((m) => [m.memberId, m.partnerAmountMinor]),
    ).toEqual([
      [A, 3334],
      [B, 3334],
      [C, 3333],
    ]);
    const odd = await setup(worked).service.simulate(
      'tenant',
      dto({ requestedAmountMinor: 101 }),
    );
    expect(odd.pools).toEqual({ partnerPoolMinor: 50, workPoolMinor: 51 });
    expect(odd.totals.distributedMinor).toBe(101);
  });
  it('counts a shift without duration as 1 for WORK_SHIFTS and 0 with a warning for KNOWN_MINUTES', async () => {
    const options = {
      members: [member(A), member(B)],
      shifts: [
        { memberId: A, count: 2, minutes: 60 },
        { memberId: B, count: 1, minutes: null },
      ],
      unknown: [
        { memberId: A, count: 1 },
        { memberId: B, count: 1 },
      ],
    };
    const shifts = await setup(options).service.simulate('tenant', dto());
    expect(shifts.members.map((m) => m.workUnits)).toEqual([2, 1]);
    expect(codes(shifts)).not.toContain('WORK_SHIFTS_WITHOUT_DURATION');
    const minutes = await setup({
      ...options,
      shifts: [
        { memberId: A, count: 2, minutes: 60 },
        { memberId: B, count: 1, minutes: null },
      ],
    }).service.simulate('tenant', dto({ workBasis: 'KNOWN_MINUTES' }));
    expect(
      minutes.members.map((m) => [m.workUnits, m.workAmountMinor]),
    ).toEqual([
      [60, 300000],
      [0, 0],
    ]);
    const warning = minutes.warnings.find(
      (w) => w.code === 'WORK_SHIFTS_WITHOUT_DURATION',
    );
    expect(warning?.message).toContain('2 work shift(s)');
  });
  it('lists workers who are not partners, flags inactive members and keeps colaboradores out of the partner share', async () => {
    const { service } = setup({
      members: [member(A), member(B, 'colaborador'), member(C, 'socio', false)],
      shifts: [
        { memberId: B, count: 1, minutes: 30 },
        { memberId: C, count: 1, minutes: 30 },
      ],
    });
    const result = await service.simulate('tenant', dto());
    expect(
      result.members.map((m) => [
        m.memberId,
        m.partnerEligible,
        m.partnerAmountMinor,
        m.workAmountMinor,
      ]),
    ).toEqual([
      [A, true, 300000, 0],
      [B, false, 0, 150000],
      [C, false, 0, 150000],
    ]);
    expect(codes(result)).toContain('INACTIVE_MEMBER_RECEIVES_WORK_AMOUNT');
  });
  it('mirrors a partial financial base with warnings but still computes', async () => {
    const { service } = setup({ ...worked, status: 'partial' });
    const result = await service.simulate('tenant', dto());
    expect(result.financialBase.status).toBe('partial');
    expect(codes(result)).toEqual([
      'SIMULATION_ONLY',
      'NOT_A_PAYMENT_OR_OBLIGATION',
      'OPERATING_RESULT_PARTIAL',
      'MISSING_SALE_COST',
      'PARTNER_ELIGIBILITY_IS_CURRENT_STATE',
    ]);
    expect(result.totals.distributedMinor).toBe(600000);
  });
  it('propagates overview failures such as overflow unchanged', async () => {
    const { service, compute } = setup(worked);
    compute.mockRejectedValue(
      Object.assign(new Error('overflow'), {
        code: 'FINANCE_OVERVIEW_OVERFLOW',
      }),
    );
    await expect(service.simulate('tenant', dto())).rejects.toMatchObject({
      code: 'FINANCE_OVERVIEW_OVERFLOW',
    });
  });
});

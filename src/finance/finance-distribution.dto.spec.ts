import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { FinanceDistributionSimulationDto } from './finance-distribution.dto.js';

const valid = {
  from: '2026-10-01',
  to: '2026-10-02',
  requestedAmountMinor: 600000,
  partnerShareBps: 5000,
  workShareBps: 5000,
  workBasis: 'WORK_SHIFTS',
};
// Mirrors the controller-level ValidationPipe options.
const errorsFor = (input: unknown) =>
  validate(plainToInstance(FinanceDistributionSimulationDto, input), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });

describe('FinanceDistributionSimulationDto', () => {
  it('accepts the worked example and both bases', async () => {
    expect(await errorsFor(valid)).toHaveLength(0);
    expect(
      await errorsFor({ ...valid, workBasis: 'KNOWN_MINUTES' }),
    ).toHaveLength(0);
  });
  it.each([
    [100, 0],
    [0, 100],
    [3333, 6667],
    [0, 10000],
    [10000, 0],
  ])('accepts shares %s/%s only when they add up to 10000', async (p, w) => {
    const errors = await errorsFor({
      ...valid,
      partnerShareBps: p,
      workShareBps: w,
    });
    expect(errors).toHaveLength(p + w === 10000 ? 0 : 1);
  });
  it.each([
    [{ partnerShareBps: 5000, workShareBps: 4999 }],
    [{ partnerShareBps: 5001, workShareBps: 5000 }],
    [{ partnerShareBps: 0, workShareBps: 0 }],
    [{ partnerShareBps: 10000, workShareBps: 10000 }],
    [{ partnerShareBps: -1, workShareBps: 10001 }],
    [{ partnerShareBps: 10001, workShareBps: -1 }],
  ])('rejects invalid shares %j', async (shares) => {
    expect(await errorsFor({ ...valid, ...shares })).not.toHaveLength(0);
  });
  it.each([
    [0],
    [-5],
    [1.5],
    ['600000'],
    [null],
    [undefined],
    [2147483648],
    [Number.NaN],
    [[600000]],
  ])('rejects requestedAmountMinor %j', async (requestedAmountMinor) => {
    expect(
      await errorsFor({ ...valid, requestedAmountMinor }),
    ).not.toHaveLength(0);
  });
  it('accepts the amount bounds 1 and 2147483647', async () => {
    for (const requestedAmountMinor of [1, 2147483647])
      expect(await errorsFor({ ...valid, requestedAmountMinor })).toHaveLength(
        0,
      );
  });
  it.each([
    ['5000', 5000],
    [5000, '5000'],
    [5000.5, 4999.5],
    [null, 10000],
  ])('rejects non-integer shares %j/%j without coercion', async (p, w) => {
    expect(
      await errorsFor({ ...valid, partnerShareBps: p, workShareBps: w }),
    ).not.toHaveLength(0);
  });
  it.each(['SHIFTS', 'work_shifts', '', null, undefined, 1])(
    'rejects workBasis %j',
    async (workBasis) => {
      expect(await errorsFor({ ...valid, workBasis })).not.toHaveLength(0);
    },
  );
  it.each([
    { from: undefined },
    { to: undefined },
    { from: '2026-02-30' },
    { to: '2026-10-01T00:00:00Z' },
    { from: '0000-01-01' },
    { from: '2026-10-02', to: '2026-10-01' },
    { from: '2026-10-01', to: '2026-10-01' },
    { from: ['2026-10-01'] },
  ])('rejects invalid or unordered period %j', async (patch) => {
    expect(await errorsFor({ ...valid, ...patch })).not.toHaveLength(0);
  });
  it('rejects unknown properties such as client supplied member ids', async () => {
    for (const extra of [
      { memberIds: ['a'] },
      { contextId: 'other' },
      { partnerMode: 'EQUAL' },
    ])
      expect(await errorsFor({ ...valid, ...extra })).not.toHaveLength(0);
  });
});

import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate, ValidationError } from 'class-validator';
import { ValidationPipe } from '@nestjs/common';
import { v7 } from 'uuid';
import { randomUUID } from 'node:crypto';
import {
  CreateDistributionAgreementDto,
  DistributionAgreementListDto,
  ReverseDistributionAgreementDto,
} from './finance-agreements.dto.js';

const fingerprint = 'sim1:' + 'a'.repeat(64);
const valid = (): Record<string, unknown> => ({
  id: v7(),
  from: '2026-10-01',
  to: '2026-10-02',
  requestedAmountMinor: 600000,
  partnerShareBps: 5000,
  workShareBps: 5000,
  workBasis: 'WORK_SHIFTS',
  title: 'Reparto octubre',
  simulationFingerprint: fingerprint,
  occurredAt: '2026-10-09T12:00:00-06:00',
  createdByMemberId: randomUUID(),
  deviceId: randomUUID(),
});
const errors = (cls: new () => object, plain: object) =>
  validate(plainToInstance(cls, plain));
const props = (list: ValidationError[]) => list.map((e) => e.property).sort();

describe('distribution agreement create contract', () => {
  it('accepts a valid body and normalizes title and note', async () => {
    const dto = plainToInstance(CreateDistributionAgreementDto, {
      ...valid(),
      title: '  Reparto octubre  ',
      note: '  hecho en junta  ',
      replacesAgreementId: v7(),
    });
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.title).toBe('Reparto octubre');
    expect(dto.note).toBe('hecho en junta');
  });

  it('accepts null or absent note and replacement, and keeps a blank note as empty text', async () => {
    for (const extra of [{}, { note: null, replacesAgreementId: null }])
      expect(
        await errors(CreateDistributionAgreementDto, { ...valid(), ...extra }),
      ).toHaveLength(0);
    const blank = plainToInstance(CreateDistributionAgreementDto, {
      ...valid(),
      note: '   ',
    });
    expect(await validate(blank)).toHaveLength(0);
    expect(blank.note).toBe('');
  });

  it.each([
    [{ title: '   ' }, 'title'],
    [{ title: 'x'.repeat(121) }, 'title'],
    [{ title: 5 }, 'title'],
    [{ note: 'x'.repeat(1001) }, 'note'],
    [{ note: 5 }, 'note'],
    [
      { simulationFingerprint: 'sim2:' + 'a'.repeat(64) },
      'simulationFingerprint',
    ],
    [
      { simulationFingerprint: 'sim1:' + 'A'.repeat(64) },
      'simulationFingerprint',
    ],
    [
      { simulationFingerprint: 'sim1:' + 'a'.repeat(63) },
      'simulationFingerprint',
    ],
    [{ simulationFingerprint: undefined }, 'simulationFingerprint'],
    [{ replacesAgreementId: randomUUID() }, 'replacesAgreementId'],
    [{ replacesAgreementId: 'nope' }, 'replacesAgreementId'],
    [{ id: randomUUID() }, 'id'],
    [{ occurredAt: '2026-10-09' }, 'occurredAt'],
    [{ occurredAt: '2026-10-09T12:00:00' }, 'occurredAt'],
    [{ createdByMemberId: 'x' }, 'createdByMemberId'],
    [{ deviceId: undefined }, 'deviceId'],
    [{ requestedAmountMinor: 0 }, 'requestedAmountMinor'],
    [{ requestedAmountMinor: 2147483648 }, 'requestedAmountMinor'],
    [{ requestedAmountMinor: '600000' }, 'requestedAmountMinor'],
    [{ requestedAmountMinor: 1.5 }, 'requestedAmountMinor'],
    [{ partnerShareBps: 4000 }, 'workShareBps'],
    [{ workShareBps: 5001 }, 'workShareBps'],
    [{ workBasis: 'HOURS' }, 'workBasis'],
    [{ from: '2026-02-30' }, 'from'],
    [{ to: '2026-10-01' }, 'from'],
    [{ to: '2026-09-30' }, 'from'],
  ])('rejects %j on %s', async (overrides, property) => {
    const list = await errors(CreateDistributionAgreementDto, {
      ...valid(),
      ...overrides,
    });
    expect(props(list)).toContain(property);
  });

  it('accepts the documented extremes', async () => {
    for (const patch of [
      { requestedAmountMinor: 1 },
      { requestedAmountMinor: 2147483647 },
      { partnerShareBps: 0, workShareBps: 10000 },
      { partnerShareBps: 10000, workShareBps: 0 },
      { title: 'x'.repeat(120), note: 'y'.repeat(1000) },
    ])
      expect(
        await errors(CreateDistributionAgreementDto, { ...valid(), ...patch }),
      ).toHaveLength(0);
  });

  it.each([
    'contextId',
    'createdByAccountId',
    'folio',
    'status',
    'members',
    'pools',
    'totals',
    'participants',
    'partnerAmountMinor',
    'currency',
  ])(
    'rejects the server-owned property %s with the strict pipe',
    async (key) => {
      const pipe = new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
        expectedType: CreateDistributionAgreementDto,
      });
      await expect(
        pipe.transform(
          { ...valid(), [key]: 'client-supplied' },
          { type: 'body', metatype: CreateDistributionAgreementDto },
        ),
      ).rejects.toMatchObject({ status: 400 });
      await expect(
        pipe.transform(valid(), {
          type: 'body',
          metatype: CreateDistributionAgreementDto,
        }),
      ).resolves.toBeInstanceOf(CreateDistributionAgreementDto);
    },
  );
});

describe('distribution agreement list contract', () => {
  it('defaults to active, 20 and accepts a paired exact period', async () => {
    const dto = plainToInstance(DistributionAgreementListDto, {
      from: '2026-10-01',
      to: '2026-10-02',
      limit: '100',
      folio: ' ac-2026-00012 ',
      status: 'voided',
    });
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.limit).toBe(100);
    expect(dto.folio).toBe('AC-2026-00012');
    expect(plainToInstance(DistributionAgreementListDto, {}).status).toBe(
      'active',
    );
    expect(plainToInstance(DistributionAgreementListDto, {}).limit).toBe(20);
  });

  it.each([
    { from: '2026-10-01' },
    { to: '2026-10-02' },
    { from: '2026-10-02', to: '2026-10-01' },
    { limit: '0' },
    { limit: '101' },
    { limit: '1e1' },
    { limit: '' },
    { status: 'reversed' },
    { status: 'all' },
    { folio: 'AC-26-1' },
    { folio: 'xx' },
  ])('rejects malformed filters %j', async (query) => {
    expect(await errors(DistributionAgreementListDto, query)).not.toHaveLength(
      0,
    );
  });
});

describe('distribution agreement reversal contract', () => {
  const reversal = () => ({
    id: v7(),
    reason: 'Captured by mistake',
    occurredAt: '2026-10-09T12:00:00Z',
    createdByMemberId: randomUUID(),
    deviceId: randomUUID(),
  });

  it('accepts and trims', async () => {
    const dto = plainToInstance(ReverseDistributionAgreementDto, {
      ...reversal(),
      reason: '  Captured by mistake  ',
    });
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.reason).toBe('Captured by mistake');
  });

  it.each([
    { reason: '   ' },
    { reason: 'x'.repeat(1001) },
    { reason: 7 },
    { id: randomUUID() },
    { occurredAt: 'yesterday' },
    { createdByMemberId: 'x' },
    { deviceId: 'x' },
  ])('rejects %j', async (overrides) => {
    expect(
      await errors(ReverseDistributionAgreementDto, {
        ...reversal(),
        ...overrides,
      }),
    ).not.toHaveLength(0);
  });
});

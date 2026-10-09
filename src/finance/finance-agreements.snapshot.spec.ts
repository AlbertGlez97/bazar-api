import {
  AGREEMENT_NOTICE,
  buildAgreementDocument,
  folioYear,
  formatFolio,
  verifyAgreementDocument,
  type AgreementDocumentInput,
} from './finance-agreements.snapshot.js';

const A = '00000000-0000-7000-8000-00000000000a';
const B = '00000000-0000-7000-8000-00000000000b';
const input = (): AgreementDocumentInput => ({
  contextId: 'tenant',
  id: '01939000-0000-7000-8000-000000000001',
  folio: 'AC-2026-00001',
  title: 'Reparto octubre',
  note: null,
  replacesAgreement: null,
  occurredAt: new Date('2026-10-09T18:00:00.000Z'),
  receivedAt: new Date('2026-10-09T18:00:01.234Z'),
  createdBy: { memberId: A, name: 'Ana', accountId: B, deviceId: A },
  simulation: {
    period: {
      from: '2026-10-01',
      to: '2026-10-02',
      fromInstant: '2026-10-01T06:00:00.000Z',
      toInstant: '2026-10-02T06:00:00.000Z',
      utcOffsetMinutes: -360,
      interval: '[from,to)',
    },
    currency: 'MXN',
    financialBase: {
      potentiallyAvailableMinor: 1_000_000,
      requestedAmountMinor: 600000,
      remainingAvailableMinor: 400000,
      status: 'complete',
    },
    rule: {
      partnerShareBps: 5000,
      workShareBps: 5000,
      workBasis: 'WORK_SHIFTS',
      partnerMode: 'EQUAL',
    },
    pools: { partnerPoolMinor: 300000, workPoolMinor: 300000 },
    members: [{ memberId: A, name: 'Ana', totalMinor: 270000 }],
    totals: { distributedMinor: 600000, undistributedMinor: 0 },
    warnings: [
      { code: 'SIMULATION_ONLY', message: 'x' },
      { code: 'NOT_A_PAYMENT_OR_OBLIGATION', message: 'y' },
      { code: 'PARTNER_ELIGIBILITY_IS_CURRENT_STATE', message: 'z' },
    ],
    simulationFingerprint: 'sim1:' + 'a'.repeat(64),
  },
});

describe('formatFolio', () => {
  it.each([
    [2026, 1, 'AC-2026-00001'],
    [2026, 99999, 'AC-2026-99999'],
    [2026, 100000, 'AC-2026-100000'],
    [2027, 12, 'AC-2027-00012'],
  ])('formats %i/%i as %s', (year, n, folio) => {
    expect(formatFolio(year, n)).toBe(folio);
  });
});

describe('folioYear', () => {
  it('uses the business-time (UTC-6) year, rolling over at local midnight', () => {
    expect(folioYear(new Date('2027-01-01T05:59:59.999Z'))).toBe(2026);
    expect(folioYear(new Date('2027-01-01T06:00:00.000Z'))).toBe(2027);
    expect(folioYear(new Date('2026-12-31T23:59:59.999Z'))).toBe(2026);
  });
});

describe('buildAgreementDocument', () => {
  it('drops the simulation-only warnings, keeps the informative ones and adds the notice', () => {
    const document = buildAgreementDocument(input());
    expect(document.warnings.map((w) => w.code)).toEqual([
      'PARTNER_ELIGIBILITY_IS_CURRENT_STATE',
    ]);
    expect(document.notice).toBe(AGREEMENT_NOTICE);
    expect(document).toMatchObject({
      algorithmVersion: 1,
      generatedFrom: 'DISTRIBUTION_SIMULATOR',
      status: 'active',
      reversal: null,
      replacedBy: null,
      occurredAt: '2026-10-09T18:00:00.000Z',
      receivedAt: '2026-10-09T18:00:01.234Z',
      participants: [{ memberId: A, name: 'Ana', totalMinor: 270000 }],
      simulationFingerprint: 'sim1:' + 'a'.repeat(64),
    });
    expect(document).not.toHaveProperty('simulation');
    expect(document).not.toHaveProperty('persisted');
  });

  it('is deterministic and self-verifying', () => {
    const first = buildAgreementDocument(input());
    expect(buildAgreementDocument(input()).snapshotFingerprint).toBe(
      first.snapshotFingerprint,
    );
    expect(first.snapshotFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyAgreementDocument(first)).toBe(true);
    // The live projection is outside the hash; content is inside it.
    expect(
      verifyAgreementDocument({ ...first, status: 'voided', replacedBy: {} }),
    ).toBe(true);
    expect(verifyAgreementDocument({ ...first, title: 'Other' })).toBe(false);
  });

  it('survives a JSONB-style key reordering of the stored document', () => {
    const document = buildAgreementDocument(input());
    const reverseKeys = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(reverseKeys)
        : value && typeof value === 'object'
          ? Object.fromEntries(
              Object.entries(value)
                .reverse()
                .map(([key, inner]) => [key, reverseKeys(inner)]),
            )
          : value;
    const reordered = reverseKeys(document) as Record<string, unknown>;
    expect(Object.keys(reordered)[0]).not.toBe(Object.keys(document)[0]);
    expect(verifyAgreementDocument(reordered)).toBe(true);
  });

  it.each([
    ['folio', (i: AgreementDocumentInput) => (i.folio = 'AC-2026-00002')],
    ['title', (i: AgreementDocumentInput) => (i.title = 'Otro')],
    ['note', (i: AgreementDocumentInput) => (i.note = '')],
    [
      'replacement',
      (i: AgreementDocumentInput) =>
        (i.replacesAgreement = { id: B, folio: 'AC-2026-00001' }),
    ],
    ['receivedAt', (i: AgreementDocumentInput) => (i.receivedAt = new Date(0))],
    [
      'creator name',
      (i: AgreementDocumentInput) => (i.createdBy.name = 'Beto'),
    ],
    [
      'simulation fingerprint',
      (i: AgreementDocumentInput) =>
        (i.simulation.simulationFingerprint = 'sim1:' + 'b'.repeat(64)),
    ],
    [
      'participants',
      (i: AgreementDocumentInput) =>
        (i.simulation.members = [{ memberId: B, name: 'Ana' }]),
    ],
  ])('changes the snapshot fingerprint when %s changes', (_label, mutate) => {
    const changed = input();
    mutate(changed);
    expect(buildAgreementDocument(changed).snapshotFingerprint).not.toBe(
      buildAgreementDocument(input()).snapshotFingerprint,
    );
  });
});

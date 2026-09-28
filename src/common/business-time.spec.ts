import {
  currentBusinessDate,
  currentWeekRange,
  parseRangeBoundary,
} from './business-time.js';

// All fixed instants below are expressed as UTC ISO strings; the
// business timezone is fixed at UTC-6 (see BUSINESS_TZ_OFFSET_MINUTES),
// so a UTC instant of e.g. 06:00:01 corresponds to local 00:00:01.
describe('currentWeekRange (domingo-sábado business week)', () => {
  it('places a Sunday 00:00:01 local instant at the start of its own week', () => {
    // 2025-11-02 is a Sunday. Local 00:00:01 == UTC 06:00:01.
    const sundayJustAfterMidnight = new Date('2025-11-02T06:00:01.000Z');
    const { from, to } = currentWeekRange(sundayJustAfterMidnight);
    // The week should start exactly at that Sunday's local midnight...
    expect(from.toISOString()).toBe('2025-11-02T06:00:00.000Z');
    // ...and end at the following Saturday's local 23:59:59.999.
    expect(to.toISOString()).toBe('2025-11-09T05:59:59.999Z');
    expect(sundayJustAfterMidnight >= from).toBe(true);
    expect(sundayJustAfterMidnight <= to).toBe(true);
  });

  it('places a Saturday 23:59:59 local instant in the week that is ending, not the next one', () => {
    // 2025-11-08 is the Saturday closing the week that started Sunday
    // 2025-11-02. Local 23:59:59.000 == UTC 2025-11-09T05:59:59.000Z.
    const saturdayJustBeforeMidnight = new Date('2025-11-09T05:59:59.000Z');
    const { from, to } = currentWeekRange(saturdayJustBeforeMidnight);
    expect(from.toISOString()).toBe('2025-11-02T06:00:00.000Z');
    expect(to.toISOString()).toBe('2025-11-09T05:59:59.999Z');
    // The very next local instant (Sunday 00:00:00) falls in the
    // following week, not this one.
    const nextSunday = currentWeekRange(new Date(to.getTime() + 1));
    expect(nextSunday.from.toISOString()).toBe('2025-11-09T06:00:00.000Z');
  });
});

// BE-13 D3: same fixed UTC-6 offset as the tests above (Local
// 2025-01-01T00:00:00 == UTC 2025-01-01T06:00:00), so both cases below are
// picked to line up exactly with parseRangeBoundary's own confirmed boundary
// rather than a fresh, unverified offset assumption.
describe('currentBusinessDate', () => {
  it('matches the UTC calendar date when the instant is well inside the local day', () => {
    // Local 2025-06-15T06:00:00 == UTC 2025-06-15T12:00:00 — both the UTC
    // and the business-timezone calendar date read "2025-06-15".
    const wellInsideLocalDay = new Date('2025-06-15T12:00:00.000Z');
    expect(currentBusinessDate(wellInsideLocalDay)).toBe('2025-06-15');
  });

  it('falls on the PREVIOUS business day when UTC midnight has not reached local midnight yet', () => {
    // UTC midnight of 2025-01-01 is still 2024-12-31T18:00:00 local (UTC-6):
    // local midnight of 2025-01-01 does not arrive until UTC 06:00:00 (the
    // exact instant parseRangeBoundary('2025-01-01', 'start') resolves to).
    // The UTC calendar date ("2025-01-01") and the business date
    // ("2024-12-31") therefore disagree.
    const utcMidnight = new Date('2025-01-01T00:00:00.000Z');
    expect(currentBusinessDate(utcMidnight)).toBe('2024-12-31');
    expect(
      parseRangeBoundary('2025-01-01', 'start').toISOString(),
    ).toBe('2025-01-01T06:00:00.000Z');
  });

  it('zero-pads month and day', () => {
    // Local 2025-03-05T00:00:00 == UTC 2025-03-05T06:00:00.
    expect(
      currentBusinessDate(new Date('2025-03-05T06:00:00.000Z')),
    ).toBe('2025-03-05');
  });
});

describe('parseRangeBoundary', () => {
  it('resolves a date-only "start" boundary to that local day\'s midnight', () => {
    // Local 2025-01-01T00:00:00 == UTC 2025-01-01T06:00:00.
    expect(parseRangeBoundary('2025-01-01', 'start').toISOString()).toBe(
      '2025-01-01T06:00:00.000Z',
    );
  });

  it('resolves a date-only "end" boundary to that local day\'s last millisecond', () => {
    // Local 2025-01-01T23:59:59.999 == UTC 2025-01-02T05:59:59.999.
    expect(parseRangeBoundary('2025-01-01', 'end').toISOString()).toBe(
      '2025-01-02T05:59:59.999Z',
    );
  });

  it('uses a full ISO-8601 instant exactly as given, without reinterpreting it', () => {
    expect(
      parseRangeBoundary('2025-01-01T10:00:00.000Z', 'start').toISOString(),
    ).toBe('2025-01-01T10:00:00.000Z');
  });

  it('rejects an unparseable value', () => {
    expect(() => parseRangeBoundary('not-a-date', 'start')).toThrow();
  });
});

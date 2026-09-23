import { currentWeekRange, parseRangeBoundary } from './business-time.js';

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

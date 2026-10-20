import { describe, expect, it } from 'vitest';
import {
  commitmentOf,
  exceedsMessage,
  formatMxn,
} from './finance-agreements.commitment.js';

describe('commitmentOf', () => {
  it('free is available minus committed', () => {
    expect(commitmentOf(1_000_000, 600_000)).toEqual({
      availableMinor: 1_000_000,
      committedMinor: 600_000,
      freeMinor: 400_000,
    });
  });

  it('free never goes below zero when more is committed than is now available', () => {
    expect(commitmentOf(500_000, 800_000).freeMinor).toBe(0);
    expect(commitmentOf(-200_000, 0).freeMinor).toBe(0);
  });

  it('nothing committed leaves everything free', () => {
    expect(commitmentOf(123, 0).freeMinor).toBe(123);
  });
});

describe('formatMxn', () => {
  it.each([
    [0, '$0.00'],
    [5, '$0.05'],
    [100, '$1.00'],
    [123_456, '$1,234.56'],
    [100_000_000, '$1,000,000.00'],
    [-200_000, '-$2,000.00'],
    [-1, '-$0.01'],
  ])('%i -> %s', (minor, text) => {
    expect(formatMxn(minor)).toBe(text);
  });
});

describe('exceedsMessage', () => {
  it('names the available, committed, free, requested and missing amounts', () => {
    expect(exceedsMessage(commitmentOf(1_000_000, 600_000), 600_000)).toBe(
      'No alcanza. Este acuerdo pide $6,000.00 y solo quedan $4,000.00 libres. Faltan $2,000.00. Hay $10,000.00 disponibles y $6,000.00 ya están comprometidos en otros acuerdos vigentes.',
    );
  });

  it('missing is exactly one cent over the free amount', () => {
    expect(exceedsMessage(commitmentOf(1_000, 0), 1_001)).toContain(
      'Faltan $0.01.',
    );
  });

  it('when nothing is free it says so', () => {
    expect(exceedsMessage(commitmentOf(1_000, 1_000), 50)).toContain(
      'quedan $0.00 libres',
    );
  });
});

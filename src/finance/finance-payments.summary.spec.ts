import { describe, expect, it } from 'vitest';
import {
  buildPaymentSummary,
  participantPaymentStatus,
} from './finance-payments.summary.js';

const line = (memberId: string, agreed: number, paid: number, rows = 0) => ({
  memberId,
  memberName: `Member ${memberId}`,
  agreedMinor: agreed,
  paidMinor: paid,
  activePaymentCount: paid > 0 ? 1 : 0,
  paymentCount: rows || (paid > 0 ? 1 : 0),
});

describe('participantPaymentStatus', () => {
  it('derives every participant status', () => {
    expect(participantPaymentStatus(1000, 0)).toBe('UNPAID');
    expect(participantPaymentStatus(1000, 1)).toBe('PARTIALLY_PAID');
    expect(participantPaymentStatus(1000, 999)).toBe('PARTIALLY_PAID');
    expect(participantPaymentStatus(1000, 1000)).toBe('PAID');
  });
  it('treats an agreed amount of zero as not due', () => {
    expect(participantPaymentStatus(0, 0)).toBe('NOT_DUE');
  });
  it('refuses an impossible overpaid state instead of hiding it', () => {
    expect(() => participantPaymentStatus(1000, 1001)).toThrow(/overpaid/i);
    expect(() => participantPaymentStatus(0, 1)).toThrow(/overpaid/i);
  });
});

describe('buildPaymentSummary', () => {
  it('is UNPAID when every due participant is unpaid', () => {
    const s = buildPaymentSummary([line('a', 600, 0), line('b', 400, 0)]);
    expect(s).toMatchObject({
      status: 'UNPAID',
      agreedMinor: 1000,
      paidMinor: 0,
      pendingMinor: 1000,
      hasPayments: false,
      paymentCount: 0,
      activePaymentCount: 0,
    });
  });
  it('is PARTIALLY_PAID when some are paid or partially paid', () => {
    const s = buildPaymentSummary([line('a', 600, 600), line('b', 400, 0)]);
    expect(s.status).toBe('PARTIALLY_PAID');
    expect(s.pendingMinor).toBe(400);
    expect(s.participants.map((p) => p.status)).toEqual(['PAID', 'UNPAID']);
  });
  it('is PAID only when every due participant is fully paid', () => {
    const s = buildPaymentSummary([line('a', 600, 600), line('b', 400, 400)]);
    expect(s).toMatchObject({ status: 'PAID', pendingMinor: 0 });
  });
  it('ignores participants with nothing agreed when deriving the status', () => {
    const s = buildPaymentSummary([line('a', 600, 600), line('z', 0, 0)]);
    expect(s.status).toBe('PAID');
    expect(s.participants[1]).toMatchObject({
      status: 'NOT_DUE',
      pendingMinor: 0,
    });
  });
  it('is NOT_DUE when nobody is due anything', () => {
    expect(buildPaymentSummary([line('z', 0, 0)]).status).toBe('NOT_DUE');
    expect(buildPaymentSummary([]).status).toBe('NOT_DUE');
  });
  it('keeps hasPayments true when every payment was reversed', () => {
    const reversed = { ...line('a', 600, 0), paymentCount: 2 };
    const s = buildPaymentSummary([reversed]);
    expect(s).toMatchObject({
      status: 'UNPAID',
      hasPayments: true,
      paymentCount: 2,
      activePaymentCount: 0,
    });
  });
  it('sums with integers beyond 32 bits without precision loss', () => {
    const s = buildPaymentSummary([
      line('a', 2_147_483_647, 0),
      line('b', 2_147_483_647, 2_147_483_647),
    ]);
    expect(s.agreedMinor).toBe(4_294_967_294);
    expect(s.pendingMinor).toBe(2_147_483_647);
  });
});

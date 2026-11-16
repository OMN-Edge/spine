import { describe, expect, it } from 'vitest';
import { suggestedRefund } from '../billing/withdrawal-share.js';

const PAID = new Date('2026-11-01T10:00:00Z');
const at = (days: number) => new Date(PAID.getTime() + days * 86_400_000);
const base = { paidMinor: 36_500, currency: 'EUR', interval: 'year' as const, paidAt: PAID };

describe('what to suggest paying back on a withdrawal', () => {
  it('is the whole payment when nothing was used since it', () => {
    expect(suggestedRefund({ ...base, asked: at(9), used: { pages: 0, questions: 0, translated: 0 } })).toMatchObject({ refundMinor: 36_500, keptMinor: 0, basis: 'unused' });
  });
  it('keeps the share of the period that has run, a day begun counting, when something was used', () => {
    // 3 days and a bit of a 365-day year: 4 days begun, a 4/365 share of 365.00.
    expect(suggestedRefund({ ...base, asked: at(3.2), used: { pages: 2, questions: 0, translated: 0 } })).toMatchObject({ keptMinor: 400, refundMinor: 36_100, basis: 'time', days: 4, periodDays: 365 });
    expect(suggestedRefund({ ...base, paidMinor: 1000, interval: 'month', asked: at(10), used: { pages: 0, questions: 1, translated: 0 } })).toMatchObject({ keptMinor: 333, refundMinor: 667, days: 10, periodDays: 30 });
  });
  it('is judged on time when the use is not known, and never keeps more than was paid', () => {
    expect(suggestedRefund({ ...base, asked: at(1), used: null })).toMatchObject({ basis: 'time', days: 1, keptMinor: 100 });
    expect(suggestedRefund({ ...base, paidMinor: 500, interval: 'month', asked: at(90), used: null })).toMatchObject({ keptMinor: 500, refundMinor: 0, days: 30 });
  });
});

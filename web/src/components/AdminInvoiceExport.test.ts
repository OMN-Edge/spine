import { describe, expect, it } from 'vitest';
import { recentMonths, recentQuarters } from './AdminInvoiceExport';

describe('the months the summary can be made for', () => {
  it('are this month and the twelve before it, newest first, across a year’s end, so the second is the month that has just ended', () => {
    const months = recentMonths(new Date('2027-01-15T10:00:00Z'));
    expect(months).toHaveLength(13);
    expect(months.slice(0, 3)).toEqual(['2027-01', '2026-12', '2026-11']);
    expect(months[12]).toBe('2026-01');
  });
});

describe('the quarters the summary can be made for', () => {
  it('are the one running and the four before it, newest first, across a year\u2019s end', () => {
    expect(recentQuarters(new Date('2027-01-15T10:00:00Z'))).toEqual(['2027-Q1', '2026-Q4', '2026-Q3', '2026-Q2', '2026-Q1']);
    expect(recentQuarters(new Date('2026-11-19T10:00:00Z'), 2)).toEqual(['2026-Q4', '2026-Q3']);
  });
});

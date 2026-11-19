import { describe, expect, it } from 'vitest';
import { recentMonths } from './AdminInvoiceExport';

describe('the months the summary can be made for', () => {
  it('are this month and the twelve before it, newest first, across a year’s end, so the second is the month that has just ended', () => {
    const months = recentMonths(new Date('2027-01-15T10:00:00Z'));
    expect(months).toHaveLength(13);
    expect(months.slice(0, 3)).toEqual(['2027-01', '2026-12', '2026-11']);
    expect(months[12]).toBe('2026-01');
  });
});

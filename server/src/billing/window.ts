import { monthsBefore } from 'spine-core/store/months.js';
import type { SubscriptionRecord } from 'spine-core/store/types.js';

/**
 * The twelve months a yearly fair-use ceiling counts over (SECURITY.md **M-45**): for an annual subscription its billing year, from the month its
 * period began to this one (the period ends a year after it began, so the year is the twelve months behind that end); for any other plan, the last
 * twelve months, this one included. Counts are kept by the month, so the window is whole months: the month a billing year began counts in full, which
 * leans to the side of the account being held to a little less, never more.
 */
export function windowMonths(sub: SubscriptionRecord | null, now: Date): string[] {
  const thisMonth = now.toISOString().slice(0, 7);
  const end = sub?.interval === 'year' && sub.current_period_end ? Date.parse(sub.current_period_end) : NaN;
  const start = Number.isFinite(end) && end > now.getTime()
    ? new Date(end).toISOString().slice(0, 7)
    : null;
  const first = start ? monthsBefore(start, 12) : monthsBefore(thisMonth, 11);
  // A billing year that began more than a year ago (a period not yet renewed in the record) is held to the last twelve months.
  const from = first < monthsBefore(thisMonth, 12) ? monthsBefore(thisMonth, 11) : first;
  const months: string[] = [];
  for (let m = from; m <= thisMonth; m = monthsBefore(m, -1)) months.push(m);
  return months;
}

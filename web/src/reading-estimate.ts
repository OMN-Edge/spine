import type { BillingView } from './api';

/** The one-off import of a yearly plan that is left, held to the account's own cap where the plan has seats. */
export function importLeft(billing: BillingView | null): number {
  const meter = billing?.enabled ? billing.ai?.import : undefined;
  if (!meter || meter.allowance === null) return 0;
  const own = meter.own_cap !== undefined ? Math.max(0, meter.own_cap - (meter.own_used ?? 0)) : Infinity;
  return Math.min(Math.max(0, meter.allowance - meter.used), own);
}

/** The extra pages, used after the month's: what is left of a top-up and an invitation's, and of the yearly plan's one-off import. */
export const extraPages = (billing: BillingView | null): number => (billing?.enabled ? billing.addons?.page_topup.pages_left ?? 0 : 0) + importLeft(billing);

/**
 * Before reading (U-10): how many pages an upload will use of the pages the account can add, so the grouping check says it before "Grouping is right" starts the reading.
 * What can be added is what the plan has left (the month's and what has carried, or the trial's total) and the extra pages; an account whose seat has a cap of its own
 * is held to that. Null where nothing limits adding (no plans, or a plan with no allowance), so the screen says nothing.
 */
export function readingEstimate(billing: BillingView | null, pages: number): { pages: number; left: number; short: number } | null {
  if (!billing?.enabled || !billing.ai || pages <= 0) return null;
  const reading = billing.ai.reading;
  if (reading.allowance === null) return null;
  const own = reading.own_cap !== undefined ? Math.max(0, reading.own_cap - (reading.own_used ?? 0)) : Infinity;
  const left = Math.min(Math.max(0, reading.allowance - reading.used), own) + extraPages(billing);
  return { pages, left, short: Math.max(0, pages - left) };
}

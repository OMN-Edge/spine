import { monthsBefore } from '../store/months.js';

/** How far back the unused pages are followed: older months are forgotten by the store, and three months' worth is all that is ever kept. */
const LOOK_BACK = 12;

/**
 * The pages that can be added in `month`: the allowance of each month since the plan began, less what was added, kept for at most `carryMonths`
 * months' worth. A month that adds nothing leaves its whole allowance for the next, up to the cap; a month that adds more than it has leaves nothing.
 * `since` is the month the plan began to count (never later than `month`), and `usedIn` what was added in a month. With `carryMonths` of one nothing
 * carries and this is the plain monthly allowance.
 */
export function carriedPages(grant: number, carryMonths: number, since: string, month: string, usedIn: (month: string) => number): number {
  const cap = grant * Math.max(1, carryMonths);
  const first = since > monthsBefore(month, LOOK_BACK) ? since : monthsBefore(month, LOOK_BACK);
  let balance = 0;
  for (let m = first; m <= month; m = monthsBefore(m, -1)) {
    balance = Math.min(cap, balance + grant);
    if (m < month) balance = Math.max(0, balance - usedIn(m));
  }
  return balance;
}

/** The months a calculation looks at, oldest first, for the server to read what each added. */
export function carriedMonths(since: string, month: string): string[] {
  const first = since > monthsBefore(month, LOOK_BACK) ? since : monthsBefore(month, LOOK_BACK);
  const out: string[] = [];
  for (let m = first; m < month; m = monthsBefore(m, -1)) out.push(m);
  return out;
}

import type { AccountsStore } from 'spine-core/store/types.js';
import { meterKey, type Entitlements } from 'spine-core/billing/plans.js';
import { carriedMonths, carriedPages } from 'spine-core/billing/carry.js';

/** The month a paid plan began to count pages for an account or a pool, kept as YYYYMM (a number, with no month in its name, so nothing forgets it). */
const SINCE = 'bank:since';
const encode = (month: string): number => Number(month.replace('-', ''));
const decode = (n: number): string => `${Math.floor(n / 100)}-${String(n % 100).padStart(2, '0')}`;

async function sinceOf(store: AccountsStore, user: string, month: string): Promise<string> {
  let n = await store.usage.aiUsed(user, SINCE);
  if (n === 0) { await store.usage.aiAdd(user, SINCE, encode(month)); n = await store.usage.aiUsed(user, SINCE); }
  // Two calls that both found none each added it: half is the month. A month in the future, or one that is no month, is this one.
  while (n > 999912) n = Math.round(n / 2);
  const since = decode(n);
  return n < 200001 || since > month || n % 100 < 1 || n % 100 > 12 ? month : since;
}

/**
 * The pages an account, or the plan's pool under the account that pays, may add by the end of this month: what carries from the months before and this
 * month's allowance (`billing/carry.ts`). On a plan that carries nothing it is the allowance. `user` is where the count is kept and `pool` says whether it is the pool's.
 */
export async function pagesAllowed(store: AccountsStore, user: string, e: Entitlements, grant: number, now: Date, pool: boolean): Promise<number> {
  if (e.carryMonths <= 1 || e.aiPeriod !== 'month') return grant;
  const month = now.toISOString().slice(0, 7);
  const since = await sinceOf(store, user, month);
  const months = carriedMonths(since, month);
  const used = new Map<string, number>();
  for (const m of months) used.set(m, await store.usage.aiUsed(user, meterKey('pages', e, new Date(`${m}-15T00:00:00Z`), pool)));
  return carriedPages(grant, e.carryMonths, since, month, m => used.get(m) ?? 0);
}

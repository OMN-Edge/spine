import { getAccountsStore } from 'spine-core/store/index.js';
import { LINK_BYTES_CEILING, LINK_VIEWS_CEILING, linkKey } from 'spine-core/billing/plans.js';
import { loadBillingConfig } from './config.js';
import { standingOf } from './seat.js';

/**
 * What the share links of an account send in a month (SECURITY.md **M-45**, **M-52**): how many times they are opened (one is one fetch of a link's
 * sealed copy) and how many bytes they and the owner's own downloads send, in one count. **Only the free plan limits them**: a link on a paid plan is
 * for whoever needs to read it, a doctor abroad included, so they are counted for the account page and refused only past a hidden ceiling no use
 * reaches (`LINK_VIEWS_CEILING`, `LINK_BYTES_CEILING`, doubled for a plan with seats), there against an abuse of a link. On a plan with seats they are
 * counted under the account that pays. Past a limit the links stay live and refuse their readers until the next month; the owner's own reads are
 * counted and never refused, because a person must always be able to reach their records. An emergency card is never counted or stopped.
 */
async function counters(userId: string, now: Date) {
  if (!loadBillingConfig().enabled) return null;
  const store = getAccountsStore();
  const standing = await standingOf(store, userId, now);
  if (!standing) return null;
  const pooled = standing.seat !== 'none';
  const holder = pooled ? standing.holder : userId;
  return { store, e: standing.entitlements, holder, views: linkKey('views', now, pooled), egress: linkKey('egress', now, pooled) };
}

/** Whether the links of this account have used up the month's views or bytes. */
export async function linksUsedUp(userId: string, now = new Date()): Promise<boolean> {
  const c = await counters(userId, now);
  if (!c) return false;
  const [views, bytes] = await Promise.all([c.store.usage.aiUsed(c.holder, c.views), c.store.usage.aiUsed(c.holder, c.egress)]);
  const pooled = c.holder !== userId || c.views.startsWith('pool:');
  const ceilingOf = (n: number) => (pooled ? n * 2 : n);
  return views >= Math.min(c.e.linkViews, ceilingOf(LINK_VIEWS_CEILING)) || bytes >= Math.min(c.e.linkBytes, ceilingOf(LINK_BYTES_CEILING));
}

/** Counts what was sent for a link: a view (the opening of a copy) and its bytes, or only bytes (a page image). */
export async function chargeLink(userId: string, bytes: number, view: boolean, now = new Date()): Promise<void> {
  const c = await counters(userId, now);
  if (!c) return;
  if (view) await c.store.usage.aiAdd(c.holder, c.views, 1);
  await c.store.usage.aiAdd(c.holder, c.egress, bytes);
}

/** Counts bytes the owner's own device read from their vault, without ever refusing them. */
export async function chargeOwnRead(userId: string, bytes: number, now = new Date()): Promise<void> {
  const c = await counters(userId, now);
  if (c) await c.store.usage.aiAdd(c.holder, c.egress, bytes);
}

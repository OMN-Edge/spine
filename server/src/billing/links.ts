import { getAccountsStore } from 'spine-core/store/index.js';
import { linkKey } from 'spine-core/billing/plans.js';
import { loadBillingConfig } from './config.js';
import { standingOf, type Standing } from './seat.js';
import { fairUseOf } from './fair-use.js';
import { windowMonths } from './window.js';

/**
 * What the share links of an account send (SECURITY.md **M-45**, **M-52**): how many times they are opened (one is one fetch of a link's sealed copy) and
 * how many bytes they and the owner's own downloads send, in one count. **Only the free plan limits them**, by the plan: one link, so many opens and bytes
 * a month. On a paid plan a link is for whoever needs to read it, a doctor abroad included, so they are counted for the account page and refused only at
 * the hidden fair-use ceilings (`billing/fair-use.ts`: opens and bytes a month, and bytes over the billing year or the last twelve months), which are
 * the operator's configuration and are never shown. On a plan with seats they are counted under the account that pays, for the household. Past a limit the
 * links stay live and refuse their readers; the owner's own reads are counted and never refused, because a person must always be able to reach their
 * records. An emergency card is never counted or stopped.
 */
async function counters(userId: string, now: Date) {
  if (!loadBillingConfig().enabled) return null;
  const store = getAccountsStore();
  const standing = await standingOf(store, userId, now);
  if (!standing) return null;
  const pooled = standing.seat !== 'none';
  const holder = pooled ? standing.holder : userId;
  return { store, standing, holder, pooled, views: linkKey('views', now, pooled), egress: linkKey('egress', now, pooled) };
}

/** The limits on what links send, as the plan sets them (the free plan's) and as the hidden ceilings do, with what has been used. */
export async function linkPosition(userId: string, now: Date, standing?: Standing) {
  const c = await counters(userId, now);
  if (!c) return null;
  const st = standing ?? c.standing;
  const fair = fairUseOf(st.entitlements.plan);
  const [views, bytes, yearBytes] = await Promise.all([
    c.store.usage.aiUsed(c.holder, c.views),
    c.store.usage.aiUsed(c.holder, c.egress),
    c.store.usage.aiUsedMany(c.holder, windowMonths(st.subscription, now).map(m => linkKey('egress', new Date(`${m}-15T00:00:00Z`), c.pooled))),
  ]);
  return {
    views, bytes, yearBytes,
    plan: { views: st.entitlements.linkViews, bytes: st.entitlements.linkBytes },
    ceiling: { views: fair.monthly.linkViews, bytes: fair.monthly.linkBytes, yearBytes: fair.yearly.linkBytes },
    pooled: c.pooled, holder: c.holder,
  };
}

/** Why the links of this account refuse their readers, if they do: the plan's own limit (the free plan's) or the hidden fair-use ceiling; null when they do not. */
export async function linksRefuse(userId: string, now = new Date()): Promise<'plan' | 'fair_use' | null> {
  const p = await linkPosition(userId, now);
  if (!p) return null;
  if (p.views >= p.plan.views || p.bytes >= p.plan.bytes) return 'plan';
  // A ceiling of nothing is none: the free plan has no hidden one, its own limit is the plan's.
  const reached = (used: number, ceiling: number) => ceiling > 0 && used >= ceiling;
  if (reached(p.views, p.ceiling.views) || reached(p.bytes, p.ceiling.bytes) || reached(p.yearBytes, p.ceiling.yearBytes)) return 'fair_use';
  return null;
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

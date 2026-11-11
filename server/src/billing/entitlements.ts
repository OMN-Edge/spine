import { getAccountsStore } from 'spine-core/store/index.js';
import type { Entitlements } from 'spine-core/billing/plans.js';
import { standingOf } from './seat.js';
import { loadBillingConfig } from './config.js';
import { vaultLimits, sharedLimits } from '../config.js';

/** What an account has now, or null when billing is off and the instance's own ceilings are all there is. */
export async function accountEntitlements(userId: string, now = new Date()): Promise<Entitlements | null> {
  if (!loadBillingConfig().enabled) return null;
  return (await standingOf(getAccountsStore(), userId, now))?.entitlements ?? null;
}

/**
 * Bytes the account's vault may hold: its plan's, never above the instance's ceiling. On a plan with seats the plan's bytes are for all its
 * accounts together, so what this account may add is what the plan has left after the others, counted as the write arrives (two accounts
 * writing at the same moment can overshoot by a write, which is bounded by the instance's ceiling for each).
 */
export async function vaultBytesFor(userId: string, now = new Date()): Promise<number> {
  const ceiling = vaultLimits().accountBytes;
  const standing = loadBillingConfig().enabled ? await standingOf(getAccountsStore(), userId, now) : null;
  const plan = standing?.entitlements.vaultBytes ?? null;
  if (plan === null) return ceiling;
  if (standing!.seat === 'none') return Math.min(plan, ceiling);
  const store = getAccountsStore();
  const [pool, own] = await Promise.all([store.family.pool(standing!.holder, now.toISOString()), store.vault.usage(userId)]);
  return Math.min(Math.max(0, plan - (pool.bytes - own.bytes)), ceiling);
}

/** Share links the account may have live at once; on a plan with seats the plan's links are for all its accounts together. */
export async function liveSharesFor(userId: string, now = new Date()): Promise<number> {
  const ceiling = sharedLimits().live;
  const standing = loadBillingConfig().enabled ? await standingOf(getAccountsStore(), userId, now) : null;
  const plan = standing?.entitlements.liveShares ?? null;
  if (plan === null) return ceiling;
  if (standing!.seat === 'none') return Math.min(plan, ceiling);
  const store = getAccountsStore();
  const [pool, own] = await Promise.all([store.family.pool(standing!.holder, now.toISOString()), store.shared.usage(userId, now.toISOString())]);
  return Math.min(Math.max(0, plan - (pool.links - own.bundles)), ceiling);
}

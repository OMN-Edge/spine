import { getAccountsStore } from 'spine-core/store/index.js';
import { entitlementsOf, type Entitlements } from 'spine-core/billing/plans.js';
import { loadBillingConfig } from './config.js';
import { vaultLimits, sharedLimits } from '../config.js';

/** What an account has now, or null when billing is off and the instance's own ceilings are all there is. */
export async function accountEntitlements(userId: string, now = new Date()): Promise<Entitlements | null> {
  if (!loadBillingConfig().enabled) return null;
  const store = getAccountsStore();
  const user = await store.users.findById(userId);
  if (!user) return null;
  return entitlementsOf(user, await store.billing.get(userId), now);
}

/** Bytes the account's vault may hold: its plan's, never above the instance's ceiling. */
export async function vaultBytesFor(userId: string): Promise<number> {
  const ceiling = vaultLimits().accountBytes;
  const e = await accountEntitlements(userId);
  return e?.vaultBytes != null ? Math.min(e.vaultBytes, ceiling) : ceiling;
}

/** Share links the account may have live at once. */
export async function liveSharesFor(userId: string): Promise<number> {
  const ceiling = sharedLimits().live;
  const e = await accountEntitlements(userId);
  return e?.liveShares != null ? Math.min(e.liveShares, ceiling) : ceiling;
}

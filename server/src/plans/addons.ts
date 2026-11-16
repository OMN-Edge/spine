import type { AccountsStore } from 'spine-core/store/types.js';
import type { PlanId } from 'spine-core/billing/plans.js';

/**
 * The one thing that is bought once and not by subscription, and what it leaves behind: **the page top-up**, 250 more pages for adding, for Essential, Premium
 * and Family. They are used once the month's allowance (and what has carried) is, and they do not run out at the end of a month. The invitation bonus
 * (`invitations.ts`) adds pages the same way. They are counted on the buyer's own account in the usage counters (numbers, never content), apart from the
 * month's, so nothing forgets them. Each purchase is applied once, whatever number of times the payment provider tells of it (`grantOnce`).
 */
export type Addon = 'page_topup';
export const TOPUP_PAGES = 250;

const TOPUP_GRANTED = 'once:topup:granted';
const TOPUP_USED = 'once:topup:used';

/** Who may buy it: the plans that add pages by the month. */
export const mayBuy = (_addon: Addon, plan: PlanId): boolean => plan === 'essential' || plan === 'premium' || plan === 'family';

/** Pages of the top-up that are left to add. */
export const topupLeft = async (store: AccountsStore, user: string): Promise<number> =>
  Math.max(0, (await store.usage.aiUsed(user, TOPUP_GRANTED)) - (await store.usage.aiUsed(user, TOPUP_USED)));
/** Pages that are not the month's and do not run out with it: a top-up's, and an invitation's. */
export const addExtraPages = (store: AccountsStore, user: string, pages: number): Promise<number> => store.usage.aiAdd(user, TOPUP_GRANTED, pages);
export const useTopup = (store: AccountsStore, user: string, pages: number): Promise<number> => store.usage.aiAdd(user, TOPUP_USED, pages);

/** Applies one purchase, once: the transaction's id is counted under the account and only the call that finds it first grants. */
export async function grantOnce(store: AccountsStore, user: string, _addon: Addon, transactionId: string): Promise<boolean> {
  // The mark and the pages are one step: a failure between them would otherwise leave a paid purchase marked as given and never given.
  return store.transaction(async tx => {
    if ((await tx.usage.aiAdd(user, `addon:${transactionId}`, 1)) !== 1) return false;
    await tx.usage.aiAdd(user, TOPUP_GRANTED, TOPUP_PAGES);
    return true;
  });
}

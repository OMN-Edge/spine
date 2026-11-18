import { subscriptionEntitles } from 'spine-core/billing/plans.js';
import type { SubscriptionRecord } from 'spine-core/store/types.js';
import type { PlanMapping } from 'spine-billing/events.js';
import type { Enabled } from '../billing/provider.js';
import type { Addon } from './addons.js';
import { getAccountsStore } from 'spine-core/store/index.js';
import { rewardInviter } from './invitations.js';
import { catalogProducts, configuredPrices } from './products.js';

/**
 * What Spine's prices are for: the plan a subscription's prices say it is (the family plan or Essential if one of its prices is there, else Premium), what a payment bought once
 * (the page top-up), and which price is the founding one. A price is known by the product it belongs to: the ones the operator named in the environment, and every version the
 * catalog has sent (`products.ts`), so a subscription on a price the catalog has since replaced is still the plan it was bought as. The billing code asks through the interface and
 * names none of this.
 */
export function spinePlans(config: Enabled, catalog: Map<string, string> = new Map()): Omit<PlanMapping, 'addonOf'> & { addonOf(priceIds: string[]): Addon | null } {
  const productOf = new Map(catalog);
  for (const f of configuredPrices(config)) if (!productOf.has(f.providerPriceId)) productOf.set(f.providerPriceId, f.productId);
  const has = (priceIds: string[], product: string) => priceIds.some(id => productOf.get(id) === product);
  return {
    planOf: priceIds => (has(priceIds, 'family') ? 'family' : has(priceIds, 'essential') ? 'essential' : 'premium'),
    addonOf: priceIds => (has(priceIds, 'page_topup') ? 'page_topup' : null),
    capped: priceIds => has(priceIds, 'founding'),
    // the row is one Spine's store gave, whose provider and plan are Spine's own names; the package types them as text
    entitles: (subscription, now) => subscriptionEntitles(subscription as SubscriptionRecord, now),
    // The first plan an invited account buys rewards whoever invited it (`invitations.ts`); asked again, there is nothing left to reward.
    bought: async userId => { await rewardInviter(getAccountsStore(), userId).catch(() => undefined); },
  };
}

/** The mapping with what the catalog knows, read now. */
export async function plansFor(config: Enabled) {
  return spinePlans(config, await catalogProducts(config));
}

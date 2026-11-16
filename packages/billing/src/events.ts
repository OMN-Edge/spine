import { log as logger, store as billingStore } from './host.js';
import type { BillingStore, SubscriptionRecord } from './store.js';
import type { ProviderEvent, ProviderId } from './provider.js';

const day = (now = new Date()) => now.toISOString().slice(0, 10);

/** How long a purchase counts before the provider's own subscription message arrives to say what was bought (it follows within seconds). */
const PLACEHOLDER_MS = 3 * 24 * 3600e3;
/** The placeholder is older than any message, so the subscription message that replaces it is never taken for a stale one. */
const BEFORE_ANY_MESSAGE = '1970-01-01T00:00:00.000Z';

export type Outcome = 'applied' | 'ignored' | 'unresolved';

type SubscriptionEvent = Extract<ProviderEvent, { kind: 'subscription' }>;

/**
 * What this file asks of the application it is in, which alone knows what a price is for: the plan a subscription's prices are, what a payment bought once, whether a price is the
 * capped one (a limited number of places, as the founding price is), and whether a subscription gives its plan now. The application passes it with each message (`plans/mapping.ts` is
 * Spine's), and nothing in this folder names a plan (S16).
 */
export interface PlanMapping {
  /** The plan the prices on a subscription say it is. */
  planOf(priceIds: string[]): string;
  /** What a completed payment bought once, from the price on it (never from what a message claims): null for a subscription's or an unknown price. */
  addonOf(priceIds: string[]): string | null;
  /** Whether one of the prices is the capped one: its place is counted once and is not given back. */
  capped(priceIds: string[]): boolean;
  /** Whether the subscription gives its plan at `now` (it has not ended, nor has its grace). */
  entitles(subscription: SubscriptionRecord, now: Date): boolean;
}

/** The account's row after a subscription message. Fields the message lacks keep what was known. */
function afterSubscription(previous: SubscriptionRecord | null, userId: string, provider: ProviderId, event: SubscriptionEvent, plans: PlanMapping, now: string): SubscriptionRecord {
  return {
    user_id: userId,
    provider,
    customer_id: event.customerId ?? previous?.customer_id ?? null,
    subscription_id: event.subscriptionId ?? previous?.subscription_id ?? null,
    interval: event.interval ?? previous?.interval ?? null,
    // Which plan is what the prices on the subscription say; a message that lists none keeps what was known.
    plan: event.priceIds.length > 0 ? plans.planOf(event.priceIds) : previous?.plan ?? 'premium',
    status: event.status ?? previous?.status ?? 'active',
    // The founding price is a price on the subscription: it ends when the subscription moves to another, or a new one is made at the usual price. A message that
    // names no price says nothing about it, and keeps what was known.
    founding: event.priceIds.length > 0 ? plans.capped(event.priceIds) : previous?.founding === true,
    current_period_end: event.periodEnd ?? previous?.current_period_end ?? null,
    cancel_scheduled: event.cancelScheduled,
    updated_at: now,
  };
}

/**
 * A founding place is taken for good the first time an account has the founding price: it is counted once, by the day and with no account in the count, so it
 * is not given back when the subscription ends or the account is deleted (the founding price is for the first 500 who ever signed up for it). The account's
 * own mark makes it once, however many messages tell of it.
 */
async function takeFoundingPlace(store: BillingStore, userId: string, record: SubscriptionRecord): Promise<void> {
  if (!record.founding) return;
  if ((await store.usage.aiAdd(userId, 'founding:counted', 1)) !== 1) return;
  await store.metrics.bump('founding_taken', day());
}

/**
 * An account that already has a plan was given a different subscription (two checkouts paid, say): the new one replaces the row, and the first may go on
 * billing with nothing to say so. It is logged and counted, so the operator can refund and cancel one; nothing here decides which.
 */
async function noteSecondSubscription(store: BillingStore, previous: SubscriptionRecord | null, provider: ProviderId, subscriptionId: string | null, plans: PlanMapping, now: string): Promise<void> {
  if (!previous || !previous.subscription_id || !subscriptionId || previous.subscription_id === subscriptionId) return;
  if (previous.provider !== provider || !plans.entitles(previous, new Date(now))) return;
  logger.warn('an account that has a plan was given a second subscription', { provider, first: previous.subscription_id, second: subscriptionId });
  await store.metrics.bump('second_subscription', day());
}

/** Applies what a provider said to the account it is about: who it is for, whether it is news, and the row it leaves. */
export async function applyProviderEvent(provider: ProviderId, event: ProviderEvent, plans: PlanMapping): Promise<Outcome> {
  // A refund changes no plan (the operator's invoices are reversed by the queue, `invoicing/queue.ts`).
  if (event.kind === 'ignored' || event.kind === 'refund') return 'ignored';
  const isSubscription = event.kind === 'subscription';

  const store = billingStore();
  // Who it is for: the id Spine put in the purchase, or the account this subscription or customer was already linked to.
  let userId = event.userId;
  if (!userId && event.subscriptionId) userId = (await store.billing.findBySubscription(event.subscriptionId))?.user_id ?? null;
  if (!userId && event.customerId) userId = (await store.billing.findByCustomer(event.customerId))?.user_id ?? null;
  if (!userId) return isSubscription ? 'unresolved' : 'ignored';
  if (!(await store.users.findById(userId))) return 'ignored'; // the account is gone

  const previous = await store.billing.get(userId);
  const at = event.at ?? new Date().toISOString();
  // A message older than what is known (they can arrive out of order) says nothing new.
  if (previous && previous.updated_at > at) return 'ignored';

  if (event.kind === 'subscription') {
    // The end of an earlier subscription, told after the account has moved to another (the operator cancelled the one that was billing for nothing), says nothing
    // about the one it has now, and must not take its plan away.
    if (previous?.subscription_id && event.subscriptionId && previous.subscription_id !== event.subscriptionId && event.status === 'canceled') return 'ignored';
    const next = afterSubscription(previous, userId, provider, event, plans, at);
    await noteSecondSubscription(store, previous, provider, event.subscriptionId, plans, at);
    await store.billing.put(next);
    await takeFoundingPlace(store, userId, next);
    return 'applied';
  }
  // A purchase completed: link the account to the provider's customer and subscription at once, with a short placeholder end that the
  // subscription message replaces, so a message that is lost cannot leave a plan with no end.
  const subscriptionId = event.subscriptionId;
  if (!subscriptionId) return 'ignored';
  const next: SubscriptionRecord = previous && previous.subscription_id === subscriptionId
    ? { ...previous, customer_id: previous.customer_id ?? event.customerId ?? null } // a renewal says nothing the subscription messages do not
    : {
        user_id: userId, provider, customer_id: event.customerId ?? null, subscription_id: subscriptionId, interval: previous?.interval ?? null, plan: plans.planOf(event.priceIds),
        status: 'active', founding: plans.capped(event.priceIds), current_period_end: new Date(Date.parse(at) + PLACEHOLDER_MS).toISOString(),
        cancel_scheduled: false, updated_at: BEFORE_ANY_MESSAGE,
      };
  await noteSecondSubscription(store, previous, provider, subscriptionId, plans, at);
  await store.billing.put(next);
  await takeFoundingPlace(store, userId, next);
  return 'applied';
}

import type { FastifyInstance } from 'fastify';
import { getAccountsStore } from 'spine-core/store/index.js';
import { requireAuth } from 'spine-core/routes/middleware.js';
import { logger } from 'spine-core/logger.js';
import { FOUNDING_LIMIT, PAGE, PRICES, entitlementsOf, subscriptionEntitles, trialEnd, usagePeriod } from 'spine-core/billing/plans.js';
import type { SubscriptionRecord } from 'spine-core/store/types.js';
import { loadBillingConfig } from '../billing/config.js';
import { applySubscriptionEvent, createCheckout, parseEvent, portalUrl, userOf, verifySignature, type PaddleEvent } from '../billing/paddle.js';
import { vaultBytesFor, liveSharesFor } from '../billing/entitlements.js';

const day = (now = new Date()) => now.toISOString().slice(0, 10);

/** How long a purchase counts before the provider's own subscription message arrives to say what was bought (it follows within seconds). */
const PLACEHOLDER_MS = 3 * 24 * 3600e3;
/** The placeholder is older than any message, so the subscription message that replaces it is never taken for a stale one. */
const BEFORE_ANY_MESSAGE = '1970-01-01T00:00:00.000Z';

type Outcome = 'applied' | 'ignored' | 'unresolved';

/**
 * Plans and payment (SECURITY.md **M-45**, `docs/billing.md`). The server holds which plan an account has, never a card: the person pays on
 * the provider's page and the provider tells this server, by a signed message, what became of it. Everything here is off when
 * `SPINE_BILLING` is: the routes answer that there are no plans.
 */
export async function billingRoutes(app: FastifyInstance) {
  // What the pricing page shows, before an account exists: the prices and how many founding places are left.
  app.get('/api/pricing', async (_req, reply) => {
    const config = loadBillingConfig();
    if (!config.enabled) return reply.header('Cache-Control', 'no-store').send({ enabled: false });
    const held = await getAccountsStore().billing.foundingHeld(new Date().toISOString());
    return reply.header('Cache-Control', 'public, max-age=60').send({ enabled: true, prices: PRICES, founding_left: Math.max(0, FOUNDING_LIMIT - held) });
  });

  // The signed-in account's plan, what it has used and what it can change.
  app.get('/api/billing', { preHandler: requireAuth }, async (req, reply) => {
    const config = loadBillingConfig();
    if (!config.enabled) return reply.header('Cache-Control', 'no-store').send({ enabled: false });
    const store = getAccountsStore();
    const user = await store.users.findById(req.userId);
    if (!user) return reply.status(401).send({ error: 'not authenticated' });
    const now = new Date();
    const sub = await store.billing.get(req.userId);
    const e = entitlementsOf(user, sub, now);
    const [aiUsed, vault, shares, vaultLimit, sharesLimit, held] = await Promise.all([
      store.usage.aiUsed(req.userId, usagePeriod(e, now)),
      store.vault.usage(req.userId),
      store.shared.usage(req.userId, now.toISOString()),
      vaultBytesFor(req.userId),
      liveSharesFor(req.userId),
      store.billing.foundingHeld(now.toISOString()),
    ]);
    return reply.header('Cache-Control', 'no-store').send({
      enabled: true,
      plan: e.plan,
      trial_ends_at: e.plan === 'trial' ? trialEnd(user.created_at) : null,
      subscription: sub && subscriptionEntitles(sub, now)
        ? { status: sub.status, interval: sub.interval, founding: sub.founding, ends_at: sub.cancel_scheduled ? sub.current_period_end : null, renews_at: sub.cancel_scheduled ? null : sub.current_period_end, provider: sub.provider }
        : null,
      can_manage: !!sub?.customer_id && sub.provider === 'paddle',
      ai: { used: Math.floor(aiUsed / PAGE), allowance: Math.floor(e.aiAllowance / PAGE), period: e.aiPeriod },
      vault: { used_bytes: vault.bytes, limit_bytes: vaultLimit },
      shares: { live: shares.bundles, limit: sharesLimit },
      features: { translation: e.translation, chat: e.chat, linking: e.linking, related: e.related, approval_mode: e.approvalMode },
      prices: PRICES,
      founding_left: Math.max(0, FOUNDING_LIMIT - held),
    });
  });

  // Starts a purchase: a transaction at the provider for the price the account is offered, and where to send the person to pay it.
  app.post<{ Body: { interval?: unknown } }>('/api/billing/checkout', { preHandler: requireAuth, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const config = loadBillingConfig();
    if (!config.enabled) return reply.status(404).send({ error: 'this instance has no plans' });
    const interval = req.body?.interval;
    if (interval !== 'month' && interval !== 'year') return reply.status(400).send({ error: 'interval must be month or year' });
    const store = getAccountsStore();
    const now = new Date();
    const sub = await store.billing.get(req.userId);
    if (subscriptionEntitles(sub, now)) return reply.status(409).send({ error: 'this account already has a plan; change it from the billing page', code: 'already_subscribed' });
    // The founding price goes to the first places on the yearly plan; it is locked for as long as the subscription runs.
    const founding = interval === 'year' && (await store.billing.foundingHeld(now.toISOString())) < FOUNDING_LIMIT;
    const price = founding ? config.prices.founding : interval === 'year' ? config.prices.year : config.prices.month;
    try {
      const url = await createCheckout(config, price, req.userId);
      await store.metrics.bump('checkout_started', day(now));
      return reply.send({ url });
    } catch (err) {
      logger.warn('a checkout could not be started', { reason: err instanceof Error ? err.message : String(err) });
      return reply.status(502).send({ error: 'the payment provider could not be reached; try again in a moment' });
    }
  });

  // The provider's page for the card, invoices, switching and cancelling. Spine holds none of that.
  app.post('/api/billing/portal', { preHandler: requireAuth, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const config = loadBillingConfig();
    if (!config.enabled) return reply.status(404).send({ error: 'this instance has no plans' });
    const sub = await getAccountsStore().billing.get(req.userId);
    if (!sub?.customer_id || sub.provider !== 'paddle') return reply.status(404).send({ error: 'there is nothing to manage' });
    try {
      return reply.send({ url: await portalUrl(config, sub.customer_id, sub.subscription_id) });
    } catch (err) {
      logger.warn('a billing portal could not be opened', { reason: err instanceof Error ? err.message : String(err) });
      return reply.status(502).send({ error: 'the payment provider could not be reached; try again in a moment' });
    }
  });

  // The provider's signed messages. Its own scope, because the signature is over the body exactly as sent, which a parsed copy is not.
  await app.register(async hooks => {
    hooks.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: 256 * 1024 }, (_req, body, done) => done(null, body));
    hooks.post<{ Body: string }>('/api/billing/webhook', { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } }, async (req, reply) => {
      const config = loadBillingConfig();
      if (!config.enabled) return reply.status(404).send({ error: 'not found' });
      const raw = typeof req.body === 'string' ? req.body : '';
      if (!verifySignature(config.webhookSecret, req.headers['paddle-signature'] as string | undefined, raw)) return reply.status(401).send({ error: 'bad signature' });
      const event = parseEvent(raw);
      if (!event) return reply.status(400).send({ error: 'not an event' });

      const store = getAccountsStore();
      const outcome = await applyEvent(event, config).catch(err => {
        logger.error('a payment event could not be applied', { type: event.event_type, reason: err instanceof Error ? err.message : String(err) });
        return 'unresolved' as Outcome;
      });
      // Not yet understood (a subscription message ahead of the purchase's): not acknowledged, so the provider sends it again.
      if (outcome === 'unresolved') return reply.status(409).send({ error: 'not applied yet' });
      // Applied twice is harmless (the state is written whole, newest event wins); what must happen once, like a count, happens on the first.
      const first = await store.billing.recordEvent(event.event_id, new Date().toISOString());
      if (first && outcome === 'applied') await store.metrics.bump('paid_event', day());
      if (first) await store.billing.pruneEvents(new Date(Date.now() - 45 * 24 * 3600e3).toISOString());
      return reply.send({ ok: true });
    });
  });
}

async function applyEvent(event: PaddleEvent, config: Extract<ReturnType<typeof loadBillingConfig>, { enabled: true }>): Promise<Outcome> {
  const type = event.event_type;
  const isSubscription = type.startsWith('subscription.');
  if (!isSubscription && type !== 'transaction.completed') return 'ignored';

  const store = getAccountsStore();
  const d = event.data;
  const subscriptionId = isSubscription ? d.id : d.subscription_id;
  // Who it is for: the id Spine put in the purchase, or the account this subscription or customer was already linked to.
  let userId = userOf(event);
  if (!userId && subscriptionId) userId = (await store.billing.findBySubscription(subscriptionId))?.user_id ?? null;
  if (!userId && d.customer_id) userId = (await store.billing.findByCustomer(d.customer_id))?.user_id ?? null;
  if (!userId) return isSubscription ? 'unresolved' : 'ignored';
  if (!(await store.users.findById(userId))) return 'ignored'; // the account is gone

  const previous = await store.billing.get(userId);
  const at = event.occurred_at && !Number.isNaN(Date.parse(event.occurred_at)) ? new Date(event.occurred_at).toISOString() : new Date().toISOString();
  // A message older than what is known (they can arrive out of order) says nothing new.
  if (previous && previous.updated_at > at) return 'ignored';

  if (isSubscription) {
    await store.billing.put(applySubscriptionEvent(previous, userId, event, config, at));
    return 'applied';
  }
  // A purchase completed: link the account to the provider's customer and subscription at once, with a short placeholder end that the
  // subscription message replaces, so a message that is lost cannot leave a plan with no end.
  if (!subscriptionId) return 'ignored';
  const next: SubscriptionRecord = previous && previous.subscription_id === subscriptionId
    ? { ...previous, customer_id: previous.customer_id ?? d.customer_id ?? null } // a renewal says nothing the subscription messages do not
    : {
        user_id: userId, provider: 'paddle', customer_id: d.customer_id ?? null, subscription_id: subscriptionId, interval: previous?.interval ?? null,
        status: 'active', founding: (d.items ?? []).some(i => i.price?.id === config.prices.founding), current_period_end: new Date(Date.parse(at) + PLACEHOLDER_MS).toISOString(),
        cancel_scheduled: false, updated_at: BEFORE_ANY_MESSAGE,
      };
  await store.billing.put(next);
  return 'applied';
}

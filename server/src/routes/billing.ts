import type { FastifyInstance } from 'fastify';
import { getAccountsStore } from 'spine-core/store/index.js';
import { requireAuth } from 'spine-core/routes/middleware.js';
import { logger } from 'spine-core/logger.js';
import { COUNTS, FOUNDING_LIMIT, linkKey, meterKey, subscriptionEntitles, trialEnd, type Count } from 'spine-core/billing/plans.js';
import type { SubscriptionRecord } from 'spine-core/store/types.js';
import { loadBillingConfig } from '../billing/config.js';
import { loadPrices } from '../billing/catalog.js';
import { addonOfItems, applySubscriptionEvent, createCheckout, parseEvent, planOfItems, portalUrl, userOf, verifySignature, type PaddleEvent } from '../billing/paddle.js';
import { vaultBytesFor, liveSharesFor } from '../billing/entitlements.js';
import { importGrant, pagesAllowed } from '../billing/carry.js';
import { TOTALS, totalKey } from '../billing/totals.js';
import { standingOf } from '../billing/seat.js';
import { inviteToken, MAX_REWARDED, BONUS_PAGES } from '../billing/invitations.js';
import { grantOnce, mayBuy, topupLeft, type Addon } from '../billing/addons.js';

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
    const held = await getAccountsStore().billing.foundingHeld();
    return reply.header('Cache-Control', 'public, max-age=60').send({ enabled: true, prices: await loadPrices(config), essential: !!config.essential, family: !!config.family, founding_left: Math.max(0, FOUNDING_LIMIT - held) });
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
    // A seat in another's plan has that plan, and its allowances are the plan's, counted in a pool under the account that pays, with each account
    // held to a cap of its own (SECURITY.md M-52).
    const standing = (await standingOf(store, req.userId, now))!;
    const e = standing.entitlements;
    const pooled = standing.seat !== 'none';
    // A count a person sees: what the plan (or the account) has used, and the allowance, or none (null) where only adding is limited and using is not.
    const finite = (n: number) => (Number.isFinite(n) ? n : null);
    const read = async (meter: Count) => {
      const own = await store.usage.aiUsed(req.userId, meterKey(meter, e, now));
      const plan = pooled ? await store.usage.aiUsed(standing.holder, meterKey(meter, e, now, true)) : own;
      // The one-off import is for a yearly plan only (`billing/carry.ts`): a monthly plan shows none.
      const grant = (n: number) => (meter === 'import' ? importGrant(n, standing.subscription?.interval ?? null) : n);
      const cap = e.memberCap ? finite(grant(e.memberCap[meter])) : null;
      // The pages carry from month to month on a paid plan: the allowance is what can be added by the end of this month, and `monthly` what each month adds.
      const carries = meter === 'pages' && e.carryMonths > 1 && e.aiPeriod === 'month';
      const allowance = carries ? await pagesAllowed(store, pooled ? standing.holder : req.userId, e, e.allowance.pages, now, pooled) : finite(grant(e.allowance[meter]));
      const ownCap = carries && e.memberCap ? await pagesAllowed(store, req.userId, e, e.memberCap.pages, now, false) : cap;
      return {
        used: plan,
        allowance,
        ...(carries ? { monthly: e.allowance.pages } : {}),
        ...(ownCap !== null ? { own_used: own, own_cap: ownCap } : {}),
      };
    };
    // What links send, and what the owner's own devices read: the plan's views and bytes of the month (billing/links.ts).
    const linkUse = async (what: 'views' | 'egress') => store.usage.aiUsed(pooled ? standing.holder : req.userId, linkKey(what, now, pooled));
    const totals = Object.fromEntries(await Promise.all(TOTALS.map(async c => [c, await store.usage.aiUsed(req.userId, totalKey(c))] as const)));
    const topup = await topupLeft(store, req.userId);
    const [meters, vault, shares, vaultLimit, sharesLimit, held, pool, linkViews, linkBytes] = await Promise.all([
      Promise.all(COUNTS.map(async m => [m, await read(m)] as const)).then(Object.fromEntries),
      store.vault.usage(req.userId),
      store.shared.usage(req.userId, now.toISOString()),
      vaultBytesFor(req.userId),
      liveSharesFor(req.userId),
      store.billing.foundingHeld(),
      pooled ? store.family.pool(standing.holder, now.toISOString()) : Promise.resolve(null),
      linkUse('views'), linkUse('egress'),
    ]);
    return reply.header('Cache-Control', 'no-store').send({
      enabled: true,
      plan: e.plan,
      seat: standing.seat,
      trial_ends_at: e.plan === 'trial' ? trialEnd(user.created_at) : null,
      subscription: sub && subscriptionEntitles(sub, now)
        ? { status: sub.status, interval: sub.interval, founding: sub.founding, ends_at: sub.cancel_scheduled ? sub.current_period_end : null, renews_at: sub.cancel_scheduled ? null : sub.current_period_end, provider: sub.provider }
        : null,
      can_manage: !!sub?.customer_id && sub.provider === 'paddle',
      // Reading is by the month (the trial's, once); chat and translation are always by the month.
      // What a person sees counted: pages read, questions asked, pages translated, and the archive import. Only adding has an allowance; using is counted.
      ai: { period: e.aiPeriod, reading: meters.pages, chat: meters.messages, translation: meters.translated, import: meters.import },
      // What this account has done in all (never the pool's): pages read for it, questions answered, pages translated.
      totals: totals,
      // Only the free plan limits them: null is no limit, only counted.
      links: { views: { used: linkViews, allowance: finite(e.linkViews) }, bytes: { used: linkBytes, allowance: finite(e.linkBytes) } },
      // On a plan with seats storage and links are the plan's, over all its accounts: what is shown is the plan's, not this account's share of it.
      vault: { used_bytes: pool ? pool.bytes : vault.bytes, limit_bytes: pooled ? Math.min(e.vaultBytes ?? vaultLimit, vaultLimit * standing.entitlements.seats) : vaultLimit },
      // Only the free plan limits how many are live; null is no limit but the instance's.
      shares: { live: pool ? pool.links : shares.bundles, limit: e.liveShares === null ? null : sharesLimit },
      // What is bought once: which of them this account may buy now (and the operator sells), and what is left of it.
      addons: {
        page_topup: { buyable: !!config.addons.pageTopup && mayBuy('page_topup', e.plan), pages_left: topup },
      },
      // The link this account can send: both sides get pages when someone makes an account with it, and it is rewarded for at most `max` of them.
      invite: { token: inviteToken(req.userId), pages: BONUS_PAGES, rewarded: Math.min(MAX_REWARDED, await store.usage.aiUsed(req.userId, 'bonus:rewarded')), max: MAX_REWARDED },
      features: { translation: e.translation, chat: e.chat, linking: e.linking, related: e.related, approval_mode: e.approvalMode, delegation: e.delegation },
      people: { limit: e.profiles },
      // What the app holds itself to, because the server cannot count into sealed records (`core/src/plan-limits.ts`).
      limits: { documents: e.documents },
      seats: { limit: e.seats },
      prices: await loadPrices(config),
      essential: !!config.essential,
      family: !!config.family,
      founding_left: Math.max(0, FOUNDING_LIMIT - held),
    });
  });

  // Starts a purchase: a transaction at the provider for the price the account is offered, and where to send the person to pay it.
  app.post<{ Body: { interval?: unknown; plan?: unknown; addon?: unknown } }>('/api/billing/checkout', { preHandler: requireAuth, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const config = loadBillingConfig();
    if (!config.enabled) return reply.status(404).send({ error: 'this instance has no plans' });
    const wanted = req.body?.addon;
    if (wanted !== undefined) {
      // The thing bought once, a top-up of pages, for the plans it is meant for; an account with a subscription needs nothing more to buy it.
      if (wanted !== 'page_topup') return reply.status(400).send({ error: 'addon must be page_topup' });
      const addon: Addon = wanted;
      const price = config.addons.pageTopup;
      if (!price) return reply.status(400).send({ error: 'this is not sold here', code: 'plan_not_offered' });
      const standing = await standingOf(getAccountsStore(), req.userId, new Date());
      if (!standing || !mayBuy(addon, standing.entitlements.plan)) return reply.status(409).send({ error: 'this is not for the account’s plan', code: 'plan_not_offered' });
      try {
        const url = await createCheckout(config, price, req.userId, addon);
        await getAccountsStore().metrics.bump(`checkout_started_${addon}`, day());
        return reply.send({ url });
      } catch (err) {
        logger.warn('a checkout could not be started', { reason: err instanceof Error ? err.message : String(err) });
        return reply.status(502).send({ error: 'the payment provider could not be reached; try again in a moment' });
      }
    }
    const interval = req.body?.interval;
    if (interval !== 'month' && interval !== 'year') return reply.status(400).send({ error: 'interval must be month or year' });
    const plan = req.body?.plan === 'family' ? 'family' : req.body?.plan === 'essential' ? 'essential' : 'premium';
    if (plan === 'family' && !config.family) return reply.status(400).send({ error: 'the family plan is not sold here', code: 'plan_not_offered' });
    if (plan === 'essential' && !config.essential) return reply.status(400).send({ error: 'the Essential plan is not sold here', code: 'plan_not_offered' });
    const store = getAccountsStore();
    const now = new Date();
    const sub = await store.billing.get(req.userId);
    if (subscriptionEntitles(sub, now)) return reply.status(409).send({ error: 'this account already has a plan; change it from the billing page', code: 'already_subscribed' });
    // The founding price goes to the first places on the yearly plan; it is locked for as long as the subscription runs.
    const founding = plan === 'premium' && interval === 'year' && (await store.billing.foundingHeld()) < FOUNDING_LIMIT;
    const price = plan === 'family' ? config.family![interval] : plan === 'essential' ? config.essential![interval] : founding ? config.prices.founding : interval === 'year' ? config.prices.year : config.prices.month;
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
      // What is bought once is not a subscription's message: it is applied once per transaction, and nothing else about the account changes.
      const addon = event.event_type === 'transaction.completed' ? addonOfItems(event.data.items, config) : null;
      if (addon) {
        const buyer = userOf(event);
        if (!buyer || !event.data.id || !(await store.users.findById(buyer))) return reply.send({ ok: true });
        const granted = await grantOnce(store, buyer, addon, event.data.id).catch(err => {
          logger.error('a purchase could not be applied', { reason: err instanceof Error ? err.message : String(err) });
          return null;
        });
        if (granted === null) return reply.status(409).send({ error: 'not applied yet' });
        if (granted) { await store.metrics.bump(`addon_${addon}`, day()); await store.metrics.bump('paid_event', day()); }
        return reply.send({ ok: true });
      }
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

/**
 * A founding place is taken for good the first time an account has the founding price: it is counted once, by the day and with no account in the count, so it
 * is not given back when the subscription ends or the account is deleted (the founding price is for the first 500 who ever signed up for it). The account's
 * own mark makes it once, however many messages tell of it.
 */
async function takeFoundingPlace(store: ReturnType<typeof getAccountsStore>, userId: string, record: SubscriptionRecord): Promise<void> {
  if (!record.founding) return;
  if ((await store.usage.aiAdd(userId, 'founding:counted', 1)) !== 1) return;
  await store.metrics.bump('founding_taken', day());
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
    const next = applySubscriptionEvent(previous, userId, event, config, at);
    await store.billing.put(next);
    await takeFoundingPlace(store, userId, next);
    return 'applied';
  }
  // A purchase completed: link the account to the provider's customer and subscription at once, with a short placeholder end that the
  // subscription message replaces, so a message that is lost cannot leave a plan with no end.
  if (!subscriptionId) return 'ignored';
  const next: SubscriptionRecord = previous && previous.subscription_id === subscriptionId
    ? { ...previous, customer_id: previous.customer_id ?? d.customer_id ?? null } // a renewal says nothing the subscription messages do not
    : {
        user_id: userId, provider: 'paddle', customer_id: d.customer_id ?? null, subscription_id: subscriptionId, interval: previous?.interval ?? null, plan: planOfItems(d.items, config),
        status: 'active', founding: (d.items ?? []).some(i => i.price?.id === config.prices.founding), current_period_end: new Date(Date.parse(at) + PLACEHOLDER_MS).toISOString(),
        cancel_scheduled: false, updated_at: BEFORE_ANY_MESSAGE,
      };
  await store.billing.put(next);
  await takeFoundingPlace(store, userId, next);
  return 'applied';
}

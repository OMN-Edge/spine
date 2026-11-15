import type { FastifyInstance } from 'fastify';
import { getAccountsStore } from 'spine-core/store/index.js';
import { requireAuth } from 'spine-core/routes/middleware.js';
import { logger } from 'spine-core/logger.js';
import { COUNTS, FOUNDING_LIMIT, linkKey, meterKey, subscriptionEntitles, trialEnd, type Count } from 'spine-core/billing/plans.js';
import { loadBillingConfig } from '../billing/config.js';
import { loadPrices } from '../billing/catalog.js';
import { billingProvider, MANAGE_ACTIONS, type Buyer, type ManageAction } from '../billing/provider.js';
import { addonOfPrices, applyProviderEvent, type Outcome } from '../billing/events.js';
import { vaultBytesFor, liveSharesFor } from '../billing/entitlements.js';
import { importGrant, pagesAllowed } from '../billing/carry.js';
import { TOTALS, totalKey } from '../billing/totals.js';
import { standingOf } from '../billing/seat.js';
import { inviteToken, MAX_REWARDED, BONUS_PAGES } from '../billing/invitations.js';
import { billingDetailsSchema } from 'spine-core/billing/billing-details.js';
import { loadInvoicingConfig } from '../billing/invoicing/config.js';
import { contextFromSettings, invoiceNewPayment, reverseRefunded } from '../billing/invoicing/queue.js';
import { alertOperator } from '../billing/invoicing/alert.js';
import { withdrawalReceivedMail } from '../billing/withdrawal-mail.js';
import { getMailer } from '../mail/index.js';
import { randomUUID } from 'node:crypto';
import { grantOnce, mayBuy, topupLeft, type Addon } from '../billing/addons.js';

const day = (now = new Date()) => now.toISOString().slice(0, 10);

/** Who is buying, for a provider that fills in its form and attaches a purchase to the customer it already has for the account. */
async function buyerOf(userId: string): Promise<Buyer | undefined> {
  const store = getAccountsStore();
  const [user, sub, held] = await Promise.all([store.users.findById(userId), store.billing.get(userId), store.billing.customerOf(userId)]);
  // The customer the account gave its billing details as, else the one a subscription already has (which holds none).
  return user ? { customerId: held ?? sub?.customer_id ?? null, email: user.email, language: user.language, hasDetails: held !== null } : undefined;
}

/** The days a buyer has to withdraw from a purchase (EU consumer law, for a digital service). */
const WITHDRAWAL_DAYS = 14;

/**
 * Whether the account may ask to withdraw from its purchase: where the operator is the seller (Stripe), with a subscription that runs, no request open already, and, where
 * the first payment's day is known (the invoices record it), within fourteen days of it. The operator decides each request; this only says whether to offer the button.
 */
async function withdrawalOf(userId: string, config: ReturnType<typeof loadBillingConfig>): Promise<{ allowed: boolean; until: string | null; requested: boolean }> {
  const store = getAccountsStore();
  const [sub, open, first] = await Promise.all([store.billing.get(userId), store.billing.openWithdrawalOf(userId), store.billing.firstPaymentAt(userId)]);
  const until = first ? new Date(Date.parse(first) + WITHDRAWAL_DAYS * 86_400_000).toISOString() : null;
  const running = config.enabled && config.provider === 'stripe' && sub?.provider === 'stripe' && !!sub.subscription_id && subscriptionEntitles(sub, new Date());
  return { allowed: !!running && !open && (until === null || Date.parse(until) > Date.now()), until, requested: !!open };
}

/** Whether a purchase here needs the billing details first: where the operator issues the invoice (`SPINE_INVOICING`), the invoice needs a buyer the provider's page does not describe. */
function needsDetails(config: ReturnType<typeof loadBillingConfig>): boolean {
  return config.enabled && loadInvoicingConfig(config).enabled;
}

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
      can_manage: !!sub?.customer_id && sub.provider === config.provider,
      // Whether a purchase asks for the billing details first (the operator issues the invoices).
      billing_details: needsDetails(config),
      // Whether to offer withdrawing from the purchase (the fourteen days), and until when.
      withdrawal: await withdrawalOf(req.userId, config),
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
      limits: { pages: e.keptPages },
      seats: { limit: e.seats },
      prices: await loadPrices(config),
      essential: !!config.essential,
      family: !!config.family,
      founding_left: Math.max(0, FOUNDING_LIMIT - held),
    });
  });

  // The billing details an invoice needs (where the operator issues invoices): read to fill the form, and kept as the provider's customer, never here.
  app.get('/api/billing/details', { preHandler: requireAuth }, async (req, reply) => {
    const config = loadBillingConfig();
    if (!config.enabled) return reply.status(404).send({ error: 'this instance has no plans' });
    if (!needsDetails(config)) return reply.send({ required: false, details: null });
    const customer = await getAccountsStore().billing.customerOf(req.userId);
    try {
      return reply.send({ required: true, details: customer ? await billingProvider(config).readBuyer(customer) : null });
    } catch (err) {
      logger.warn('billing details could not be read', { reason: err instanceof Error ? err.message : String(err) });
      return reply.status(502).send({ error: 'the payment provider could not be reached; try again in a moment' });
    }
  });

  app.put<{ Body: unknown }>('/api/billing/details', { preHandler: requireAuth, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const config = loadBillingConfig();
    if (!config.enabled || !needsDetails(config)) return reply.status(404).send({ error: 'billing details are not asked for here' });
    const parsed = billingDetailsSchema.safeParse(req.body);
    if (!parsed.success) {
      const first = parsed.error.issues[0]!;
      return reply.status(400).send({ error: first.message, field: first.path.join('.') || null });
    }
    const store = getAccountsStore();
    const user = await store.users.findById(req.userId);
    if (!user) return reply.status(404).send({ error: 'not found' });
    try {
      const customerId = await billingProvider(config).saveBuyer({ userId: req.userId, email: user.email, customerId: await store.billing.customerOf(req.userId), details: parsed.data });
      await store.billing.setCustomer(req.userId, customerId, new Date().toISOString());
      return reply.send({ ok: true });
    } catch (err) {
      logger.warn('billing details could not be saved', { reason: err instanceof Error ? err.message : String(err) });
      return reply.status(502).send({ error: 'the payment provider could not be reached; try again in a moment' });
    }
  });

  // Withdrawing from a purchase (the EU's fourteen days): the buyer asks, and is sent the confirmation of the request; the operator decides on the admin page.
  app.post('/api/billing/withdraw', { preHandler: requireAuth, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const config = loadBillingConfig();
    if (!config.enabled) return reply.status(404).send({ error: 'this instance has no plans' });
    const state = await withdrawalOf(req.userId, config);
    if (state.requested) return reply.status(409).send({ error: 'a request is open already', code: 'withdrawal_open' });
    if (!state.allowed) return reply.status(409).send({ error: 'this purchase cannot be withdrawn from here', code: 'withdrawal_not_allowed' });
    const store = getAccountsStore();
    const user = await store.users.findById(req.userId);
    if (!user) return reply.status(404).send({ error: 'not found' });
    const at = new Date().toISOString();
    if (!(await store.billing.requestWithdrawal(randomUUID(), req.userId, at))) return reply.status(409).send({ error: 'a request is open already', code: 'withdrawal_open' });
    await store.metrics.bump('withdrawal_requested', day());
    // The confirmation of the request, on a durable medium, and the operator told: neither says more than that a request was made.
    const mailer = getMailer();
    if (mailer.enabled) await mailer.send(withdrawalReceivedMail({ email: user.email, language: user.language }, at)).catch(err => logger.warn('the withdrawal confirmation could not be sent', { reason: err instanceof Error ? err.message : String(err) }));
    await alertOperator('a withdrawal request', [`Account ${req.userId} asked to withdraw from its purchase on ${at.slice(0, 10)}.`, 'Decide within 14 days: refund (and end the plan) or decline, on /admin.']);
    return reply.send({ ok: true, requested_at: at });
  });

  // The account's invoices, newest first, with a link to each PDF made when it is asked for (the service's link does not last).
  app.get('/api/billing/invoices', { preHandler: requireAuth }, async (req, reply) => {
    const config = loadBillingConfig();
    if (!config.enabled || !needsDetails(config)) return reply.send({ invoices: [] });
    const rows = await getAccountsStore().billing.invoicesOf(req.userId);
    return reply.header('Cache-Control', 'no-store').send({
      invoices: rows.filter(r => r.number && (r.state === 'done' || r.state === 'issued')).map(r => ({ ref: r.ref, number: r.series ? `${r.series}-${r.number}` : r.number, at: r.created_at, credit_note: r.ref.startsWith('storno:') })),
    });
  });
  app.post<{ Body: { ref?: unknown } }>('/api/billing/invoices/pdf', { preHandler: requireAuth, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const ref = req.body?.ref;
    if (typeof ref !== 'string' || ref.length === 0 || ref.length > 200) return reply.status(400).send({ error: 'ref is needed' });
    const row = await getAccountsStore().billing.invoice(ref);
    // Only the account's own: a reference of another's is the same as none.
    if (!row || row.user_id !== req.userId || !row.issuer_ref) return reply.status(404).send({ error: 'not found' });
    try {
      const ctx = contextFromSettings();
      if (!ctx) return reply.status(404).send({ error: 'not found' });
      return reply.send({ url: await ctx.issuer.pdfUrl({ id: row.issuer_ref }) });
    } catch (err) {
      logger.warn('an invoice PDF could not be fetched', { reason: err instanceof Error ? err.message : String(err) });
      return reply.status(502).send({ error: 'the invoice could not be fetched; try again in a moment' });
    }
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
      const buyer = await buyerOf(req.userId);
      if (needsDetails(config) && !buyer?.hasDetails) return reply.status(409).send({ error: 'the billing details are needed first', code: 'billing_details_required' });
      try {
        const url = await billingProvider(config).createCheckout(price, req.userId, addon, buyer);
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
    const buyer = await buyerOf(req.userId);
    if (needsDetails(config) && !buyer?.hasDetails) return reply.status(409).send({ error: 'the billing details are needed first', code: 'billing_details_required' });
    try {
      const url = await billingProvider(config).createCheckout(price, req.userId, undefined, buyer);
      await store.metrics.bump('checkout_started', day(now));
      return reply.send({ url });
    } catch (err) {
      logger.warn('a checkout could not be started', { reason: err instanceof Error ? err.message : String(err) });
      return reply.status(502).send({ error: 'the payment provider could not be reached; try again in a moment' });
    }
  });

  // The provider's page for the card, invoices, switching and cancelling, opened where the person asked: the overview, or straight to cancelling or to the card. Spine holds none of that.
  app.post<{ Body: { action?: unknown } | null }>('/api/billing/portal', { preHandler: requireAuth, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const config = loadBillingConfig();
    if (!config.enabled) return reply.status(404).send({ error: 'this instance has no plans' });
    const action = req.body?.action ?? 'overview';
    if (typeof action !== 'string' || !MANAGE_ACTIONS.includes(action as ManageAction)) return reply.status(400).send({ error: 'action must be overview, cancel or payment_method' });
    const sub = await getAccountsStore().billing.get(req.userId);
    if (!sub?.customer_id || sub.provider !== config.provider) return reply.status(404).send({ error: 'there is nothing to manage' });
    try {
      return reply.send({ url: await billingProvider(config).manageUrl(sub.customer_id, sub.subscription_id, action as ManageAction) });
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
      const provider = billingProvider(config);
      const read = await provider.readWebhook(req.headers, raw);
      if (!read.ok) return reply.status(read.status).send({ error: read.error });
      const event = read.event;

      const store = getAccountsStore();
      // A payment the operator invoices (the provider is not the seller): queued by the provider's reference for it, however the event goes on, and tried at once.
      if (event.kind === 'payment' && event.saleRef) {
        const payer = event.userId ?? (event.subscriptionId ? (await store.billing.findBySubscription(event.subscriptionId))?.user_id ?? null : null);
        await invoiceNewPayment(event.saleRef, payer);
      }
      // A refund reverses the invoice made for the payment; it changes no plan.
      if (event.kind === 'refund') {
        await reverseRefunded(event.saleRefs, event.full, event.id);
        await store.billing.recordEvent(event.id, new Date().toISOString());
        return reply.send({ ok: true });
      }
      // What is bought once is not a subscription's message: it is applied once per transaction, and nothing else about the account changes.
      const addon = event.kind === 'payment' ? addonOfPrices(event.priceIds, config) : null;
      if (addon && event.kind === 'payment') {
        const buyer = event.userId;
        if (!buyer || !event.transactionId || !(await store.users.findById(buyer))) return reply.send({ ok: true });
        const granted = await grantOnce(store, buyer, addon, event.transactionId).catch(err => {
          logger.error('a purchase could not be applied', { reason: err instanceof Error ? err.message : String(err) });
          return null;
        });
        if (granted === null) return reply.status(409).send({ error: 'not applied yet' });
        if (granted) { await store.metrics.bump(`addon_${addon}`, day()); await store.metrics.bump('paid_event', day()); }
        return reply.send({ ok: true });
      }
      const outcome = await applyProviderEvent(provider.id, event, config).catch(err => {
        logger.error('a payment event could not be applied', { type: event.kind, reason: err instanceof Error ? err.message : String(err) });
        return 'unresolved' as Outcome;
      });
      // Not yet understood (a subscription message ahead of the purchase's): not acknowledged, so the provider sends it again.
      if (outcome === 'unresolved') return reply.status(409).send({ error: 'not applied yet' });
      // Applied twice is harmless (the state is written whole, newest event wins); what must happen once, like a count, happens on the first.
      const first = await store.billing.recordEvent(event.id, new Date().toISOString());
      if (first && outcome === 'applied') await store.metrics.bump('paid_event', day());
      if (first) await store.billing.pruneEvents(new Date(Date.now() - 45 * 24 * 3600e3).toISOString());
      return reply.send({ ok: true });
    });
  });
}

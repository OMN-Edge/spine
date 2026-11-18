import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { getAccountsStore } from 'spine-core/store/index.js';
import { CHAT_MESSAGE, PAGE, PLANS, TRANSLATED_PAGE, TRIAL_MONTHS } from 'spine-core/billing/plans.js';
import { fairUseOf } from '../plans/fair-use.js';
import { buildTestApp, loginAs, loginSession } from './helpers/app.js';
import { createTestUser, OWNER_ID, TEST_PASSWORD } from './helpers/seed.js';
import { billingOn, loadBillingConfig } from '../billing/config.js';
import { createRelayGate } from '../plans/gate.js';
import { accountEntitlements, liveSharesFor, vaultBytesFor } from '../plans/entitlements.js';
import { loadPrices, resetCatalog } from '../billing/catalog.js';
import { topupLeft } from '../plans/addons.js';
import { REWARD_PAGES } from '../plans/invitations.js';
import { loadConfig } from '../config.js';
import { fakeAuthValue, fakeVaultKeys } from 'spine-core/testing/vault.js';
import { logger } from 'spine-core/logger.js';

const SECRET = 'whsec_test_secret_for_the_webhook';
// Built from parts: a Stripe-shaped key written out is what a secret scanner exists to find, and this one is made up (the adapter reads the mode from the prefix, so it must have one).
const KEY = ['sk', 'test', 'billing'].join('_');
const BILLING = {
  SPINE_BILLING: 'on', STRIPE_SECRET_KEY: KEY, STRIPE_WEBHOOK_SECRET: SECRET,
  SPINE_STRIPE_PRICE_YEAR: 'pri_year', SPINE_STRIPE_PRICE_MONTH: 'pri_month', SPINE_STRIPE_PRICE_FOUNDING: 'pri_founding',
};
const LONG_AGO = '2020-01-01T00:00:00.000Z';
/** What Stripe says about each price (in the lowest unit); the tests write no price into the code under test, so these are all there is. */
const CATALOG: Record<string, { amount: string; interval: 'year' | 'month' | null; currency?: string }> = {
  pri_year: { amount: '4900', interval: 'year' }, pri_month: { amount: '499', interval: 'month' }, pri_founding: { amount: '3900', interval: 'year' },
  pri_essential_year: { amount: '2490', interval: 'year' }, pri_essential_month: { amount: '249', interval: 'month' },
  pri_family_year: { amount: '8900', interval: 'year' }, pri_family_month: { amount: '899', interval: 'month' },
  pri_topup: { amount: '1999', interval: null },
};
/** One request to Stripe's API, as the adapter makes it. */
interface StripeCall { url: string; method: string; form: URLSearchParams }
/** The line items of each checkout session the tests complete: Stripe's message does not carry them, so the adapter asks for them. */
const lineItems = new Map<string, string[]>();
const reply = (json: unknown, status = 200) => new Response(JSON.stringify(json), { status });
/**
 * Stripe's API as far as the app asks it: a price from `catalog`, a session's line items, a checkout session and a portal session. `answer` may take a request first; every
 * request is recorded in `calls`.
 */
const stripe = (catalog = CATALOG, answer?: (call: StripeCall) => { status?: number; json: unknown } | undefined) => {
  const calls: StripeCall[] = [];
  const mock = vi.fn(async (url: string, init: { method?: string; body?: string } = {}) => {
    const call = { url: String(url), method: init.method ?? 'GET', form: new URLSearchParams(init.body ?? '') };
    calls.push(call);
    const given = answer?.(call);
    if (given) return reply(given.json, given.status);
    const path = new URL(call.url).pathname;
    const price = /^\/v1\/prices\/(.+)$/.exec(path);
    if (price) {
      const p = catalog[decodeURIComponent(price[1]!)];
      return p ? reply({ id: price[1], active: true, unit_amount: Number(p.amount), currency: (p.currency ?? 'EUR').toLowerCase(), recurring: p.interval ? { interval: p.interval } : null }) : reply({ error: { code: 'resource_missing' } }, 404);
    }
    const items = /^\/v1\/checkout\/sessions\/(.+)\/line_items$/.exec(path);
    if (items) return reply({ data: (lineItems.get(decodeURIComponent(items[1]!)) ?? []).map(id => ({ price: { id } })) });
    if (path === '/v1/checkout/sessions') return reply({ url: 'https://checkout.stripe.com/c/pay/cs_test_1' });
    if (path === '/v1/billing_portal/sessions') return reply({ url: 'https://billing.stripe.com/p/session/test_1' });
    return reply({ error: { code: 'resource_missing' } }, 404);
  });
  vi.stubGlobal('fetch', mock);
  return { calls, mock, checkouts: () => calls.filter(c => c.method === 'POST' && c.url.endsWith('/v1/checkout/sessions')).map(c => c.form) };
};

const unix = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const sign = (body: string, ts = Math.floor(Date.now() / 1000), secret = SECRET) => `t=${ts},v1=${createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}`;
const EVENT_TYPES: Record<string, string> = { 'subscription.created': 'customer.subscription.created', 'subscription.updated': 'customer.subscription.updated', 'subscription.canceled': 'customer.subscription.deleted' };
/**
 * A message as Stripe sends it. The tests describe a subscription or a purchase in plain terms (`subscription()`, a `transaction.completed` with its price): this puts them in
 * Stripe's shape, the subscription's end on its items and the purchase as a completed checkout session.
 */
const eventBody = (type: string, data: Record<string, any>, extra: Record<string, unknown> = {}) => {
  const base = { id: `evt_${Math.random().toString(36).slice(2)}`, object: 'event', created: unix(String(extra.occurred_at ?? new Date().toISOString())) };
  if (type === 'transaction.completed') {
    lineItems.set(data.id, (data.items ?? []).map((i: { price: { id: string } }) => i.price.id));
    const object = { id: data.id, mode: data.subscription_id ? 'subscription' : 'payment', payment_status: 'paid', client_reference_id: data.custom_data?.user_id ?? null, customer: data.customer_id ?? null, subscription: data.subscription_id ?? null };
    return JSON.stringify({ ...base, type: 'checkout.session.completed', data: { object } });
  }
  if (!EVENT_TYPES[type]) return JSON.stringify({ ...base, type, data: { object: data } });
  const end = data.current_billing_period?.ends_at;
  const object = {
    id: data.id, status: data.status, customer: data.customer_id, metadata: data.custom_data?.user_id ? { user_id: data.custom_data.user_id } : {},
    cancel_at_period_end: data.scheduled_change?.action === 'cancel',
    items: { data: (data.items ?? []).map((i: { price: { id: string } }) => ({ price: { id: i.price.id, recurring: { interval: data.billing_cycle?.interval ?? 'year' } }, ...(end ? { current_period_end: unix(end) } : {}) })) },
  };
  return JSON.stringify({ ...base, type: EVENT_TYPES[type], data: { object } });
};
/** A subscription as the tests mean it (a user, a price, an interval, where it ends); `eventBody` makes the message of it. */
const subscription = (user: string | null, extra: Record<string, unknown> = {}) => ({
  id: 'sub_1', customer_id: 'ctm_1', status: 'active', custom_data: user ? { user_id: user } : null, items: [{ price: { id: 'pri_year' } }],
  billing_cycle: { interval: 'year' }, current_billing_period: { ends_at: new Date(Date.now() + 300 * 24 * 3600e3).toISOString() }, ...extra,
});

describe('plans and payment', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  let cookie: string;
  const saved = { ...process.env };
  const on = () => Object.assign(process.env, BILLING);

  beforeAll(async () => {
    app = await buildTestApp();
    cookie = await loginSession(app);
  });
  afterEach(() => { process.env = { ...saved }; vi.unstubAllGlobals(); resetCatalog(); });

  const get = (url: string, headers: Record<string, string> = { cookie }) => app.inject({ method: 'GET', url, headers });
  const hook = (body: string, signature = sign(body)) => app.inject({ method: 'POST', url: '/api/billing/webhook', headers: { 'content-type': 'application/json', 'stripe-signature': signature }, payload: body });

  describe('settings', () => {
    it('are not all needed by the relay, which applies the plans and never talks to the payment provider', () => {
      expect(billingOn({})).toBe(false);
      expect(billingOn({ SPINE_BILLING: 'on' })).toBe(true);
      expect(billingOn({ SPINE_BILLING: 'ON' })).toBe(true);
      expect(billingOn({ SPINE_BILLING: 'yes' })).toBe(false);
    });

    it('are off unless said, and then say what is missing', () => {
      expect(loadBillingConfig({})).toEqual({ enabled: false });
      expect(() => loadBillingConfig({ SPINE_BILLING: 'on' })).toThrow(/STRIPE_SECRET_KEY/);
      expect(() => loadBillingConfig({ ...BILLING, STRIPE_SECRET_KEY: 'not-a-key' })).toThrow(/STRIPE_SECRET_KEY must be/);
      expect(loadBillingConfig(BILLING)).toMatchObject({ enabled: true, environment: 'sandbox', prices: { founding: 'pri_founding' } });
    });

    it('do not go with a private instance, which has no plans to buy', () => {
      const base = { SESSION_SECRET: 'x'.repeat(40), ...BILLING };
      expect(() => loadConfig({ ...base, SPINE_INSTANCE: 'private' })).toThrow(/does not go with SPINE_INSTANCE=private/);
      expect(loadConfig(base).billing.enabled).toBe(true);
    });
  });

  describe('the account’s view', () => {
    it('says there are no plans when billing is off, and limits nothing', async () => {
      expect((await get('/api/billing')).json()).toEqual({ enabled: false });
      expect((await get('/api/pricing', {})).json()).toEqual({ enabled: false });
      expect(await accountEntitlements(OWNER_ID)).toBeNull();
      expect((await app.inject({ method: 'POST', url: '/api/billing/checkout', headers: { cookie }, payload: { interval: 'year' } })).statusCode).toBe(404);
    });

    it('is for the signed-in only, and starts a new account on the trial', async () => {
      on();
      stripe();
      expect((await get('/api/billing', {})).statusCode).toBe(401);
      const body = (await get('/api/billing')).json();
      expect(body).toMatchObject({ enabled: true, plan: 'trial', subscription: null, can_manage: false, ai: { period: 'trial', reading: { used: 0, allowance: 100 }, chat: { used: 0, allowance: 50 }, translation: { used: 0, allowance: 30 } }, links: { views: { used: 0, allowance: null }, bytes: { used: 0, allowance: null } }, founding_left: 500 });
      expect(body.trial_ends_at).toBeTruthy();
      stripe();
      expect((await get('/api/pricing', {})).json()).toMatchObject({ enabled: true, founding_left: 500, essential: false, prices: { currency: 'EUR', premium: { year: 49, month: 4.99 }, founding: { year: 39 } } });
    });

    it('says the operator sells, under the name the footer shows', async () => {
      on();
      stripe();
      expect((await get('/api/pricing', {})).json()).toMatchObject({ seller: 'operator' });
      expect((await get('/api/pricing', {})).json().seller_name ?? null).toBeNull();
      process.env = { ...process.env, SPINE_OPERATOR_NAME: 'Exemplu Software SRL' };
      resetCatalog();
      stripe();
      expect((await get('/api/pricing', {})).json()).toMatchObject({ enabled: true, seller: 'operator', seller_name: 'Exemplu Software SRL' });
    });

    it('shows no price at all when Stripe cannot say what it is, and never a price of its own', async () => {
      on();
      vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
      const body = (await get('/api/pricing', {})).json();
      expect(body).toMatchObject({ enabled: true, prices: null });
      expect(JSON.stringify(body)).not.toMatch(/\d+\.\d\d/);
      expect(await loadPrices(loadBillingConfig(BILLING) as Extract<ReturnType<typeof loadBillingConfig>, { enabled: true }>)).toBeNull();
    });

    it('puts an account past its trial on the free plan, with the free plan’s limits', async () => {
      on();
      const old = await createTestUser('old@spine.test', { createdAt: LONG_AGO });
      expect(await accountEntitlements(old.id)).toMatchObject({ plan: 'free', translation: false, chat: false, approvalMode: false });
      expect(await vaultBytesFor(old.id)).toBe(1024 ** 3);
      expect(await liveSharesFor(old.id)).toBe(1);
      expect(await vaultBytesFor(OWNER_ID)).toBeGreaterThan(1024 ** 3);
      const cookieOld = await loginAs(app, old.email, old.password);
      expect((await get('/api/billing', { cookie: cookieOld })).json()).toMatchObject({ plan: 'free', ai: { period: 'month', reading: { allowance: 3, monthly: 3 }, chat: { allowance: 0 }, translation: { allowance: 0 } }, shares: { limit: 1 }, features: { translation: false } });
    });
  });

  describe('the payment provider’s messages', () => {
    it('are refused unless signed with the secret, in time, over the exact body', async () => {
      on();
      const body = eventBody('subscription.created', subscription(OWNER_ID));
      expect((await hook(body, 't=1,v1=00')).statusCode).toBe(401);
      expect((await hook(body, sign(body, Math.floor(Date.now() / 1000), 'another secret'))).statusCode).toBe(401);
      expect((await hook(body, sign(body, Math.floor(Date.now() / 1000) - 3600))).statusCode).toBe(401);
      expect((await hook(`${body} `, sign(body))).statusCode).toBe(401);
      expect((await app.inject({ method: 'POST', url: '/api/billing/webhook', payload: {} })).statusCode).toBe(401);
      expect(await getAccountsStore().billing.get(OWNER_ID)).toBeNull();
    });

    it('reward whoever invited an account the first time it has a plan, once, and not for a payment that is only a top-up', async () => {
      on();
      const inviter = await createTestUser('reward-inviter@spine.test', { createdAt: LONG_AGO });
      const buyer = await createTestUser('reward-buyer@spine.test', { createdAt: LONG_AGO });
      await getAccountsStore().invitations.record(buyer.id, inviter.id, new Date().toISOString());
      expect(await topupLeft(getAccountsStore(), inviter.id)).toBe(0);
      await hook(eventBody('subscription.created', subscription(buyer.id, { id: 'sub_reward' })));
      expect(await topupLeft(getAccountsStore(), inviter.id)).toBe(REWARD_PAGES);
      // Told again, or renewed, there is nothing left to reward.
      await hook(eventBody('subscription.updated', subscription(buyer.id, { id: 'sub_reward' })));
      expect(await topupLeft(getAccountsStore(), inviter.id)).toBe(REWARD_PAGES);
    });

    it('give the account the paid plan, and take the trial’s clock out of it', async () => {
      on();
      const user = await createTestUser('payer@spine.test', { createdAt: LONG_AGO });
      const res = await hook(eventBody('subscription.created', subscription(user.id, { id: 'sub_payer', items: [{ price: { id: 'pri_founding' } }] })));
      expect(res.statusCode).toBe(200);
      expect(await getAccountsStore().billing.get(user.id)).toMatchObject({ provider: 'stripe', customer_id: 'ctm_1', subscription_id: 'sub_payer', interval: 'year', founding: true, cancel_scheduled: false });
      expect(await accountEntitlements(user.id)).toMatchObject({ plan: 'premium', translation: true });
      const cookiePayer = await loginAs(app, user.email, user.password);
      expect((await get('/api/billing', { cookie: cookiePayer })).json()).toMatchObject({ plan: 'premium', can_manage: true, subscription: { interval: 'year', founding: true }, founding_left: 499 });
    });

    it('end the plan at once when the subscription is cancelled at once, and keep it to the date when the end is only set for one', async () => {
      on();
      const planned = await createTestUser('planned@spine.test', { createdAt: LONG_AGO });
      await hook(eventBody('subscription.created', subscription(planned.id, { id: 'sub_planned' })));
      await hook(eventBody('subscription.updated', subscription(null, { id: 'sub_planned', scheduled_change: { action: 'cancel' } })));
      expect(await accountEntitlements(planned.id)).toMatchObject({ plan: 'premium' });

      const withdrawn = await createTestUser('withdrawn@spine.test', { createdAt: LONG_AGO });
      await hook(eventBody('subscription.created', subscription(withdrawn.id, { id: 'sub_withdrawn' })));
      expect(await accountEntitlements(withdrawn.id)).toMatchObject({ plan: 'premium' });
      // Cancelled at once (a withdrawal): Stripe's message names the status and no period; the end the account had does not buy more days.
      await hook(eventBody('subscription.canceled', subscription(null, { id: 'sub_withdrawn', status: 'canceled', current_billing_period: null, scheduled_change: null })));
      expect(await getAccountsStore().billing.get(withdrawn.id)).toMatchObject({ status: 'canceled' });
      expect(await accountEntitlements(withdrawn.id)).toMatchObject({ plan: 'free' });
      expect((await get('/api/billing', { cookie: await loginAs(app, withdrawn.email, withdrawn.password) })).json()).toMatchObject({ plan: 'free', subscription: null });
    });

    it('do not let the end of an earlier subscription take the plan of the one the account has now', async () => {
      on();
      const user = await createTestUser('moved@spine.test', { createdAt: LONG_AGO });
      await hook(eventBody('subscription.created', subscription(user.id, { id: 'sub_old' })));
      await hook(eventBody('subscription.created', subscription(user.id, { id: 'sub_new' })));
      expect(await getAccountsStore().billing.get(user.id)).toMatchObject({ subscription_id: 'sub_new' });
      // The operator cancels the one that was billing for nothing; its message names the account, but the account has moved on.
      const res = await hook(eventBody('subscription.canceled', subscription(user.id, { id: 'sub_old', status: 'canceled', current_billing_period: null })));
      expect(res.statusCode).toBe(200);
      expect(await getAccountsStore().billing.get(user.id)).toMatchObject({ subscription_id: 'sub_new', status: 'active' });
      expect(await accountEntitlements(user.id)).toMatchObject({ plan: 'premium' });
      // The current subscription's own cancellation does end it.
      await hook(eventBody('subscription.canceled', subscription(user.id, { id: 'sub_new', status: 'canceled', current_billing_period: null })));
      expect(await accountEntitlements(user.id)).toMatchObject({ plan: 'free' });
    });

    it('stop being founding when the subscription moves to another price or a new one is made at the usual price, and keep it when a message names no price', async () => {
      on();
      const user = await createTestUser('founder@spine.test', { createdAt: LONG_AGO });
      await hook(eventBody('subscription.created', subscription(user.id, { id: 'sub_f', items: [{ price: { id: 'pri_founding' } }] })));
      expect((await getAccountsStore().billing.get(user.id))!.founding).toBe(true);
      // A message about the same subscription that lists no price says nothing about it.
      await hook(eventBody('subscription.updated', subscription(null, { id: 'sub_f', items: [] })));
      expect((await getAccountsStore().billing.get(user.id))!.founding).toBe(true);
      // The subscription moves to the usual monthly price: it is not the founding price any more.
      await hook(eventBody('subscription.updated', subscription(null, { id: 'sub_f', items: [{ price: { id: 'pri_month' } }], billing_cycle: { interval: 'month' } })));
      expect(await getAccountsStore().billing.get(user.id)).toMatchObject({ founding: false, interval: 'month' });
      expect((await get('/api/billing', { cookie: await loginAs(app, user.email, user.password) })).json().subscription).toMatchObject({ founding: false });
    });

    it('notes an account that has a plan being given a second subscription, once, and still applies it', async () => {
      on();
      const warn = vi.spyOn(logger, 'warn');
      const user = await createTestUser('doublebilled@spine.test', { createdAt: LONG_AGO });
      const count = async () => (await getAccountsStore().metrics.totals('2000-01-01')).find(t => t.name === 'second_subscription')?.total ?? 0;
      const before = await count();
      await hook(eventBody('subscription.created', subscription(user.id, { id: 'sub_first' })));
      expect(await count()).toBe(before);
      // The same subscription told of again is not a second one.
      await hook(eventBody('subscription.updated', subscription(null, { id: 'sub_first' })));
      expect(await count()).toBe(before);
      // A different subscription for the account (two checkouts paid): the row follows the new one, and the operator is told.
      await hook(eventBody('subscription.created', subscription(user.id, { id: 'sub_second' })));
      expect(await getAccountsStore().billing.get(user.id)).toMatchObject({ subscription_id: 'sub_second' });
      expect(await count()).toBe(before + 1);
      expect(warn).toHaveBeenCalledWith('an account that has a plan was given a second subscription', { provider: 'stripe', first: 'sub_first', second: 'sub_second' });
      // Its later messages do not say it again.
      await hook(eventBody('subscription.updated', subscription(null, { id: 'sub_second' })));
      expect(await count()).toBe(before + 1);
      warn.mockRestore();
    });

    it('keep what was paid for after a cancellation, until the end of it', async () => {
      on();
      const user = await createTestUser('leaver@spine.test', { createdAt: LONG_AGO });
      await hook(eventBody('subscription.created', subscription(user.id, { id: 'sub_leaver' })));
      await hook(eventBody('subscription.updated', subscription(null, { id: 'sub_leaver', scheduled_change: { action: 'cancel' } })));
      expect(await getAccountsStore().billing.get(user.id)).toMatchObject({ cancel_scheduled: true });
      expect((await accountEntitlements(user.id))?.plan).toBe('premium');
      await hook(eventBody('subscription.canceled', subscription(null, { id: 'sub_leaver', status: 'canceled', current_billing_period: { ends_at: '2021-01-01T00:00:00Z' } })));
      expect((await accountEntitlements(user.id))?.plan).toBe('free');
    });

    it('are asked again when they come before the purchase they belong to, and applied once they can be placed', async () => {
      on();
      const user = await createTestUser('early@spine.test', { createdAt: LONG_AGO });
      stripe();
      const early = eventBody('subscription.created', subscription(null, { id: 'sub_early', customer_id: 'ctm_early' }));
      expect((await hook(early)).statusCode).toBe(409);
      expect(await getAccountsStore().billing.get(user.id)).toBeNull();
      expect((await hook(eventBody('transaction.completed', { id: 'txn_1', subscription_id: 'sub_early', customer_id: 'ctm_early', custom_data: { user_id: user.id }, items: [{ price: { id: 'pri_month' } }] }))).statusCode).toBe(200);
      expect((await accountEntitlements(user.id))?.plan).toBe('premium'); // the placeholder, until the subscription message
      expect((await hook(early)).statusCode).toBe(200);
      expect(await getAccountsStore().billing.get(user.id)).toMatchObject({ subscription_id: 'sub_early', interval: 'year' });
    });

    it('do not undo what a newer one said', async () => {
      on();
      const user = await createTestUser('order@spine.test', { createdAt: LONG_AGO });
      const newer = eventBody('subscription.updated', subscription(user.id, { id: 'sub_order', status: 'past_due' }), { occurred_at: '2026-02-02T00:00:00Z' });
      const older = eventBody('subscription.created', subscription(user.id, { id: 'sub_order', status: 'active' }), { occurred_at: '2026-02-01T00:00:00Z' });
      await hook(newer);
      await hook(older);
      expect((await getAccountsStore().billing.get(user.id))?.status).toBe('past_due');
    });

    it('ignore what Spine does not use, and an account that is gone', async () => {
      on();
      expect((await hook(eventBody('customer.updated', { id: 'ctm_9' }))).statusCode).toBe(200);
      expect((await hook(eventBody('subscription.created', subscription('nobody-here', { id: 'sub_gone' })))).statusCode).toBe(200);
      expect(await getAccountsStore().billing.findBySubscription('sub_gone')).toBeNull();
    });

    it('answer 404 when there are no plans', async () => {
      expect((await hook(eventBody('subscription.created', subscription(OWNER_ID)))).statusCode).toBe(404);
    });
  });

  describe('buying', () => {
    const checkout = (interval: unknown, headers = { cookie }) => app.inject({ method: 'POST', url: '/api/billing/checkout', headers, payload: { interval } });

    it('opens a checkout at the provider for the yearly founding price while places are left, naming the account', async () => {
      on();
      const api = stripe();
      const user = await createTestUser('buyer@spine.test');
      const res = await checkout('year', { cookie: await loginAs(app, user.email, user.password) });
      expect(res.json()).toEqual({ url: 'https://checkout.stripe.com/c/pay/cs_test_1' });
      const [form] = api.checkouts();
      expect(form!.get('line_items[0][price]')).toBe('pri_founding');
      expect(form!.get('client_reference_id')).toBe(user.id);
      expect(api.calls.find(c => c.url.endsWith('/v1/checkout/sessions'))!.url).toBe('https://api.stripe.com/v1/checkout/sessions');
    });

    it('charges the monthly price as it is, and refuses a nonsense interval', async () => {
      on();
      const api = stripe();
      expect((await checkout('month')).statusCode).toBe(200);
      expect(api.checkouts()[0]!.get('line_items[0][price]')).toBe('pri_month');
      expect((await checkout('week')).statusCode).toBe(400);
    });

    it('keeps a founding place taken after the subscription has ended and after the account is deleted', async () => {
      on();
      const store = getAccountsStore();
      const before = await store.billing.foundingHeld();
      const user = await createTestUser('founder-gone@spine.test', { createdAt: LONG_AGO });
      expect((await hook(eventBody('subscription.created', subscription(user.id, { id: 'sub_gone', items: [{ price: { id: 'pri_founding' } }] })))).statusCode).toBe(200);
      // Told twice, it is one place.
      await hook(eventBody('subscription.updated', subscription(user.id, { id: 'sub_gone', items: [{ price: { id: 'pri_founding' } }] })));
      expect(await store.billing.foundingHeld()).toBe(before + 1);
      await hook(eventBody('subscription.canceled', subscription(user.id, { id: 'sub_gone', status: 'canceled', items: [{ price: { id: 'pri_founding' } }], current_billing_period: { ends_at: LONG_AGO } })));
      expect(await store.billing.foundingHeld()).toBe(before + 1);
      // The account goes, with its subscription, and the place stays taken.
      await store.users.delete(user.id);
      expect(await store.billing.get(user.id)).toBeNull();
      expect(await store.billing.foundingHeld()).toBe(before + 1);
    });

    it('offers the regular yearly price once the founding places are gone', async () => {
      on();
      const store = getAccountsStore();
      for (let n = 0; n < 500; n++) {
        const id = `founder-${n}`;
        await store.users.create({ id, email: `f${n}@spine.test`, passwordHash: 'x', createdAt: LONG_AGO, verifiedAt: LONG_AGO, consent: undefined });
        await store.billing.put({ user_id: id, provider: 'stripe', customer_id: null, subscription_id: `sub_f${n}`, interval: 'year', plan: 'premium', status: 'active', founding: true, current_period_end: null, cancel_scheduled: false, updated_at: LONG_AGO });
      }
      expect((await get('/api/pricing', {})).json().founding_left).toBe(0);
      const api = stripe();
      await checkout('year');
      expect(api.checkouts()[0]!.get('line_items[0][price]')).toBe('pri_year');
    });

    it('does not sell a second plan to an account that has one, and says so when the provider is down', async () => {
      on();
      stripe(CATALOG, () => ({ status: 500, json: {} }));
      expect((await checkout('month')).statusCode).toBe(502);
      const user = await createTestUser('twice@spine.test');
      await getAccountsStore().billing.put({ user_id: user.id, provider: 'stripe', customer_id: 'ctm_t', subscription_id: 'sub_t', interval: 'month', plan: 'premium', status: 'active', founding: false, current_period_end: null, cancel_scheduled: false, updated_at: LONG_AGO });
      const res = await checkout('month', { cookie: await loginAs(app, user.email, user.password) });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('already_subscribed');
    });

    it('opens the provider’s page for managing it, for an account that has paid', async () => {
      on();
      expect((await app.inject({ method: 'POST', url: '/api/billing/portal', headers: { cookie } })).statusCode).toBe(404);
      const api = stripe();
      const user = await createTestUser('manager@spine.test');
      await getAccountsStore().billing.put({ user_id: user.id, provider: 'stripe', customer_id: 'ctm_m', subscription_id: 'sub_m', interval: 'year', plan: 'premium', status: 'active', founding: false, current_period_end: null, cancel_scheduled: false, updated_at: LONG_AGO });
      const res = await app.inject({ method: 'POST', url: '/api/billing/portal', headers: { cookie: await loginAs(app, user.email, user.password) } });
      expect(res.json()).toEqual({ url: 'https://billing.stripe.com/p/session/test_1' });
      expect(api.calls[0]!.url).toBe('https://api.stripe.com/v1/billing_portal/sessions');
      expect(api.calls[0]!.form.get('customer')).toBe('ctm_m');
    });

    it('opens the page for one action: the subscription’s own cancellation form or card form, the overview otherwise', async () => {
      on();
      const user = await createTestUser('actions@spine.test');
      await getAccountsStore().billing.put({ user_id: user.id, provider: 'stripe', customer_id: 'ctm_a', subscription_id: 'sub_a', interval: 'month', plan: 'premium', status: 'active', founding: false, current_period_end: new Date(Date.now() + 20 * 86400e3).toISOString(), cancel_scheduled: false, updated_at: new Date().toISOString() });
      const headers = { cookie: await loginAs(app, user.email, user.password) };
      const api = stripe();
      const ask = async (payload?: unknown) => (await app.inject({ method: 'POST', url: '/api/billing/portal', headers, payload: payload as never })).json();
      expect(await ask({ action: 'cancel' })).toEqual({ url: 'https://billing.stripe.com/p/session/test_1' });
      expect(api.calls[0]!.form.get('flow_data[type]')).toBe('subscription_cancel');
      expect(api.calls[0]!.form.get('flow_data[subscription_cancel][subscription]')).toBe('sub_a');
      await ask({ action: 'payment_method' });
      expect(api.calls[1]!.form.get('flow_data[type]')).toBe('payment_method_update');
      await ask({ action: 'overview' });
      await ask();
      expect(api.calls[2]!.form.has('flow_data[type]')).toBe(false);
      expect(api.calls[3]!.form.has('flow_data[type]')).toBe(false);
      // A link is made at each request and none is kept.
      expect(api.mock).toHaveBeenCalledTimes(4);
    });

    it('refuses an action it does not know, before asking the provider anything', async () => {
      on();
      const user = await createTestUser('badaction@spine.test');
      await getAccountsStore().billing.put({ user_id: user.id, provider: 'stripe', customer_id: 'ctm_b', subscription_id: 'sub_b', interval: 'month', plan: 'premium', status: 'active', founding: false, current_period_end: new Date(Date.now() + 20 * 86400e3).toISOString(), cancel_scheduled: false, updated_at: new Date().toISOString() });
      const api = stripe();
      const res = await app.inject({ method: 'POST', url: '/api/billing/portal', headers: { cookie: await loginAs(app, user.email, user.password) }, payload: { action: 'refund_everything' } });
      expect(res.statusCode).toBe(400);
      expect(api.mock).not.toHaveBeenCalled();
    });
  });

  describe('what the relay asks before and after a call', () => {
    const gate = () => createRelayGate(() => getAccountsStore());
    /** An account on a paid plan (granted by the operator): the plan whose questions and translation have no allowance. */
    const paidAccount = async (email: string, plan: 'essential' | 'premium' | 'family' = 'premium') => {
      const user = await createTestUser(email, { createdAt: LONG_AGO });
      await getAccountsStore().billing.put({ user_id: user.id, provider: 'operator', customer_id: null, subscription_id: null, interval: 'year', plan, status: 'active', founding: false, current_period_end: null, cancel_scheduled: false, updated_at: LONG_AGO });
      return user;
    };

    it('refuses an account its store does not hold, so a relay on a database of its own runs no call for free (S-64)', async () => {
      for (const task of ['extraction', 'translation', 'chat'] as const) expect(await gate().admit('no-such-account', task), task).toMatchObject({ status: 402, code: 'plan_required' });
    });

    it('lets a trial run everything, and counts what a call cost', async () => {
      const user = await createTestUser('gate-trial@spine.test');
      expect(await gate().admit(user.id, 'translation')).toBeNull();
      await gate().settle(user.id, 'extraction', 10 * 1024);
      expect(await getAccountsStore().usage.aiUsed(user.id, 'trial')).toBe(100 + 125 * 10);
    });

    it('keeps the free plan to reading, up to its allowance', async () => {
      const user = await createTestUser('gate-free@spine.test', { createdAt: LONG_AGO });
      for (const task of ['translation', 'chat', 'agent', 'linking', 'embed'] as const) expect(await gate().admit(user.id, task), task).toMatchObject({ status: 402, code: 'plan_required' });
      expect(await gate().admit(user.id, 'extraction')).toBeNull();
      const month = new Date().toISOString().slice(0, 7);
      await getAccountsStore().usage.aiAdd(user.id, `${month}:pages`, 10);
      expect(await gate().admit(user.id, 'extraction')).toMatchObject({ status: 402, code: 'allowance_used' });
    });

    it('stops adding pages when the trial’s 100 are used, and does not stop the small calls or what the trial has left of questions and translation', async () => {
      const user = await createTestUser('gate-cap@spine.test');
      await getAccountsStore().usage.aiAdd(user.id, 'trial:pages', 99);
      expect(await gate().admit(user.id, 'page')).toBeNull();
      await getAccountsStore().usage.aiAdd(user.id, 'trial:pages', 1);
      for (const task of ['page', 'extraction'] as const) expect(await gate().admit(user.id, task), task).toMatchObject({ code: 'allowance_used' });
      // What is not a page is not counted as one: summaries, links and embeddings are not stopped by the pages, and using what is kept is not stopped.
      for (const task of ['embed', 'linking', 'continuation', 'grouping', 'stamps', 'translation', 'chat', 'agent'] as const) expect(await gate().admit(user.id, task), task).toBeNull();
    });

    it('stops the next question at the trial’s 50 and the next translation at its 30, and tells the account page, with no hidden ceiling in the way', async () => {
      const user = await createTestUser('gate-trial-totals@spine.test');
      const store = getAccountsStore();
      await store.usage.aiAdd(user.id, 'trial:messages', 49);
      await store.usage.aiAdd(user.id, 'trial:translated', 29);
      expect(await gate().admit(user.id, 'agent', { work: 'question-trial-0001' })).toBeNull();
      expect(await gate().admit(user.id, 'translation', { work: 'translation-trial-1', pages: 1 })).toBeNull();
      await gate().settle(user.id, 'agent', 4096, { work: 'question-trial-0001' });
      await gate().settle(user.id, 'translation', 2048, { work: 'translation-trial-1', pages: 1 });
      expect([await store.usage.aiUsed(user.id, 'trial:messages'), await store.usage.aiUsed(user.id, 'trial:translated')]).toEqual([50, 30]);
      // The question already begun is finished; a new one, and a new translation, are not let in.
      expect(await gate().admit(user.id, 'agent', { work: 'question-trial-0001' })).toBeNull();
      expect(await gate().admit(user.id, 'agent', { work: 'question-trial-0002' })).toMatchObject({ status: 402, code: 'allowance_used' });
      expect(await gate().admit(user.id, 'chat')).toMatchObject({ code: 'allowance_used' });
      expect(await gate().admit(user.id, 'translation', { work: 'translation-trial-2', pages: 1 })).toMatchObject({ status: 402, code: 'allowance_used' });
      // A share's translation is the owner's, so it stops too; what is not a question or a translation does not.
      await store.shared.put(user.id, { id: 'share-trial-totals', expiresAt: '2999-01-01T00:00:00.000Z', requireApproval: false, size: 1, blobs: 0, blobBytes: 0 }, LONG_AGO);
      expect(await gate().admit('share:share-trial-totals', 'translation')).toMatchObject({ code: 'allowance_used' });
      expect(await gate().admit(user.id, 'extraction')).toBeNull();
      expect(await gate().admit(user.id, 'embed')).toBeNull();
    });

    it('lets Essential ask questions and not translate, and counts its pages five a month', async () => {
      const user = await paidAccount('gate-essential@spine.test', 'essential');
      expect(await gate().admit(user.id, 'agent', { work: 'question-ess-0001' })).toBeNull();
      expect(await gate().admit(user.id, 'linking')).toBeNull();
      expect(await gate().admit(user.id, 'translation')).toMatchObject({ status: 402, code: 'plan_required' });
      await getAccountsStore().usage.aiAdd(user.id, `${new Date().toISOString().slice(0, 7)}:pages`, 5 * 3);
      // Its yearly plan gives 150 pages once, used after the month's with nothing to tick.
      expect(await gate().admit(user.id, 'extraction')).toBeNull();
      await getAccountsStore().usage.aiAdd(user.id, 'once:import', PLANS.essential.allowance.import);
      expect(await gate().admit(user.id, 'extraction')).toMatchObject({ code: 'allowance_used' });
    });

    it('holds reading to twice what the plan lets be added this month, the import released this month inside it', async () => {
      const store = getAccountsStore();
      const month = new Date().toISOString().slice(0, 7);
      // Essential, yearly: five pages and the whole import of 150, so twice 155 pages; the import is not blocked by a ceiling made of the month's five.
      const essential = await paidAccount('gate-reading-ess@spine.test', 'essential');
      await store.usage.aiAdd(essential.id, month, 154 * PAGE);
      expect(await gate().admit(essential.id, 'extraction', { pages: 1 })).toBeNull();
      await store.usage.aiAdd(essential.id, month, 156 * PAGE);
      expect(await gate().admit(essential.id, 'extraction', { pages: 1 })).toMatchObject({ code: 'fair_use' });
      // The trial: twice its 100 pages in all.
      const trial = await createTestUser('gate-reading-trial@spine.test');
      await store.usage.aiAdd(trial.id, 'trial', 199 * PAGE);
      expect(await gate().admit(trial.id, 'embed')).toBeNull();
      await store.usage.aiAdd(trial.id, 'trial', PAGE);
      expect(await gate().admit(trial.id, 'embed')).toMatchObject({ code: 'fair_use' });
      // Free: twice its three pages.
      const free = await createTestUser('gate-reading-free@spine.test', { createdAt: LONG_AGO });
      await store.usage.aiAdd(free.id, month, 6 * PAGE);
      expect(await gate().admit(free.id, 'continuation')).toMatchObject({ code: 'fair_use' });
    });

    it('counts what is read, asked and translated apart, and what is not a page is not counted as one', async () => {
      const user = await paidAccount('gate-meters@spine.test');
      const month = new Date().toISOString().slice(0, 7);
      const store = getAccountsStore();
      const gate_ = gate();
      // A page of a scan is one page; a document’s text is the pages the device says; summaries and the rest are no pages.
      await gate_.settle(user.id, 'page', 0);
      await gate_.settle(user.id, 'extraction', 10 * 1024, { pages: 3 });
      await gate_.settle(user.id, 'embed', 100);
      await gate_.settle(user.id, 'linking', 100);
      await gate_.settle(user.id, 'continuation', 100);
      expect(await store.usage.aiUsed(user.id, `${month}:pages`)).toBe(4);
      // With no word from the device, the pages are guessed from the size of the text, at least one.
      await gate_.settle(user.id, 'extraction', 9001);
      expect(await store.usage.aiUsed(user.id, `${month}:pages`)).toBe(4 + 4);
      // Each kind of call is also counted in the cost ceiling of its own kind.
      expect(await store.usage.aiUsed(user.id, month)).toBeGreaterThan(0);
      await gate_.settle(user.id, 'agent', 8 * 1024);
      expect(await store.usage.aiUsed(user.id, `${month}:chat`)).toBe(256);
      await gate_.settle(user.id, 'translation', 2048);
      expect(await store.usage.aiUsed(user.id, `${month}:translation`)).toBe(330);
    });

    it('stops a kind of work only at the ceiling no use of an archive reaches, and says so neutrally, with no number', async () => {
      const user = await paidAccount('gate-ceiling@spine.test');
      const month = new Date().toISOString().slice(0, 7);
      const store = getAccountsStore();
      await store.usage.aiAdd(user.id, `${month}:chat`, fairUseOf('premium').monthly.messages * CHAT_MESSAGE);
      expect(await gate().admit(user.id, 'chat')).toMatchObject({ code: 'fair_use', error: 'This account has reached its fair-use limit, contact support' });
      expect(await gate().admit(user.id, 'agent')).toMatchObject({ code: 'fair_use', error: 'This account has reached its fair-use limit, contact support' });
      expect(await gate().admit(user.id, 'extraction')).toBeNull();
      expect(await gate().admit(user.id, 'translation')).toBeNull();
      await store.usage.aiAdd(user.id, `${month}:translation`, fairUseOf('premium').monthly.translatedPages * TRANSLATED_PAGE);
      expect(await gate().admit(user.id, 'translation')).toMatchObject({ code: 'fair_use', error: 'This account has reached its fair-use limit, contact support' });
      expect(await gate().admit(user.id, 'extraction')).toBeNull();
    });

    it('counts a chat question once however many calls it takes, and never refuses a question for want of an allowance', async () => {
      const user = await paidAccount('gate-messages@spine.test');
      const store = getAccountsStore();
      const month = new Date().toISOString().slice(0, 7);
      // Five calls of one question are one message; a call with no id is a message of its own.
      for (let i = 0; i < 5; i++) { expect(await gate().admit(user.id, 'agent', { work: 'question-aaaa-0001' })).toBeNull(); await gate().settle(user.id, 'agent', 4096, { work: 'question-aaaa-0001' }); }
      expect(await store.usage.aiUsed(user.id, `${month}:messages`)).toBe(1);
      await gate().settle(user.id, 'chat', 1000);
      await gate().settle(user.id, 'chat', 1000);
      expect(await store.usage.aiUsed(user.id, `${month}:messages`)).toBe(3);
      // However many have been asked, the next is let through: using what has been added is counted and not limited.
      await store.usage.aiAdd(user.id, `${month}:messages`, 1_000);
      expect(await gate().admit(user.id, 'agent', { work: 'question-bbbb-0002' })).toBeNull();
      expect(await gate().admit(user.id, 'chat')).toBeNull();
    });

    it('counts a document’s translation once, its pages as the device says, and never refuses it for want of an allowance', async () => {
      const user = await paidAccount('gate-translated@spine.test');
      const store = getAccountsStore();
      const month = new Date().toISOString().slice(0, 7);
      // Three calls of one translation of a four-page document are four pages; another language is another translation.
      for (let i = 0; i < 3; i++) await gate().settle(user.id, 'translation', 2048, { work: 'translation-aaaa-1', pages: 4 });
      expect(await store.usage.aiUsed(user.id, `${month}:translated`)).toBe(4);
      await gate().settle(user.id, 'translation', 2048, { work: 'translation-bbbb-2', pages: 4 });
      expect(await store.usage.aiUsed(user.id, `${month}:translated`)).toBe(8);
      await store.usage.aiAdd(user.id, `${month}:translated`, 1_000);
      expect(await gate().admit(user.id, 'translation', { work: 'translation-cccc-3', pages: 400 })).toBeNull();
    });

    it('holds a device that never tells the truth about what it sends to the cost ceiling behind the counts', async () => {
      const user = await paidAccount('gate-backstop@spine.test');
      const month = new Date().toISOString().slice(0, 7);
      await getAccountsStore().usage.aiAdd(user.id, `${month}:chat`, fairUseOf('premium').monthly.messages * CHAT_MESSAGE);
      expect(await gate().admit(user.id, 'agent', { work: 'question-cccc-0003' })).toMatchObject({ code: 'fair_use' });
    });

    it('draws pages from the month’s, then from the yearly plan’s one-off allowance, and a monthly or free plan has none', async () => {
      const store = getAccountsStore();
      const month = new Date().toISOString().slice(0, 7);
      const paid = await createTestUser('gate-import@spine.test', { createdAt: LONG_AGO });
      await store.billing.put({ user_id: paid.id, provider: 'operator', customer_id: null, subscription_id: null, interval: 'year', plan: 'premium', status: 'active', founding: false, current_period_end: null, cancel_scheduled: false, updated_at: LONG_AGO });
      // The month's pages come first, and are not touched by the allowance.
      await gate().settle(paid.id, 'extraction', 10 * 1024, { pages: 3 });
      expect(await store.usage.aiUsed(paid.id, `${month}:pages`)).toBe(3);
      expect(await store.usage.aiUsed(paid.id, 'once:import')).toBe(0);
      // Chat is never pages.
      await gate().settle(paid.id, 'agent', 0);
      expect(await store.usage.aiUsed(paid.id, 'once:import')).toBe(0);
      // The month's pages used up, the allowance reads, with nothing said, and is charged what is read.
      await store.usage.aiAdd(paid.id, `${month}:pages`, PLANS.premium.allowance.pages);
      expect(await gate().admit(paid.id, 'extraction')).toBeNull();
      await gate().settle(paid.id, 'extraction', 0, { pages: 4 });
      expect(await store.usage.aiUsed(paid.id, 'once:import')).toBe(4);
      // The allowance used up, nothing is left to add.
      await store.usage.aiAdd(paid.id, 'once:import', PLANS.premium.allowance.import);
      expect(await gate().admit(paid.id, 'extraction')).toMatchObject({ code: 'allowance_used' });
      // The free plan and the trial have none.
      const free = await createTestUser('gate-import-free@spine.test', { createdAt: LONG_AGO });
      await gate().settle(free.id, 'extraction', 0, { pages: 1 });
      expect(await store.usage.aiUsed(free.id, 'once:import')).toBe(0);
      expect(await store.usage.aiUsed(free.id, `${month}:pages`)).toBe(1);
    });

    it('forgets last month’s counts of every meter, and keeps this month’s and the trial’s', async () => {
      const user = await createTestUser('gate-forget@spine.test');
      const store = getAccountsStore();
      await store.usage.aiAdd(user.id, 'trial', 5);
      await store.usage.aiAdd(user.id, '2020-01', 7);
      await store.usage.aiAdd(user.id, '2020-01:chat', 7);
      await store.usage.aiAdd(user.id, 'pool:2020-01:translation', 7);
      const month = new Date().toISOString().slice(0, 7);
      await store.usage.aiAdd(user.id, `${month}:chat`, 3);
      await store.usage.aiAdd(user.id, month, 4);
      expect([await store.usage.aiUsed(user.id, '2020-01'), await store.usage.aiUsed(user.id, '2020-01:chat'), await store.usage.aiUsed(user.id, 'pool:2020-01:translation')]).toEqual([0, 0, 0]);
      expect([await store.usage.aiUsed(user.id, 'trial'), await store.usage.aiUsed(user.id, `${month}:chat`), await store.usage.aiUsed(user.id, month)]).toEqual([5, 3, 4]);
    });

    it('asks a share’s recipient nothing but the owner’s plan, and lets the demo through to its own counts', async () => {
      const free = await createTestUser('gate-share@spine.test', { createdAt: LONG_AGO });
      await getAccountsStore().shared.put(free.id, { id: 'share-gate', expiresAt: '2999-01-01T00:00:00.000Z', requireApproval: false, size: 1, blobs: 0, blobBytes: 0 }, LONG_AGO);
      expect(await gate().admit('share:share-gate', 'translation')).toMatchObject({ code: 'plan_required' });
      expect(await gate().admit('share:share-gate', 'extraction')).toBeNull();
      expect(await gate().admit('demo:abc', 'extraction')).toBeNull();
      await gate().settle('share:share-gate', 'translation', 5000);
      await gate().settle('share:share-gate', 'chat', 5000);
      await gate().settle('demo:abc', 'extraction', 5000);
      expect(await getAccountsStore().usage.aiUsed(free.id, new Date().toISOString().slice(0, 7))).toBe(0);
    });
  });

  describe('sharing', () => {
    const put = (id: string, headers: Record<string, string>, who = cookie) => app.inject({
      method: 'PUT', url: `/api/shared/${id}`, payload: Buffer.from('sealed'),
      headers: { cookie: who, 'content-type': 'application/octet-stream', 'x-spine-pass-check': 'c'.repeat(43), 'x-spine-expires': new Date(Date.now() + 86400e3).toISOString(), ...headers },
    });

    it('keeps visitor approval and a second live share to the paid plans', async () => {
      on();
      const free = await createTestUser('share-free@spine.test', { createdAt: LONG_AGO });
      const who = await loginAs(app, free.email, free.password);
      const approval = await put('aaaaaaaaaaaaaaaaaaaaaaaa', { 'x-spine-approval': '1' }, who);
      expect(approval.statusCode).toBe(402);
      expect(approval.json().code).toBe('plan_required');
      expect((await put('bbbbbbbbbbbbbbbbbbbbbbbb', {}, who)).statusCode).toBe(201);
      const second = await put('cccccccccccccccccccccccc', {}, who);
      expect(second.statusCode).toBe(402);
      expect(second.json().code).toBe('plan_required');
      // …and the trial has them.
      expect((await put('dddddddddddddddddddddddd', { 'x-spine-approval': '1' })).statusCode).toBe(201);
    });
  });

  describe('people', () => {
    const profileHeaders = { 'content-type': 'application/octet-stream', 'x-spine-kind': 'profile', 'x-spine-profile': 'profile-0001', 'x-spine-wrapped-key': 'k'.repeat(100), 'x-spine-base-seq': '0' };
    const addPerson = (who: string, id: string) => app.inject({ method: 'PUT', url: `/api/vault/objects/${id}`, headers: { cookie: who, ...profileHeaders }, payload: Buffer.from('sealed profile') });

    it('keeps one person to the free plan and six to the trial, and a replaced profile is not a new person', async () => {
      on();
      const free = await createTestUser('people-free@spine.test', { createdAt: LONG_AGO });
      const who = await loginAs(app, free.email, free.password);
      await app.inject({ method: 'PUT', url: '/api/vault/keys', headers: { cookie: who }, payload: { auth_value: fakeAuthValue(), keys: fakeVaultKeys() } });
      const cookieFree = who; // setting the keys keeps this sign-in and ends the others
      expect((await addPerson(cookieFree, 'profile-aaaa-0001')).statusCode).toBe(200);
      const second = await addPerson(cookieFree, 'profile-bbbb-0002');
      expect(second.statusCode).toBe(402);
      expect(second.json().code).toBe('plan_required');
      expect(second.json().error).toMatch(/another person is not part of the account.s plan/);

      expect((await accountEntitlements(OWNER_ID))?.profiles).toBe(6);
      expect((await accountEntitlements(free.id))?.profiles).toBe(1);
    });

    it('is not asked of an instance with no plans', async () => {
      const who = await createTestUser('people-off@spine.test');
      const cookiePeople = await loginAs(app, who.email, who.password);
      await app.inject({ method: 'PUT', url: '/api/vault/keys', headers: { cookie: cookiePeople }, payload: { auth_value: fakeAuthValue(), keys: fakeVaultKeys() } });
      for (const n of ['profile-cccc-0001', 'profile-dddd-0002', 'profile-eeee-0003']) expect((await addPerson(cookiePeople, n)).statusCode).toBe(200);
    });
  });

  describe('the Essential plan', () => {
    const ESSENTIAL = { SPINE_STRIPE_PRICE_ESSENTIAL_YEAR: 'pri_essential_year', SPINE_STRIPE_PRICE_ESSENTIAL_MONTH: 'pri_essential_month' };

    it('is sold only when both its prices are named', () => {
      expect(loadBillingConfig(BILLING)).toMatchObject({ essential: null });
      expect(loadBillingConfig({ ...BILLING, ...ESSENTIAL })).toMatchObject({ essential: { year: 'pri_essential_year', month: 'pri_essential_month' } });
      expect(() => loadBillingConfig({ ...BILLING, SPINE_STRIPE_PRICE_ESSENTIAL_MONTH: 'pri_essential_month' })).toThrow(/both SPINE_STRIPE_PRICE_ESSENTIAL_YEAR and SPINE_STRIPE_PRICE_ESSENTIAL_MONTH/);
    });

    it('is shown at the amounts Stripe gives, a yearly one and a monthly one', async () => {
      on();
      Object.assign(process.env, ESSENTIAL);
      stripe();
      expect((await get('/api/pricing', {})).json()).toMatchObject({ essential: true, prices: { essential: { year: 24.9, month: 2.49 } } });
    });

    it('is refused a price that is not a yearly and a monthly one, or in another currency', async () => {
      on();
      Object.assign(process.env, ESSENTIAL);
      stripe({ ...CATALOG, pri_essential_month: { amount: '249', interval: 'year' } });
      expect((await get('/api/pricing', {})).json().prices).toBeNull();
      resetCatalog();
      stripe({ ...CATALOG, pri_essential_month: { amount: '249', interval: 'month', currency: 'USD' } });
      expect((await get('/api/pricing', {})).json().prices).toBeNull();
    });

    it('asks Stripe once for all the visitors who arrive while its answer is stale', async () => {
      on();
      const fetchMock = vi.fn(async (url: string) => {
        await new Promise(r => setTimeout(r, 20));
        const price = CATALOG[decodeURIComponent(String(url).split('/prices/')[1] ?? '')]!;
        return reply({ active: true, unit_amount: Number(price.amount), currency: 'eur', recurring: price.interval ? { interval: price.interval } : null });
      });
      vi.stubGlobal('fetch', fetchMock);
      const config = loadBillingConfig(BILLING) as Extract<ReturnType<typeof loadBillingConfig>, { enabled: true }>;
      await Promise.all(Array.from({ length: 30 }, () => loadPrices(config)));
      // The three prices of Premium and its founding place, once, not thirty times.
      expect(fetchMock.mock.calls.length).toBe(3);
    });

    it('keeps the last prices it had while Stripe is out, and asks again after a while', async () => {
      on();
      stripe();
      const config = loadBillingConfig(BILLING) as Extract<ReturnType<typeof loadBillingConfig>, { enabled: true }>;
      const first = await loadPrices(config, 1_000_000);
      expect(first).toMatchObject({ premium: { year: 49 } });
      vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
      expect(await loadPrices(config, 1_000_000 + 11 * 60_000)).toEqual(first);
      stripe({ ...CATALOG, pri_year: { amount: '5900', interval: 'year' } });
      // Not asked again at once after a failure; asked after the pause.
      expect(await loadPrices(config, 1_000_000 + 11 * 60_000 + 5_000)).toEqual(first);
      expect(await loadPrices(config, 1_000_000 + 12 * 60_000)).toMatchObject({ premium: { year: 59 } });
    });

    it('opens a checkout at its own prices, with no founding price, and refuses it where it is not sold', async () => {
      on();
      const api = stripe();
      const user = await createTestUser('essential-buyer@spine.test');
      const who = await loginAs(app, user.email, user.password);
      // From an address of its own: the checkout is limited to ten a minute for each, and the other tests of this file use up the test client's.
      const ask = (interval: string) => app.inject({ method: 'POST', url: '/api/billing/checkout', headers: { cookie: who }, remoteAddress: '10.9.9.9', payload: { plan: 'essential', interval } });
      expect((await ask('year')).statusCode).toBe(400);
      Object.assign(process.env, ESSENTIAL);
      expect((await ask('month')).statusCode).toBe(200);
      expect(api.checkouts().map(f => f.get('line_items[0][price]'))).toEqual(['pri_essential_month']);
    });

    it('is the plan a subscription to its prices gives', async () => {
      on();
      Object.assign(process.env, ESSENTIAL);
      const user = await createTestUser('essential-payer@spine.test', { createdAt: LONG_AGO });
      const res = await hook(eventBody('subscription.created', subscription(user.id, { id: 'sub_ess', items: [{ price: { id: 'pri_essential_month' } }], billing_cycle: { interval: 'month' } })));
      expect(res.statusCode).toBe(200);
      expect(await getAccountsStore().billing.get(user.id)).toMatchObject({ plan: 'essential', interval: 'month', founding: false });
      expect(await accountEntitlements(user.id)).toMatchObject({ plan: 'essential', chat: true, translation: false, vaultBytes: 2 * 1024 ** 3 });
    });
  });

  describe('what is bought once', () => {
    const ADDONS = { SPINE_STRIPE_PRICE_TOPUP_PAGES: 'pri_topup' };
    // A completed checkout's line items are asked of Stripe.
    beforeEach(() => { stripe(); });
    const gate = () => createRelayGate(() => getAccountsStore());
    const store = () => getAccountsStore();
    const bought = (user: string, price: string, id: string) => hook(eventBody('transaction.completed', { id, status: 'completed', customer_id: 'ctm_x', custom_data: { user_id: user }, items: [{ price: { id: price } }] }));
    const granted = async (email: string, plan: 'essential' | 'premium' | null) => {
      const user = await createTestUser(email, { createdAt: LONG_AGO });
      if (plan) await store().billing.put({ user_id: user.id, provider: 'operator', customer_id: null, subscription_id: null, interval: 'year', plan, status: 'active', founding: false, current_period_end: null, cancel_scheduled: false, updated_at: LONG_AGO });
      return user;
    };

    it('is shown at the amounts Stripe gives, for the plans it is meant for, and only where it is sold', async () => {
      on();
      stripe();
      const free = await granted('addon-view-free@spine.test', null);
      const who = await loginAs(app, free.email, free.password);
      expect((await get('/api/billing', { cookie: who })).json().addons).toMatchObject({ page_topup: { buyable: false } });
      Object.assign(process.env, ADDONS);
      resetCatalog();
      const view = (await get('/api/billing', { cookie: who })).json();
      expect(view.addons).toMatchObject({ page_topup: { buyable: false, pages_left: 0 } });
      expect(view.prices.addons).toEqual({ page_topup: 19.99 });
      const premium = await granted('addon-view-premium@spine.test', 'premium');
      const cookiePremium = await loginAs(app, premium.email, premium.password);
      expect((await get('/api/billing', { cookie: cookiePremium })).json().addons).toMatchObject({ page_topup: { buyable: true } });
    });

    it('opens a checkout for the top-up only for the plans that add by the month, and only where it is sold', async () => {
      on();
      Object.assign(process.env, ADDONS);
      const api = stripe();
      const free = await granted('addon-buy-free@spine.test', null);
      const premium = await granted('addon-buy-premium@spine.test', 'premium');
      const ask = async (u: { email: string; password: string }, addon: string, ip: string) => app.inject({ method: 'POST', url: '/api/billing/checkout', headers: { cookie: await loginAs(app, u.email, u.password) }, remoteAddress: ip, payload: { addon } });
      expect((await ask(free, 'page_topup', '10.9.9.20')).statusCode).toBe(409);
      expect((await ask(premium, 'page_topup', '10.9.9.21')).statusCode).toBe(200);
      expect((await ask(premium, 'translation_pack', '10.9.9.21')).statusCode).toBe(400);
      expect(api.checkouts().map(f => [f.get('line_items[0][price]'), f.get('metadata[addon]')])).toEqual([['pri_topup', 'page_topup']]);
      Object.assign(process.env, { SPINE_STRIPE_PRICE_TOPUP_PAGES: '' });
      expect((await ask(premium, 'page_topup', '10.9.9.22')).statusCode).toBe(400);
    });

    it('applies a purchase once even when Stripe tells of it twice at the same moment', async () => {
      on();
      Object.assign(process.env, ADDONS);
      const user = await granted('addon-race@spine.test', 'premium');
      const answers = await Promise.all([bought(user.id, 'pri_topup', 'txn_race'), bought(user.id, 'pri_topup', 'txn_race'), bought(user.id, 'pri_topup', 'txn_race')]);
      expect(answers.map(r => r.statusCode)).toEqual([200, 200, 200]);
      expect(await topupLeft(store(), user.id)).toBe(250);
    });

    it('adds 250 pages once the month’s are used, and they last past the month', async () => {
      on();
      Object.assign(process.env, ADDONS);
      const user = await granted('addon-topup@spine.test', 'essential');
      const month = new Date().toISOString().slice(0, 7);
      await store().usage.aiAdd(user.id, `${month}:pages`, 15);
      // The yearly plan's one-off allowance is used first; this is about what is bought.
      await store().usage.aiAdd(user.id, 'once:import', PLANS.essential.allowance.import);
      expect(await gate().admit(user.id, 'extraction', { pages: 1 })).toMatchObject({ code: 'allowance_used' });
      await bought(user.id, 'pri_topup', 'txn_topup_1');
      await bought(user.id, 'pri_topup', 'txn_topup_1');
      expect(await topupLeft(store(), user.id)).toBe(250);
      expect(await gate().admit(user.id, 'extraction', { pages: 1 })).toBeNull();
      await gate().settle(user.id, 'extraction', 4096, { pages: 10 });
      expect(await topupLeft(store(), user.id)).toBe(240);
      expect(await store().usage.aiUsed(user.id, `${month}:pages`)).toBe(15);
      await gate().settle(user.id, 'extraction', 4096, { pages: 240 });
      expect(await gate().admit(user.id, 'extraction', { pages: 1 })).toMatchObject({ code: 'allowance_used' });
      // A new month has its own pages again, and what the top-up left is still there for after them.
      await bought(user.id, 'pri_topup', 'txn_topup_2');
      expect(await topupLeft(store(), user.id)).toBe(250);
    });

    it('is applied to the account the payment names, never to one that is gone or unnamed', async () => {
      on();
      Object.assign(process.env, ADDONS);
      expect((await bought('no-such-account', 'pri_topup', 'txn_nobody')).statusCode).toBe(200);
      const body = eventBody('transaction.completed', { id: 'txn_unnamed', status: 'completed', items: [{ price: { id: 'pri_topup' } }] });
      expect((await hook(body)).statusCode).toBe(200);
    });
  });

  describe('the family plan', () => {
    const FAMILY = { SPINE_STRIPE_PRICE_FAMILY_YEAR: 'pri_family_year', SPINE_STRIPE_PRICE_FAMILY_MONTH: 'pri_family_month' };

    it('is sold only when both its prices are named', () => {
      expect(loadBillingConfig(BILLING)).toMatchObject({ family: null });
      expect(loadBillingConfig({ ...BILLING, ...FAMILY })).toMatchObject({ family: { year: 'pri_family_year', month: 'pri_family_month' } });
      expect(() => loadBillingConfig({ ...BILLING, SPINE_STRIPE_PRICE_FAMILY_YEAR: 'pri_family_year' })).toThrow(/both SPINE_STRIPE_PRICE_FAMILY_YEAR and SPINE_STRIPE_PRICE_FAMILY_MONTH/);
    });

    it('is offered on the pricing page and the account page only where it is sold', async () => {
      on();
      stripe();
      expect((await get('/api/pricing', {})).json()).toMatchObject({ family: false });
      expect((await get('/api/pricing', {})).json().prices.family).toBeUndefined();
      Object.assign(process.env, FAMILY);
      resetCatalog();
      expect((await get('/api/pricing', {})).json()).toMatchObject({ family: true, prices: { family: { year: 89, month: 8.99 } } });
      expect((await get('/api/billing')).json()).toMatchObject({ family: true, people: { limit: 6 } });
    });

    it('opens a checkout at the family price, with no founding price, and refuses it where it is not sold', async () => {
      on();
      const api = stripe();
      const user = await createTestUser('family-buyer@spine.test');
      const who = await loginAs(app, user.email, user.password);
      const ask = (plan: string, interval: string) => app.inject({ method: 'POST', url: '/api/billing/checkout', headers: { cookie: who }, payload: { plan, interval } });
      const refused = await ask('family', 'year');
      expect(refused.statusCode).toBe(400);
      expect(refused.json().code).toBe('plan_not_offered');
      Object.assign(process.env, FAMILY);
      expect((await ask('family', 'year')).statusCode).toBe(200);
      expect((await ask('family', 'month')).statusCode).toBe(200);
      expect(api.checkouts().map(f => f.get('line_items[0][price]'))).toEqual(['pri_family_year', 'pri_family_month']);
    });

    it('is the plan a subscription to its prices gives, with six people and others let in', async () => {
      on();
      Object.assign(process.env, FAMILY);
      const user = await createTestUser('family-payer@spine.test', { createdAt: LONG_AGO });
      expect((await hook(eventBody('subscription.created', subscription(user.id, { id: 'sub_family', items: [{ price: { id: 'pri_family_year' } }] })))).statusCode).toBe(200);
      expect(await getAccountsStore().billing.get(user.id)).toMatchObject({ plan: 'family', founding: false });
      expect(await accountEntitlements(user.id)).toMatchObject({ plan: 'family', profiles: 6, delegation: true });
      const who = await loginAs(app, user.email, user.password);
      expect((await get('/api/billing', { cookie: who })).json()).toMatchObject({ plan: 'family', people: { limit: 6 }, features: { delegation: true } });
      // A message that lists no price keeps the plan it had.
      await hook(eventBody('subscription.updated', subscription(null, { id: 'sub_family', items: [], status: 'past_due' })));
      expect(await getAccountsStore().billing.get(user.id)).toMatchObject({ plan: 'family', status: 'past_due' });
    });

    it('is granted by the operator for a time', async () => {
      const { runCli } = await import('../cli.js');
      const out: string[] = [];
      const user = await createTestUser('family-guest@spine.test');
      expect(await runCli(['grant-plan', 'family-guest@spine.test', '--plan=family', '--days=10'], { out: l => out.push(l), err: l => out.push(l), readPassword: async () => '' })).toBe(0);
      expect(await getAccountsStore().billing.get(user.id)).toMatchObject({ provider: 'operator', plan: 'family' });
      expect(await runCli(['grant-plan', 'family-guest@spine.test', '--plan=big'], { out: l => out.push(l), err: l => out.push(l), readPassword: async () => '' })).toBe(2);
    });
  });

  it('counts a trial of three months', () => {
    expect(TRIAL_MONTHS).toBe(3);
    expect(TEST_PASSWORD).toBeTruthy();
  });
});

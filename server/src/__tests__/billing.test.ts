import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { getAccountsStore } from 'spine-core/store/index.js';
import { PAGE, TRIAL_MONTHS } from 'spine-core/billing/plans.js';
import { buildTestApp, loginAs, loginSession } from './helpers/app.js';
import { createTestUser, OWNER_ID, TEST_PASSWORD } from './helpers/seed.js';
import { billingOn, loadBillingConfig } from '../billing/config.js';
import { createRelayGate } from '../billing/gate.js';
import { accountEntitlements, liveSharesFor, vaultBytesFor } from '../billing/entitlements.js';
import { verifySignature } from '../billing/paddle.js';
import { loadConfig } from '../config.js';
import { fakeAuthValue, fakeVaultKeys } from 'spine-core/testing/vault.js';

const SECRET = 'whsec_test_secret_for_the_webhook';
const BILLING = {
  SPINE_BILLING: 'on', PADDLE_ENVIRONMENT: 'sandbox', PADDLE_API_KEY: 'pdl_test_key', PADDLE_WEBHOOK_SECRET: SECRET, SPINE_CHECKOUT_URL: 'https://pay.spine.example/',
  SPINE_PADDLE_PRICE_YEAR: 'pri_year', SPINE_PADDLE_PRICE_MONTH: 'pri_month', SPINE_PADDLE_PRICE_FOUNDING: 'pri_founding',
};
const LONG_AGO = '2020-01-01T00:00:00.000Z';

const sign = (body: string, ts = Math.floor(Date.now() / 1000), secret = SECRET) => `ts=${ts};h1=${createHmac('sha256', secret).update(`${ts}:${body}`).digest('hex')}`;
const eventBody = (type: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ event_id: `evt_${Math.random().toString(36).slice(2)}`, event_type: type, occurred_at: new Date().toISOString(), data, ...extra });
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
  afterEach(() => { process.env = { ...saved }; vi.unstubAllGlobals(); });

  const get = (url: string, headers: Record<string, string> = { cookie }) => app.inject({ method: 'GET', url, headers });
  const hook = (body: string, signature = sign(body)) => app.inject({ method: 'POST', url: '/api/billing/webhook', headers: { 'content-type': 'application/json', 'paddle-signature': signature }, payload: body });

  describe('settings', () => {
    it('are not all needed by the relay, which applies the plans and never talks to the payment provider', () => {
      expect(billingOn({})).toBe(false);
      expect(billingOn({ SPINE_BILLING: 'on' })).toBe(true);
      expect(billingOn({ SPINE_BILLING: 'ON' })).toBe(true);
      expect(billingOn({ SPINE_BILLING: 'yes' })).toBe(false);
    });

    it('are off unless said, and then say what is missing', () => {
      expect(loadBillingConfig({})).toEqual({ enabled: false });
      expect(() => loadBillingConfig({ SPINE_BILLING: 'on' })).toThrow(/PADDLE_API_KEY/);
      expect(() => loadBillingConfig({ ...BILLING, PADDLE_ENVIRONMENT: '' })).toThrow(/PADDLE_ENVIRONMENT/);
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
      expect((await get('/api/billing', {})).statusCode).toBe(401);
      const body = (await get('/api/billing')).json();
      expect(body).toMatchObject({ enabled: true, plan: 'trial', subscription: null, can_manage: false, ai: { used: 0, allowance: 150, period: 'trial' }, founding_left: 500 });
      expect(body.trial_ends_at).toBeTruthy();
      expect((await get('/api/pricing', {})).json()).toMatchObject({ enabled: true, founding_left: 500, prices: { premium: { year: 39, month: 3.99 }, founding: { year: 29 } } });
    });

    it('puts an account past its trial on the free plan, with the free plan’s limits', async () => {
      on();
      const old = await createTestUser('old@spine.test', { createdAt: LONG_AGO });
      expect(await accountEntitlements(old.id)).toMatchObject({ plan: 'free', translation: false, chat: false, approvalMode: false });
      expect(await vaultBytesFor(old.id)).toBe(1024 ** 3);
      expect(await liveSharesFor(old.id)).toBe(1);
      expect(await vaultBytesFor(OWNER_ID)).toBeGreaterThan(1024 ** 3);
      const cookieOld = await loginAs(app, old.email, old.password);
      expect((await get('/api/billing', { cookie: cookieOld })).json()).toMatchObject({ plan: 'free', ai: { allowance: 30, period: 'month' }, shares: { limit: 1 }, features: { translation: false } });
    });
  });

  describe('the payment provider’s messages', () => {
    it('are refused unless signed with the secret, in time, over the exact body', async () => {
      on();
      const body = eventBody('subscription.created', subscription(OWNER_ID));
      expect((await hook(body, 'ts=1;h1=00')).statusCode).toBe(401);
      expect((await hook(body, sign(body, Math.floor(Date.now() / 1000), 'another secret'))).statusCode).toBe(401);
      expect((await hook(body, sign(body, Math.floor(Date.now() / 1000) - 3600))).statusCode).toBe(401);
      expect((await hook(`${body} `, sign(body))).statusCode).toBe(401);
      expect((await app.inject({ method: 'POST', url: '/api/billing/webhook', payload: {} })).statusCode).toBe(401);
      expect(await getAccountsStore().billing.get(OWNER_ID)).toBeNull();
    });

    it('accepts any one of the signatures while a secret is being replaced', () => {
      const body = '{"a":1}';
      const ts = 1_700_000_000;
      const good = createHmac('sha256', SECRET).update(`${ts}:${body}`).digest('hex');
      expect(verifySignature(SECRET, `ts=${ts};h1=${'0'.repeat(64)};h1=${good}`, body, ts * 1000)).toBe(true);
      expect(verifySignature(SECRET, `ts=${ts}`, body, ts * 1000)).toBe(false);
    });

    it('give the account the paid plan, and take the trial’s clock out of it', async () => {
      on();
      const user = await createTestUser('payer@spine.test', { createdAt: LONG_AGO });
      const res = await hook(eventBody('subscription.created', subscription(user.id, { id: 'sub_payer', items: [{ price: { id: 'pri_founding' } }] })));
      expect(res.statusCode).toBe(200);
      expect(await getAccountsStore().billing.get(user.id)).toMatchObject({ provider: 'paddle', customer_id: 'ctm_1', subscription_id: 'sub_payer', interval: 'year', founding: true, cancel_scheduled: false });
      expect(await accountEntitlements(user.id)).toMatchObject({ plan: 'premium', translation: true });
      const cookiePayer = await loginAs(app, user.email, user.password);
      expect((await get('/api/billing', { cookie: cookiePayer })).json()).toMatchObject({ plan: 'premium', can_manage: true, subscription: { interval: 'year', founding: true }, founding_left: 499 });
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
    const stubProvider = (answer: unknown, status = 200) => {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify(answer), { status }));
      vi.stubGlobal('fetch', fetchMock);
      return fetchMock;
    };
    const checkout = (interval: unknown, headers = { cookie }) => app.inject({ method: 'POST', url: '/api/billing/checkout', headers, payload: { interval } });

    it('opens a checkout at the provider for the yearly founding price while places are left, naming the account', async () => {
      on();
      const fetchMock = stubProvider({ data: { checkout: { url: 'https://pay.spine.example/?_ptxn=txn_1' } } });
      const user = await createTestUser('buyer@spine.test');
      const res = await checkout('year', { cookie: await loginAs(app, user.email, user.password) });
      expect(res.json()).toEqual({ url: 'https://pay.spine.example/?_ptxn=txn_1' });
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe('https://sandbox-api.paddle.com/transactions');
      expect(JSON.parse(init.body as string)).toEqual({ items: [{ price_id: 'pri_founding', quantity: 1 }], custom_data: { user_id: user.id }, checkout: { url: 'https://pay.spine.example/' } });
      expect((init.headers as Record<string, string>).authorization).toBe('Bearer pdl_test_key');
    });

    it('charges the monthly price as it is, and refuses a nonsense interval', async () => {
      on();
      const fetchMock = stubProvider({ data: { checkout: { url: 'https://pay.spine.example/?_ptxn=txn_2' } } });
      expect((await checkout('month')).statusCode).toBe(200);
      expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).items[0].price_id).toBe('pri_month');
      expect((await checkout('week')).statusCode).toBe(400);
    });

    it('offers the regular yearly price once the founding places are gone', async () => {
      on();
      const store = getAccountsStore();
      for (let n = 0; n < 500; n++) {
        const id = `founder-${n}`;
        await store.users.create({ id, email: `f${n}@spine.test`, passwordHash: 'x', createdAt: LONG_AGO, verifiedAt: LONG_AGO, consent: undefined });
        await store.billing.put({ user_id: id, provider: 'paddle', customer_id: null, subscription_id: `sub_f${n}`, interval: 'year', plan: 'premium', status: 'active', founding: true, current_period_end: null, cancel_scheduled: false, updated_at: LONG_AGO });
      }
      expect((await get('/api/pricing', {})).json().founding_left).toBe(0);
      const fetchMock = stubProvider({ data: { checkout: { url: 'https://pay.spine.example/?_ptxn=txn_3' } } });
      await checkout('year');
      expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).items[0].price_id).toBe('pri_year');
    });

    it('does not sell a second plan to an account that has one, and says so when the provider is down', async () => {
      on();
      stubProvider({}, 500);
      expect((await checkout('month')).statusCode).toBe(502);
      const user = await createTestUser('twice@spine.test');
      await getAccountsStore().billing.put({ user_id: user.id, provider: 'paddle', customer_id: 'ctm_t', subscription_id: 'sub_t', interval: 'month', plan: 'premium', status: 'active', founding: false, current_period_end: null, cancel_scheduled: false, updated_at: LONG_AGO });
      const res = await checkout('month', { cookie: await loginAs(app, user.email, user.password) });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('already_subscribed');
    });

    it('opens the provider’s page for managing it, for an account that has paid', async () => {
      on();
      expect((await app.inject({ method: 'POST', url: '/api/billing/portal', headers: { cookie } })).statusCode).toBe(404);
      const fetchMock = stubProvider({ data: { urls: { general: { overview: 'https://customer-portal.paddle.com/cpl_1' } } } });
      const user = await createTestUser('manager@spine.test');
      await getAccountsStore().billing.put({ user_id: user.id, provider: 'paddle', customer_id: 'ctm_m', subscription_id: 'sub_m', interval: 'year', plan: 'premium', status: 'active', founding: false, current_period_end: null, cancel_scheduled: false, updated_at: LONG_AGO });
      const res = await app.inject({ method: 'POST', url: '/api/billing/portal', headers: { cookie: await loginAs(app, user.email, user.password) } });
      expect(res.json()).toEqual({ url: 'https://customer-portal.paddle.com/cpl_1' });
      expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe('https://sandbox-api.paddle.com/customers/ctm_m/portal-sessions');
    });
  });

  describe('what the relay asks before and after a call', () => {
    const gate = () => createRelayGate(() => getAccountsStore());

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
      await getAccountsStore().usage.aiAdd(user.id, month, 30 * PAGE);
      expect(await gate().admit(user.id, 'extraction')).toMatchObject({ status: 402, code: 'allowance_used' });
    });

    it('stops everything the AI does when the trial’s 150 pages are used, translation and questions too', async () => {
      const user = await createTestUser('gate-cap@spine.test');
      await getAccountsStore().usage.aiAdd(user.id, 'trial', 150 * PAGE - 1);
      expect(await gate().admit(user.id, 'page')).toBeNull();
      await getAccountsStore().usage.aiAdd(user.id, 'trial', 1);
      for (const task of ['page', 'translation', 'chat'] as const) expect(await gate().admit(user.id, task), task).toMatchObject({ code: 'allowance_used' });
    });

    it('asks a share’s recipient nothing but the owner’s plan, and lets the demo through to its own counts', async () => {
      const free = await createTestUser('gate-share@spine.test', { createdAt: LONG_AGO });
      await getAccountsStore().shared.put(free.id, { id: 'share-gate', expiresAt: '2999-01-01T00:00:00.000Z', requireApproval: false, size: 1, blobs: 0, blobBytes: 0 }, LONG_AGO);
      expect(await gate().admit('share:share-gate', 'translation')).toMatchObject({ code: 'plan_required' });
      expect(await gate().admit('share:share-gate', 'extraction')).toBeNull();
      expect(await gate().admit('demo:abc', 'extraction')).toBeNull();
      await gate().settle('share:share-gate', 'translation', 5000);
      await gate().settle('demo:abc', 'extraction', 5000);
      expect(await getAccountsStore().usage.aiUsed(free.id, new Date().toISOString().slice(0, 7))).toBe(0);
    });
  });

  describe('sharing', () => {
    const put = (id: string, headers: Record<string, string>, who = cookie) => app.inject({
      method: 'PUT', url: `/api/shared/${id}`, payload: Buffer.from('sealed'),
      headers: { cookie: who, 'content-type': 'application/octet-stream', 'x-spine-expires': new Date(Date.now() + 86400e3).toISOString(), ...headers },
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

  describe('the family plan', () => {
    const FAMILY = { SPINE_PADDLE_PRICE_FAMILY_YEAR: 'pri_family_year', SPINE_PADDLE_PRICE_FAMILY_MONTH: 'pri_family_month' };

    it('is sold only when both its prices are named', () => {
      expect(loadBillingConfig(BILLING)).toMatchObject({ family: null });
      expect(loadBillingConfig({ ...BILLING, ...FAMILY })).toMatchObject({ family: { year: 'pri_family_year', month: 'pri_family_month' } });
      expect(() => loadBillingConfig({ ...BILLING, SPINE_PADDLE_PRICE_FAMILY_YEAR: 'pri_family_year' })).toThrow(/both SPINE_PADDLE_PRICE_FAMILY_YEAR and SPINE_PADDLE_PRICE_FAMILY_MONTH/);
    });

    it('is offered on the pricing page and the account page only where it is sold', async () => {
      on();
      expect((await get('/api/pricing', {})).json()).toMatchObject({ family: false, prices: { family: { year: 79, month: 7.99 } } });
      Object.assign(process.env, FAMILY);
      expect((await get('/api/pricing', {})).json().family).toBe(true);
      expect((await get('/api/billing')).json()).toMatchObject({ family: true, people: { limit: 6 } });
    });

    it('opens a checkout at the family price, with no founding price, and refuses it where it is not sold', async () => {
      on();
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: { checkout: { url: 'https://pay.spine.example/?_ptxn=txn_f' } } }), { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);
      const user = await createTestUser('family-buyer@spine.test');
      const who = await loginAs(app, user.email, user.password);
      const ask = (plan: string, interval: string) => app.inject({ method: 'POST', url: '/api/billing/checkout', headers: { cookie: who }, payload: { plan, interval } });
      const refused = await ask('family', 'year');
      expect(refused.statusCode).toBe(400);
      expect(refused.json().code).toBe('plan_not_offered');
      Object.assign(process.env, FAMILY);
      expect((await ask('family', 'year')).statusCode).toBe(200);
      expect((await ask('family', 'month')).statusCode).toBe(200);
      const prices = fetchMock.mock.calls.map(c => JSON.parse((c as unknown as [string, RequestInit])[1].body as string).items[0].price_id);
      expect(prices).toEqual(['pri_family_year', 'pri_family_month']);
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

  it('counts a trial of six months', () => {
    expect(TRIAL_MONTHS).toBe(6);
    expect(TEST_PASSWORD).toBeTruthy();
  });
});

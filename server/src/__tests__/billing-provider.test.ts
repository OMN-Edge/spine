import { afterEach, describe, it, expect, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { ConfigError } from 'spine-core/config.js';
import { readBillingConfig } from '../billing/config.js';
import { billingProvider, type BillingProvider, type Enabled } from '../billing/provider.js';

/**
 * What every payment provider's adapter must do, whoever it is: refuse a delivery that is not signed or not a message, say what a subscription
 * message and a completed payment mean in Spine's words, and ignore the rest without failing. A new adapter is added to `ADAPTERS` with its own
 * deliveries and passes the same tests.
 */
interface Delivery { headers: Record<string, string>; body: string }
interface Adapter {
  name: string;
  env: Record<string, string>;
  /** The id a completed payment is applied by (Paddle's transaction, Stripe's checkout session). */
  transactionId: string;
  /** Stands in for what the adapter asks of the provider's own API while it reads a delivery, if anything. */
  prepare?: () => void;
  /** A delivery of each kind as the provider sends it, with the headers that sign it. */
  deliver(kind: 'subscription' | 'payment' | 'other' | 'unsigned' | 'wrong-secret' | 'not-json'): Delivery;
}

const PADDLE_SECRET = 'whsec_contract_test_secret';
const sign = (body: string, secret = PADDLE_SECRET, ts = Math.floor(Date.now() / 1000)) => `ts=${ts};h1=${createHmac('sha256', secret).update(`${ts}:${body}`).digest('hex')}`;
const paddleBody = (type: string, data: Record<string, unknown>) => JSON.stringify({ event_id: `evt_${type}`, event_type: type, occurred_at: '2026-03-04T05:06:07.000Z', data });

const ADAPTERS: Adapter[] = [{
  name: 'paddle',
  transactionId: 'txn_1',
  env: {
    SPINE_BILLING: 'on', PADDLE_ENVIRONMENT: 'sandbox', PADDLE_API_KEY: 'pdl_test_key', PADDLE_WEBHOOK_SECRET: PADDLE_SECRET, SPINE_CHECKOUT_URL: 'https://pay.spine.example/',
    SPINE_PADDLE_PRICE_YEAR: 'pri_year', SPINE_PADDLE_PRICE_MONTH: 'pri_month', SPINE_PADDLE_PRICE_FOUNDING: 'pri_founding',
  },
  deliver(kind): Delivery {
    const subscription = paddleBody('subscription.updated', {
      id: 'sub_1', status: 'active', customer_id: 'ctm_1', custom_data: { user_id: 'user-1' }, items: [{ price: { id: 'pri_month' } }], billing_cycle: { interval: 'month' },
      current_billing_period: { ends_at: '2026-04-04T05:06:07Z' }, scheduled_change: { action: 'cancel' },
    });
    const payment = paddleBody('transaction.completed', { id: 'txn_1', subscription_id: 'sub_1', customer_id: 'ctm_1', custom_data: { user_id: 'user-1' }, items: [{ price: { id: 'pri_year' } }] });
    const other = paddleBody('customer.created', { id: 'ctm_9' });
    switch (kind) {
      case 'subscription': return { headers: { 'paddle-signature': sign(subscription) }, body: subscription };
      case 'payment': return { headers: { 'paddle-signature': sign(payment) }, body: payment };
      case 'other': return { headers: { 'paddle-signature': sign(other) }, body: other };
      case 'unsigned': return { headers: {}, body: subscription };
      case 'wrong-secret': return { headers: { 'paddle-signature': sign(subscription, 'someone_elses_secret') }, body: subscription };
      case 'not-json': return { headers: { 'paddle-signature': sign('not json') }, body: 'not json' };
    }
  },
}, (() => {
  const SECRET = 'whsec_contract_test_stripe_secret';
  const unix = (iso: string) => Math.floor(Date.parse(iso) / 1000);
  const stripeSign = (body: string, secret = SECRET, ts = Math.floor(Date.now() / 1000)) => `t=${ts},v1=${createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}`;
  const body = (type: string, object: Record<string, unknown>) => JSON.stringify({ id: `evt_${type}`, object: 'event', type, created: unix('2026-03-04T05:06:07.000Z'), data: { object } });
  return {
    name: 'stripe',
    transactionId: 'cs_1',
    env: {
      SPINE_BILLING: 'on', SPINE_BILLING_PROVIDER: 'stripe', STRIPE_SECRET_KEY: 'sk_test_contract', STRIPE_WEBHOOK_SECRET: SECRET,
      SPINE_STRIPE_PRICE_YEAR: 'pri_year', SPINE_STRIPE_PRICE_MONTH: 'pri_month', SPINE_STRIPE_PRICE_FOUNDING: 'pri_founding',
    },
    // A completed Checkout Session does not carry its line items: the adapter asks for them, and the prices on them are what count.
    prepare: () => { vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ object: 'list', data: [{ price: { id: 'pri_year' } }] })))); },
    deliver(kind): Delivery {
      const subscription = body('customer.subscription.updated', {
        id: 'sub_1', status: 'active', customer: 'ctm_1', metadata: { user_id: 'user-1' }, cancel_at_period_end: true,
        items: { data: [{ price: { id: 'pri_month', recurring: { interval: 'month' } }, current_period_end: unix('2026-04-04T05:06:07Z') }] },
      });
      const payment = body('checkout.session.completed', { id: 'cs_1', mode: 'subscription', payment_status: 'paid', client_reference_id: 'user-1', customer: 'ctm_1', subscription: 'sub_1' });
      const other = body('customer.created', { id: 'cus_9' });
      switch (kind) {
        case 'subscription': return { headers: { 'stripe-signature': stripeSign(subscription) }, body: subscription };
        case 'payment': return { headers: { 'stripe-signature': stripeSign(payment) }, body: payment };
        case 'other': return { headers: { 'stripe-signature': stripeSign(other) }, body: other };
        case 'unsigned': return { headers: {}, body: subscription };
        case 'wrong-secret': return { headers: { 'stripe-signature': stripeSign(subscription, 'someone_elses_secret') }, body: subscription };
        case 'not-json': return { headers: { 'stripe-signature': stripeSign('not json') }, body: 'not json' };
      }
    },
  } satisfies Adapter;
})()];

const providerOf = (adapter: Adapter): { provider: BillingProvider; config: Enabled } => {
  const problems: string[] = [];
  const config = readBillingConfig(adapter.env, 'public', problems);
  expect(problems).toEqual([]);
  if (!config.enabled) throw new Error('billing is not on');
  return { provider: billingProvider(config), config };
};

describe.each(ADAPTERS)('the $name adapter', adapter => {
  const { provider, config } = providerOf(adapter);
  afterEach(() => { vi.unstubAllGlobals(); });
  const read = async (kind: Parameters<Adapter['deliver']>[0]) => { adapter.prepare?.(); const d = adapter.deliver(kind); return provider.readWebhook(d.headers, d.body); };

  it('is the provider the settings name', () => {
    expect(provider.id).toBe(config.provider);
  });

  it('refuses a delivery with no signature, or one made with another secret, or one that is signed but is not a message', async () => {
    expect(await read('unsigned')).toEqual({ ok: false, status: 401, error: 'bad signature' });
    expect(await read('wrong-secret')).toEqual({ ok: false, status: 401, error: 'bad signature' });
    expect(await read('not-json')).toEqual({ ok: false, status: 400, error: 'not an event' });
  });

  it('says what a subscription message means: who, which subscription, which prices, how long it is paid for and whether it will end', async () => {
    const out = await read('subscription');
    expect(out).toMatchObject({ ok: true, event: { kind: 'subscription', userId: 'user-1', subscriptionId: 'sub_1', customerId: 'ctm_1', status: 'active', priceIds: ['pri_month'], interval: 'month', cancelScheduled: true } });
    if (out.ok && out.event.kind === 'subscription') {
      expect(out.event.id).toBeTruthy();
      expect(out.event.at).toBe('2026-03-04T05:06:07.000Z');
      expect(out.event.periodEnd).toBe('2026-04-04T05:06:07.000Z');
    }
  });

  it('says what a completed payment means: who paid, for which subscription, which prices, and the payment\'s own id', async () => {
    expect(await read('payment')).toMatchObject({ ok: true, event: { kind: 'payment', userId: 'user-1', subscriptionId: 'sub_1', customerId: 'ctm_1', transactionId: adapter.transactionId, priceIds: ['pri_year'] } });
  });

  it('acknowledges anything else without failing, and says it changes nothing', async () => {
    const out = await read('other');
    expect(out).toMatchObject({ ok: true, event: { kind: 'ignored' } });
    if (out.ok) expect(out.event.id).toBeTruthy();
  });
});

describe('choosing the provider', () => {
  const env = ADAPTERS[0]!.env;
  const stripeEnv = ADAPTERS[1]!.env;

  it('is paddle when nothing is said, and an unknown name stops the start rather than being guessed', () => {
    const none: string[] = [];
    const config = readBillingConfig(env, 'public', none);
    expect(none).toEqual([]);
    expect(config).toMatchObject({ enabled: true, provider: 'paddle' });

    const unknown: string[] = [];
    readBillingConfig({ ...env, SPINE_BILLING_PROVIDER: 'cheques' }, 'public', unknown);
    expect(unknown).toContain('SPINE_BILLING_PROVIDER is "cheques"; expected paddle or stripe');
    expect(() => { if (unknown.length) throw new ConfigError(unknown); }).toThrow(/SPINE_BILLING_PROVIDER/);
  });

  it('is stripe when it is said, and each provider has its own settings', () => {
    const none: string[] = [];
    expect(readBillingConfig(stripeEnv, 'public', none)).toMatchObject({ enabled: true, provider: 'stripe', environment: 'sandbox', checkoutUrl: null, prices: { year: 'pri_year', month: 'pri_month', founding: 'pri_founding' } });
    expect(none).toEqual([]);
    // Paddle's settings do not stand in for Stripe's, nor the other way round.
    const missing: string[] = [];
    readBillingConfig({ SPINE_BILLING: 'on', SPINE_BILLING_PROVIDER: 'stripe', PADDLE_API_KEY: 'x', PADDLE_WEBHOOK_SECRET: 'y', SPINE_PADDLE_PRICE_YEAR: 'p' }, 'public', missing);
    expect(missing).toEqual(expect.arrayContaining(['SPINE_BILLING=on needs STRIPE_SECRET_KEY', 'SPINE_BILLING=on needs STRIPE_WEBHOOK_SECRET', 'SPINE_BILLING=on needs SPINE_STRIPE_PRICE_YEAR']));
  });
});

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { useSettings } from 'spine-core/config.js';
import { readBillingConfig } from '../billing/config.js';
import { billingProvider, type Enabled } from '../billing/provider.js';
import { STRIPE_VERSION, verifySignature } from 'spine-billing/providers/stripe.js';
import { withdrawalConsent } from '../billing/provider.js';

/**
 * What is particular to Stripe, on top of what every adapter does (`billing-provider.test.ts`): how a delivery is signed, how Stripe's statuses and the end
 * of a period are read (the end moved from the subscription to its items in 2025), and the requests that start a checkout, open the portal and read a price.
 */
const SECRET = 'whsec_stripe_particulars';
// Built from parts: a Stripe-shaped key written out is what a secret scanner exists to find, and this one is made up (the adapter reads the mode from the prefix, so it must have one).
const KEY = ['sk', 'test', 'particulars'].join('_');
const ENV = {
  SPINE_BILLING: 'on', SPINE_BILLING_PROVIDER: 'stripe', STRIPE_SECRET_KEY: KEY, STRIPE_WEBHOOK_SECRET: SECRET,
  SPINE_STRIPE_PRICE_YEAR: 'pri_year', SPINE_STRIPE_PRICE_MONTH: 'pri_month', SPINE_STRIPE_PRICE_FOUNDING: 'pri_founding', SPINE_STRIPE_PRICE_TOPUP_PAGES: 'pri_topup',
};
const unix = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const sign = (body: string, secret = SECRET, ts = Math.floor(Date.now() / 1000)) => `t=${ts},v1=${createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}`;
const body = (type: string, object: Record<string, unknown>) => JSON.stringify({ id: `evt_${type}`, object: 'event', type, created: unix('2026-03-04T05:06:07Z'), data: { object } });

const config = (() => { const problems: string[] = []; const c = readBillingConfig(ENV, 'public', problems); expect(problems).toEqual([]); return c as Enabled; })();
const provider = billingProvider(config);
const read = (type: string, object: Record<string, unknown>) => { const b = body(type, object); return provider.readWebhook({ 'stripe-signature': sign(b) }, b); };
const subscription = (extra: Record<string, unknown> = {}) => ({
  id: 'sub_1', status: 'active', customer: 'cus_1', metadata: { user_id: 'user-1' },
  items: { data: [{ price: { id: 'pri_month', recurring: { interval: 'month' } }, current_period_end: unix('2026-04-04T05:06:07Z') }] }, ...extra,
});

beforeAll(() => { useSettings({ ...process.env, SPINE_DOMAIN: 'spine.example.org' } as never); });
afterEach(() => { vi.unstubAllGlobals(); });

/** Stripe's API, as far as the adapter asks it: records each request and answers in turn. */
function stripeApi(...answers: Array<{ status?: number; json: unknown }>) {
  let i = 0;
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; form: URLSearchParams }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string }) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', headers: init.headers ?? {}, form: new URLSearchParams(init.body ?? '') });
    const a = answers[Math.min(i++, answers.length - 1)]!;
    return new Response(JSON.stringify(a.json), { status: a.status ?? 200 });
  }));
  return calls;
}

describe('the signature', () => {
  const raw = '{"id":"evt_1"}';
  const now = Date.now();
  const good = (ts = Math.floor(now / 1000)) => createHmac('sha256', SECRET).update(`${ts}.${raw}`).digest('hex');

  it('is checked over the raw body under the endpoint\'s secret, with the timestamp inside it', () => {
    const ts = Math.floor(now / 1000);
    expect(verifySignature(SECRET, `t=${ts},v1=${good()}`, raw, now)).toBe(true);
    expect(verifySignature('another', `t=${ts},v1=${good()}`, raw, now)).toBe(false);
    expect(verifySignature(SECRET, `t=${ts},v1=${good()}`, `${raw} `, now)).toBe(false);
    // The timestamp is signed: moving it breaks the signature.
    expect(verifySignature(SECRET, `t=${ts + 1},v1=${good()}`, raw, now)).toBe(false);
  });

  it('takes any one of several signatures, and entries it does not know, as Stripe says it will send them', () => {
    const ts = Math.floor(now / 1000);
    expect(verifySignature(SECRET, `t=${ts},v0=abc,v1=${'0'.repeat(64)},v1=${good()},payload=a25aefc6,destination=we_1`, raw, now)).toBe(true);
    expect(verifySignature(SECRET, `t=${ts},v0=${good()}`, raw, now)).toBe(false);
    expect(verifySignature(SECRET, `t=${ts}`, raw, now)).toBe(false);
    expect(verifySignature(SECRET, `v1=${good()}`, raw, now)).toBe(false);
    expect(verifySignature(SECRET, undefined, raw, now)).toBe(false);
  });

  it('is refused when the timestamp is more than five minutes from the clock, either way', () => {
    for (const ts of [Math.floor(now / 1000) - 6 * 60, Math.floor(now / 1000) + 6 * 60]) expect(verifySignature(SECRET, `t=${ts},v1=${good(ts)}`, raw, now)).toBe(false);
    const ts = Math.floor(now / 1000) - 4 * 60;
    expect(verifySignature(SECRET, `t=${ts},v1=${good(ts)}`, raw, now)).toBe(true);
  });
});

describe('what a subscription message means', () => {
  it('reads the end of what is paid for from the items, from the earliest of them, and from the subscription where it is not on the items', async () => {
    const items = { data: [
      { price: { id: 'pri_month', recurring: { interval: 'month' } }, current_period_end: unix('2026-05-04T00:00:00Z') },
      { price: { id: 'pri_month', recurring: { interval: 'month' } }, current_period_end: unix('2026-04-04T00:00:00Z') },
    ] };
    expect(await read('customer.subscription.updated', subscription({ items }))).toMatchObject({ ok: true, event: { periodEnd: '2026-04-04T00:00:00.000Z' } });
    const legacy = subscription({ items: { data: [{ price: { id: 'pri_month', recurring: { interval: 'month' } } }] }, current_period_end: unix('2026-06-01T00:00:00Z') });
    expect(await read('customer.subscription.updated', legacy)).toMatchObject({ ok: true, event: { periodEnd: '2026-06-01T00:00:00.000Z', priceIds: ['pri_month'], interval: 'month' } });
  });

  it('turns Stripe\'s statuses into the ones Spine knows: late stays late, an end at once is an end, and a first payment not made is not a subscription yet', async () => {
    const status = async (s: string, type = 'customer.subscription.updated') => { const out = await read(type, subscription({ status: s })); return out.ok ? (out.event.kind === 'subscription' ? out.event.status : out.event.kind) : out.error; };
    expect(await status('active')).toBe('active');
    expect(await status('trialing')).toBe('trialing');
    expect(await status('past_due')).toBe('past_due');
    expect(await status('paused')).toBe('paused');
    expect(await status('canceled', 'customer.subscription.deleted')).toBe('canceled');
    expect(await status('unpaid')).toBe('canceled');
    expect(await status('incomplete_expired')).toBe('canceled');
    expect(await status('incomplete')).toBe('ignored');
  });

  it('says the plan will end when Stripe is told to end it at the period\'s end or on a date, and that a cancelled one has ended', async () => {
    const cancel = async (extra: Record<string, unknown>, type = 'customer.subscription.updated') => { const out = await read(type, subscription(extra)); return out.ok && out.event.kind === 'subscription' ? out.event.cancelScheduled : null; };
    expect(await cancel({})).toBe(false);
    expect(await cancel({ cancel_at_period_end: true })).toBe(true);
    expect(await cancel({ cancel_at: unix('2026-07-01T00:00:00Z') })).toBe(true);
    expect(await cancel({ status: 'canceled' }, 'customer.subscription.deleted')).toBe(true);
  });

  it('takes the customer bare or expanded, and the account only as a bounded string', async () => {
    expect(await read('customer.subscription.updated', subscription({ customer: { id: 'cus_expanded' } }))).toMatchObject({ ok: true, event: { customerId: 'cus_expanded' } });
    expect(await read('customer.subscription.updated', subscription({ metadata: { user_id: 'x'.repeat(65) } }))).toMatchObject({ ok: true, event: { userId: null } });
    expect(await read('customer.subscription.updated', subscription({ metadata: {} }))).toMatchObject({ ok: true, event: { userId: null } });
  });

  it('knows no other subscription event: a reminder that a trial is ending changes nothing', async () => {
    expect(await read('customer.subscription.trial_will_end', subscription())).toMatchObject({ ok: true, event: { kind: 'ignored' } });
  });
});

describe('what a completed checkout means', () => {
  it('asks Stripe for the line items, since the message does not carry them, and applies a thing bought once by the session', async () => {
    const calls = stripeApi({ json: { object: 'list', data: [{ price: { id: 'pri_topup' } }] } });
    const out = await read('checkout.session.completed', { id: 'cs_topup', mode: 'payment', payment_status: 'paid', client_reference_id: 'user-1', customer: 'cus_1', subscription: null });
    expect(out).toMatchObject({ ok: true, event: { kind: 'payment', userId: 'user-1', subscriptionId: null, customerId: 'cus_1', transactionId: 'cs_topup', priceIds: ['pri_topup'] } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.stripe.com/v1/checkout/sessions/cs_topup/line_items?limit=10');
    expect(calls[0]!.headers).toMatchObject({ authorization: `Bearer ${KEY}`, 'stripe-version': STRIPE_VERSION });
  });

  it('does not count a session whose money has not arrived, and asks nothing of Stripe for it', async () => {
    const calls = stripeApi({ json: { data: [] } });
    expect(await read('checkout.session.completed', { id: 'cs_late', mode: 'payment', payment_status: 'unpaid', client_reference_id: 'user-1' })).toMatchObject({ ok: true, event: { kind: 'ignored' } });
    expect(calls).toHaveLength(0);
  });
});

describe('starting a checkout', () => {
  it('opens a subscription on Stripe\'s own page, naming the account on the session and on the subscription, and coming back to the account page', async () => {
    const calls = stripeApi({ json: { url: 'https://checkout.stripe.com/c/pay/cs_test_1' } });
    expect(await provider.createCheckout('pri_year', 'user-1', undefined, { customerId: null, email: 'someone@example.test' })).toBe('https://checkout.stripe.com/c/pay/cs_test_1');
    const call = calls[0]!;
    expect(call.url).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect(call.method).toBe('POST');
    expect(call.headers).toMatchObject({ authorization: `Bearer ${KEY}`, 'stripe-version': STRIPE_VERSION, 'content-type': 'application/x-www-form-urlencoded' });
    expect(Object.fromEntries(call.form)).toEqual({
      mode: 'subscription', 'line_items[0][price]': 'pri_year', 'line_items[0][quantity]': '1', client_reference_id: 'user-1',
      success_url: 'https://spine.example.org/account', cancel_url: 'https://spine.example.org/account', billing_address_collection: 'required',
      'subscription_data[metadata][user_id]': 'user-1', customer_email: 'someone@example.test',
      'consent_collection[terms_of_service]': 'required', 'custom_text[terms_of_service_acceptance][message]': withdrawalConsent('en'),
    });
  });

  it('asks the buyer to tick that the service starts now and that the right of withdrawal ends once it is provided, in the buyer’s language, linking the terms and the refund policy', async () => {
    expect(withdrawalConsent('en')).toContain('I lose my right of withdrawal once it has been fully provided');
    expect(withdrawalConsent('en')).toContain('(https://spine.example.org/terms)');
    expect(withdrawalConsent('en')).toContain('(https://spine.example.org/refunds)');
    expect(withdrawalConsent('ro')).toContain('dreptul de retragere');
    expect(withdrawalConsent('fr')).toContain('droit de rétractation');
    expect(withdrawalConsent('de')).toContain('Widerrufsrecht');
    for (const lang of ['ro', 'fr', 'de'] as const) expect(withdrawalConsent(lang)).not.toBe(withdrawalConsent('en'));
    for (const language of ['ro', 'fr', 'de', 'en']) {
      const calls = stripeApi({ json: { url: 'https://checkout.stripe.com/c/pay/cs_test_3' } });
      await provider.createCheckout('pri_year', 'user-1', undefined, { customerId: null, email: 'someone@example.test', language });
      expect(calls[0]!.form.get('locale'), language).toBe(language);
      expect(calls[0]!.form.get('custom_text[terms_of_service_acceptance][message]'), language).toBe(withdrawalConsent(language as 'en'));
    }
    // A language the screens are not written in gets English words, and the page's own language.
    const other = stripeApi({ json: { url: 'https://checkout.stripe.com/c/pay/cs_test_4' } });
    await provider.createCheckout('pri_year', 'user-1', undefined, { customerId: null, email: 'someone@example.test', language: 'it' });
    expect(other[0]!.form.get('custom_text[terms_of_service_acceptance][message]')).toBe(withdrawalConsent('en'));
    expect(other[0]!.form.has('locale')).toBe(false);
  });

  it('buys as the customer the account already has, and a thing bought once is a payment that says what it is for', async () => {
    const calls = stripeApi({ json: { url: 'https://checkout.stripe.com/c/pay/cs_test_2' } });
    await provider.createCheckout('pri_topup', 'user-1', 'page_topup', { customerId: 'cus_known', email: 'someone@example.test' });
    expect(Object.fromEntries(calls[0]!.form)).toMatchObject({ mode: 'payment', customer: 'cus_known', 'metadata[user_id]': 'user-1', 'metadata[addon]': 'page_topup', 'line_items[0][price]': 'pri_topup' });
    expect(calls[0]!.form.has('customer_email')).toBe(false);
    expect(calls[0]!.form.has('subscription_data[metadata][user_id]')).toBe(false);
  });

  it('says the provider could not be reached with Stripe\'s code and never its message, and refuses an address that is not https', async () => {
    stripeApi({ status: 400, json: { error: { code: 'resource_missing', message: 'No such price: pri_year for someone@example.test' } } });
    await expect(provider.createCheckout('pri_year', 'user-1')).rejects.toThrow(/^the payment provider answered 400 \(resource_missing\)$/);
    stripeApi({ json: { url: 'http://insecure.example/x' } });
    await expect(provider.createCheckout('pri_year', 'user-1')).rejects.toThrow(/no checkout address/);
  });
});

describe('opening the portal', () => {
  const session = { json: { url: 'https://billing.stripe.com/p/session/test_1' } };

  it('opens on cancelling the subscription, or on the card, and comes back to the account page', async () => {
    const calls = stripeApi(session);
    expect(await provider.manageUrl('cus_1', 'sub_1', 'cancel')).toBe('https://billing.stripe.com/p/session/test_1');
    expect(Object.fromEntries(calls[0]!.form)).toEqual({ customer: 'cus_1', return_url: 'https://spine.example.org/account', 'flow_data[type]': 'subscription_cancel', 'flow_data[subscription_cancel][subscription]': 'sub_1' });
    await provider.manageUrl('cus_1', 'sub_1', 'payment_method');
    expect(Object.fromEntries(calls[1]!.form)).toEqual({ customer: 'cus_1', return_url: 'https://spine.example.org/account', 'flow_data[type]': 'payment_method_update' });
    await provider.manageUrl('cus_1', 'sub_1', 'overview');
    expect(Object.fromEntries(calls[2]!.form)).toEqual({ customer: 'cus_1', return_url: 'https://spine.example.org/account' });
    expect(calls.every(c => c.url === 'https://api.stripe.com/v1/billing_portal/sessions')).toBe(true);
  });

  it('opens the overview where Stripe refuses the action (the portal\'s settings do not allow it), so a person is never sent nowhere', async () => {
    const calls = stripeApi({ status: 400, json: { error: { code: 'parameter_invalid_empty' } } }, session);
    expect(await provider.manageUrl('cus_1', 'sub_1', 'cancel')).toBe('https://billing.stripe.com/p/session/test_1');
    expect(calls).toHaveLength(2);
    expect(calls[0]!.form.get('flow_data[type]')).toBe('subscription_cancel');
    expect(calls[1]!.form.has('flow_data[type]')).toBe(false);
    // The overview failing is a failure.
    stripeApi({ status: 400, json: { error: { code: 'resource_missing' } } });
    await expect(provider.manageUrl('cus_1', 'sub_1', 'overview')).rejects.toThrow(/answered 400/);
  });
});

describe('reading a price', () => {
  it('gives the amount in the major unit, the currency and how often it repeats', async () => {
    stripeApi({ json: { id: 'pri_year', active: true, unit_amount: 2490, currency: 'eur', recurring: { interval: 'year' }, product: 'prod_main' } });
    expect(await provider.readPrice('pri_year')).toEqual({ amount: 24.9, currency: 'EUR', interval: 'year', productId: 'prod_main' });
    stripeApi({ json: { id: 'pri_topup', active: true, unit_amount: 1999, currency: 'eur', recurring: null } });
    expect(await provider.readPrice('pri_topup')).toEqual({ amount: 19.99, currency: 'EUR', interval: null, productId: null });
    stripeApi({ json: { id: 'pri_yen', active: true, unit_amount: 500, currency: 'jpy', recurring: null } });
    expect(await provider.readPrice('pri_yen')).toMatchObject({ amount: 500, currency: 'JPY' });
  });

  it('shows no price that is archived, has no single amount, or Stripe does not know', async () => {
    stripeApi({ json: { id: 'p', active: false, unit_amount: 100, currency: 'eur' } });
    await expect(provider.readPrice('p')).rejects.toThrow(/cannot be shown/);
    stripeApi({ json: { id: 'p', active: true, unit_amount: null, currency: 'eur' } });
    await expect(provider.readPrice('p')).rejects.toThrow(/cannot be shown/);
    stripeApi({ status: 404, json: { error: { code: 'resource_missing' } } });
    await expect(provider.readPrice('p')).rejects.toThrow(/\(resource_missing\)/);
  });
});

describe('the settings', () => {
  it('say which mode the key is for, and refuse a key that is neither', () => {
    const mode = (key: string) => { const problems: string[] = []; const c = readBillingConfig({ ...ENV, STRIPE_SECRET_KEY: key }, 'public', problems); return { problems, environment: c.enabled ? c.environment : null }; };
    expect(mode('sk_test_abc')).toMatchObject({ environment: 'sandbox', problems: [] });
    expect(mode('rk_test_abc')).toMatchObject({ environment: 'sandbox', problems: [] });
    expect(mode('sk_live_abc')).toMatchObject({ environment: 'production', problems: [] });
    expect(mode('rk_live_abc')).toMatchObject({ environment: 'production', problems: [] });
    expect(mode('pk_test_abc').problems).toEqual(['STRIPE_SECRET_KEY must be a Stripe secret or restricted key (sk_test_, rk_test_, sk_live_ or rk_live_)']);
  });
});

describe('a payment the operator invoices', () => {
  it('names the session as the sale where something was paid, and no sale where nothing was', async () => {
    stripeApi({ json: { object: 'list', data: [{ price: { id: 'pri_year' } }] } });
    expect(await read('checkout.session.completed', { id: 'cs_paid', mode: 'subscription', payment_status: 'paid', amount_total: 4900, client_reference_id: 'user-1', subscription: 'sub_1' })).toMatchObject({ ok: true, event: { kind: 'payment', saleRef: 'cs_paid' } });
    stripeApi({ json: { object: 'list', data: [{ price: { id: 'pri_year' } }] } });
    expect(await read('checkout.session.completed', { id: 'cs_free', mode: 'subscription', payment_status: 'no_payment_required', amount_total: 0, client_reference_id: 'user-1', subscription: 'sub_1' })).toMatchObject({ ok: true, event: { kind: 'payment', saleRef: null } });
  });

  it('takes a renewal from its invoice, whichever way the API version names the subscription, and not the first invoice of a subscription or one of nothing', async () => {
    const invoice = (extra: Record<string, unknown> = {}) => ({ id: 'in_1', billing_reason: 'subscription_cycle', amount_paid: 4900, customer: 'cus_1', subscription: 'sub_1', lines: { data: [{ price: { id: 'pri_year' } }] }, ...extra });
    expect(await read('invoice.paid', invoice())).toMatchObject({ ok: true, event: { kind: 'payment', saleRef: 'in_1', transactionId: 'in_1', subscriptionId: 'sub_1', customerId: 'cus_1', priceIds: ['pri_year'], userId: null } });
    const newer = invoice({ subscription: undefined, parent: { subscription_details: { subscription: 'sub_2', metadata: { user_id: 'user-9' } } }, lines: { data: [{ pricing: { price_details: { price: 'pri_month' } } }] } });
    expect(await read('invoice.paid', newer)).toMatchObject({ ok: true, event: { kind: 'payment', subscriptionId: 'sub_2', userId: 'user-9', priceIds: ['pri_month'] } });
    expect(await read('invoice.paid', invoice({ billing_reason: 'subscription_create' }))).toMatchObject({ ok: true, event: { kind: 'ignored' } });
    expect(await read('invoice.paid', invoice({ amount_paid: 0 }))).toMatchObject({ ok: true, event: { kind: 'ignored' } });
  });

  const details = { name: 'Eva Test', email: 'eva@spine.test', address: { country: 'fr', city: 'Paris', state: 'Ile-de-France', line1: '1 Rue Test', line2: null }, tax_ids: [{ value: 'FR123' }] };

  it('reads a checkout session’s buyer and lines as the buyer paid them', async () => {
    const calls = stripeApi({ json: { id: 'cs_1', currency: 'eur', created: unix('2026-03-04T05:06:07Z'), customer_details: details, line_items: { data: [{ description: 'Spine Premium', amount_total: 4900, quantity: 1 }, { description: 'free thing', amount_total: 0, quantity: 1 }] } } });
    expect(await provider.readSale('cs_1')).toEqual({
      paidAt: '2026-03-04T05:06:07.000Z', currency: 'EUR', lines: [{ name: 'Spine Premium', amountMinor: 4900, quantity: 1 }],
      buyer: { name: 'Eva Test', email: 'eva@spine.test', country: 'FR', city: 'Paris', region: 'Ile-de-France', address: '1 Rue Test', taxId: 'FR123' },
    });
    expect(calls[0]!.url).toBe('https://api.stripe.com/v1/checkout/sessions/cs_1?expand%5B0%5D=line_items');
  });

  it('reads a renewal’s buyer and lines from its invoice, and the day it was paid', async () => {
    stripeApi({ json: { id: 'in_1', currency: 'eur', created: unix('2026-03-01T00:00:00Z'), status_transitions: { paid_at: unix('2026-03-04T05:06:07Z') }, customer_name: 'Eva Test', customer_email: 'eva@spine.test', customer_address: { country: 'FR' }, customer_tax_ids: [], lines: { data: [{ description: 'Spine Premium', amount: 4900, quantity: 1 }] } } });
    expect(await provider.readSale('in_1')).toMatchObject({ paidAt: '2026-03-04T05:06:07.000Z', currency: 'EUR', buyer: { name: 'Eva Test', country: 'FR' }, lines: [{ amountMinor: 4900 }] });
  });

  it('names a renewal’s line by the product, as a checkout does, and not as Stripe words a subscription’s line', async () => {
    stripeApi({ json: { id: 'in_2', currency: 'eur', created: unix('2026-03-01T00:00:00Z'), customer_name: 'Eva Test', customer_email: 'eva@spine.test', customer_address: { country: 'FR' }, lines: { data: [{ description: '1 × Spine Premium (at €4.99 / month)', amount: 499, quantity: 1 }, { description: '3 × Spine page top-up (at €19.99 / one time)', amount: 5997, quantity: 3 }, { description: 'Credit', amount: 100, quantity: 1 }] } } });
    expect((await provider.readSale('in_2')).lines.map(l => l.name)).toEqual(['Spine Premium', 'Spine page top-up', 'Credit']);
  });

  it('refuses a payment with no buyer to invoice, and a reference it does not know', async () => {
    stripeApi({ json: { id: 'cs_2', currency: 'eur', customer_details: { name: null, email: 'a@b.test', address: { country: 'FR' } }, line_items: { data: [{ description: 'x', amount_total: 100, quantity: 1 }] } } });
    await expect(provider.readSale('cs_2')).rejects.toThrow(/no buyer/);
    await expect(provider.readSale('pi_1')).rejects.toThrow(/not a payment/);
  });
});

describe('the billing details as the Stripe customer', () => {
  const details = { name: 'Ana Test', country: 'RO', county: 'CJ', city: 'Cluj-Napoca', address: 'Str. Test 1', postalCode: '400440', taxId: 'RO12345678' } as const;

  it('makes the customer for the account, the county in the address’s state and the rest where Stripe has no place for it', async () => {
    const calls = stripeApi({ json: { id: 'cus_new' } });
    expect(await provider.saveBuyer({ userId: 'user-1', email: 'ana@spine.test', customerId: null, details })).toBe('cus_new');
    expect(calls[0]!.url).toBe('https://api.stripe.com/v1/customers');
    expect(Object.fromEntries(calls[0]!.form)).toMatchObject({
      name: 'Ana Test', email: 'ana@spine.test', 'address[line1]': 'Str. Test 1', 'address[city]': 'Cluj-Napoca', 'address[country]': 'RO', 'address[state]': 'CJ',
      'address[postal_code]': '400440', 'metadata[user_id]': 'user-1', 'metadata[tax_id]': 'RO12345678', 'metadata[sector]': '',
    });
  });

  it('changes the customer the account already has, and clears what is no longer given', async () => {
    const calls = stripeApi({ json: { id: 'cus_known' } });
    await provider.saveBuyer({ userId: 'user-1', email: 'ana@spine.test', customerId: 'cus_known', details: { name: 'Ana Test', country: 'FR', city: 'Lyon', address: '1 Rue' } });
    expect(calls[0]!.url).toBe('https://api.stripe.com/v1/customers/cus_known');
    expect(Object.fromEntries(calls[0]!.form)).toMatchObject({ 'address[state]': '', 'metadata[tax_id]': '' });
  });

  it('reads them back to fill the form, and says nothing of a customer that is not complete', async () => {
    stripeApi({ json: { id: 'cus_1', name: 'Ana Test', address: { line1: 'Str. Test 1', city: 'Cluj-Napoca', country: 'RO', state: 'CJ', postal_code: '400440' }, metadata: { tax_id: 'RO12345678' } } });
    expect(await provider.readBuyer('cus_1')).toEqual(details);
    // A customer a checkout made has an address with no county: it is not details an invoice can be made from.
    stripeApi({ json: { id: 'cus_2', name: 'Ana Test', address: { line1: 'Str. Test 1', city: 'Cluj-Napoca', country: 'RO' }, metadata: {} } });
    expect(await provider.readBuyer('cus_2')).toBeNull();
  });

  it('has the checkout use the customer and not ask for an address again, and asks for one where the account gave none', async () => {
    const withDetails = stripeApi({ json: { url: 'https://checkout.stripe.com/c/pay/cs_1' } });
    await provider.createCheckout('pri_year', 'user-1', undefined, { customerId: 'cus_1', email: 'ana@spine.test', hasDetails: true });
    expect(withDetails[0]!.form.get('customer')).toBe('cus_1');
    expect(withDetails[0]!.form.has('billing_address_collection')).toBe(false);
    const without = stripeApi({ json: { url: 'https://checkout.stripe.com/c/pay/cs_2' } });
    await provider.createCheckout('pri_year', 'user-1', undefined, { customerId: null, email: 'ana@spine.test' });
    expect(without[0]!.form.get('billing_address_collection')).toBe('required');
  });

  it('invoices the customer’s details, county and sector and tax id included, and not what the page took for the address', async () => {
    const calls = stripeApi(
      { json: { id: 'cs_1', currency: 'eur', created: unix('2026-03-04T05:06:07Z'), customer: 'cus_1', customer_details: { name: 'x', email: 'x@y.test', address: { country: 'RO', city: 'x' } }, line_items: { data: [{ description: 'Spine Premium', amount_total: 4900, quantity: 1 }] } } },
      { json: { id: 'cus_1', name: 'Ana Test', email: 'ana@spine.test', address: { line1: 'Str. Test 1', city: 'București', country: 'RO', state: 'B' }, metadata: { sector: '3', tax_id: 'RO12345678' } } },
    );
    expect(await provider.readSale('cs_1')).toMatchObject({ buyer: { name: 'Ana Test', email: 'ana@spine.test', country: 'RO', region: 'B', sector: '3', city: 'București', address: 'Str. Test 1', taxId: 'RO12345678' } });
    expect(calls[1]!.url).toBe('https://api.stripe.com/v1/customers/cus_1');
  });

  it('does not hide a customer it could not read behind the page’s address, and uses the page’s only where the customer is gone', async () => {
    const session = { id: 'cs_3', currency: 'eur', created: unix('2026-03-04T05:06:07Z'), customer: 'cus_x', customer_details: { name: 'Eva Test', email: 'eva@spine.test', address: { country: 'FR', city: 'Paris' } }, line_items: { data: [{ description: 'Spine Premium', amount_total: 4900, quantity: 1 }] } };
    stripeApi({ json: session }, { status: 403, json: { error: { code: 'more_permissions_required' } } });
    await expect(provider.readSale('cs_3')).rejects.toThrow(/403 \(more_permissions_required\)/);
    stripeApi({ json: session }, { status: 404, json: { error: { code: 'resource_missing' } } });
    expect(await provider.readSale('cs_3')).toMatchObject({ buyer: { name: 'Eva Test', country: 'FR' } });
  });

  it('falls back to the page’s address where the customer has no details, as for a payment made before they were asked for', async () => {
    stripeApi(
      { json: { id: 'cs_2', currency: 'eur', created: unix('2026-03-04T05:06:07Z'), customer: 'cus_old', customer_details: { name: 'Eva Test', email: 'eva@spine.test', address: { country: 'FR', city: 'Paris' } }, line_items: { data: [{ description: 'Spine Premium', amount_total: 4900, quantity: 1 }] } } },
      { json: { id: 'cus_old', name: null, address: null, metadata: {} } },
    );
    expect(await provider.readSale('cs_2')).toMatchObject({ buyer: { name: 'Eva Test', country: 'FR', city: 'Paris' } });
  });
});

describe('a refund', () => {
  const charge = (extra: Record<string, unknown> = {}) => ({ id: 'ch_1', amount: 499, amount_refunded: 499, refunded: true, currency: 'eur', payment_intent: 'pi_1', ...extra });

  it('is traced to what was queued for the payment: the session of the payment intent, the sessions of the subscription its first invoice began, and the invoice', async () => {
    const calls = stripeApi(
      { json: { data: [] } },
      { json: { data: [{ invoice: 'in_1', payment: { payment_intent: 'pi_1' } }] } },
      { json: { id: 'in_1', billing_reason: 'subscription_create', subscription: 'sub_1' } },
      { json: { data: [{ id: 'cs_first' }] } },
    );
    expect(await read('charge.refunded', charge())).toMatchObject({ ok: true, event: { kind: 'refund', saleRefs: ['cs_first', 'in_1'], full: true, refundedMinor: 499, currency: 'EUR' } });
    expect(calls[0]!.url).toContain('/v1/checkout/sessions?payment_intent=pi_1');
    expect(calls[1]!.url).toContain('/v1/invoice_payments?payment%5Btype%5D=payment_intent&payment%5Bpayment_intent%5D=pi_1');
    expect(calls[3]!.url).toContain('/v1/checkout/sessions?subscription=sub_1');
  });

  it('is a renewal’s invoice alone, and a session alone for a thing bought once, and says when only part was refunded', async () => {
    stripeApi({ json: { data: [] } }, { json: { data: [{ invoice: 'in_9' }] } }, { json: { id: 'in_9', billing_reason: 'subscription_cycle', subscription: 'sub_1' } });
    expect(await read('charge.refunded', charge())).toMatchObject({ event: { saleRefs: ['in_9'] } });
    stripeApi({ json: { data: [{ id: 'cs_topup' }] } }, { json: { data: [] } });
    expect(await read('charge.refunded', charge({ amount_refunded: 100, refunded: false }))).toMatchObject({ event: { saleRefs: ['cs_topup'], full: false, refundedMinor: 100 } });
  });

  it('is nothing where no payment intent or nothing refunded is named', async () => {
    expect(await read('charge.refunded', charge({ payment_intent: null }))).toMatchObject({ event: { kind: 'ignored' } });
    expect(await read('charge.refunded', charge({ amount_refunded: 0, refunded: false }))).toMatchObject({ event: { kind: 'ignored' } });
  });
});

describe('a withdrawal paid back', () => {
  const answers = () => stripeApi(
    { json: { data: [{ id: 'in_1' }] } },
    { json: { data: [{ payment: { type: 'payment_intent', payment_intent: 'pi_1' } }] } },
    { json: { id: 'sub_1', status: 'canceled' } },
    { json: { id: 're_1', amount: 499, currency: 'eur' } },
  );

  it('ends the subscription first and then pays the last payment back, each once for the key, and says what was paid back', async () => {
    const calls = answers();
    expect(await provider.withdraw({ subscriptionId: 'sub_1', amountMinor: null, key: 'withdrawal:w1' })).toEqual({ refundedMinor: 499, currency: 'EUR' });
    expect(calls.map(c => `${c.method} ${new URL(c.url).pathname}`)).toEqual(['GET /v1/invoices', 'GET /v1/invoice_payments', 'DELETE /v1/subscriptions/sub_1', 'POST /v1/refunds']);
    expect(calls[0]!.url).toContain('subscription=sub_1&status=paid&limit=1');
    expect(Object.fromEntries(calls[2]!.form)).toEqual({ invoice_now: 'false', prorate: 'false' });
    expect(calls[2]!.headers['idempotency-key']).toBe('withdrawal:w1:end');
    expect(Object.fromEntries(calls[3]!.form)).toEqual({ payment_intent: 'pi_1' });
    expect(calls[3]!.headers['idempotency-key']).toBe('withdrawal:w1:refund');
  });

  it('pays back the part named, and takes a subscription that has ended already as done', async () => {
    const calls = stripeApi(
      { json: { data: [{ id: 'in_1' }] } },
      { json: { data: [{ payment: { payment_intent: 'pi_1' } }] } },
      { status: 404, json: { error: { code: 'resource_missing' } } },
      { json: { id: 're_2', amount: 250, currency: 'eur' } },
    );
    expect(await provider.withdraw({ subscriptionId: 'sub_1', amountMinor: 250, key: 'withdrawal:w2' })).toEqual({ refundedMinor: 250, currency: 'EUR' });
    expect(calls[3]!.form.get('amount')).toBe('250');
  });

  it('pays nothing back when the subscription could not be ended, and says there is no payment where there is none', async () => {
    const calls = stripeApi(
      { json: { data: [{ id: 'in_1' }] } },
      { json: { data: [{ payment: { payment_intent: 'pi_1' } }] } },
      { status: 500, json: { error: { code: 'api_error' } } },
    );
    await expect(provider.withdraw({ subscriptionId: 'sub_1', amountMinor: null, key: 'withdrawal:w3' })).rejects.toThrow(/500/);
    expect(calls).toHaveLength(3);
    stripeApi({ json: { data: [] } });
    await expect(provider.withdraw({ subscriptionId: 'sub_1', amountMinor: null, key: 'withdrawal:w4' })).rejects.toThrow(/no payment/);
  });
});

describe('the catalog sent to Stripe', () => {
  const catalog = provider.catalog!;
  const missing = { status: 404, json: { error: { code: 'resource_missing' } } };

  it('makes a product under an id of its own when Stripe has none, so asking again finds it', async () => {
    const calls = stripeApi(missing, { json: { id: 'app_premium', name: 'Premium' } });
    expect(await catalog.ensureProduct({ key: 'app_premium', name: 'Premium', description: 'All of it' })).toBe('app_premium');
    expect(calls.map(c => `${c.method} ${new URL(c.url).pathname}`)).toEqual(['GET /v1/products/app_premium', 'POST /v1/products']);
    expect(Object.fromEntries(calls[1]!.form)).toEqual({ id: 'app_premium', name: 'Premium', description: 'All of it' });
    expect(calls[1]!.headers['idempotency-key']).toBe('catalog:product:app_premium');
  });

  it('leaves a product alone that is the same, and corrects a name or description that is not', async () => {
    const same = stripeApi({ json: { id: 'app_premium', name: 'Premium', description: 'All of it' } });
    await catalog.ensureProduct({ key: 'app_premium', name: 'Premium', description: 'All of it' });
    expect(same).toHaveLength(1);
    const changed = stripeApi({ json: { id: 'app_premium', name: 'Old', description: null } }, { json: { id: 'app_premium' } });
    await catalog.ensureProduct({ key: 'app_premium', name: 'Premium', description: null });
    expect(changed.map(c => c.method)).toEqual(['GET', 'POST']);
    expect(Object.fromEntries(changed[1]!.form)).toEqual({ name: 'Premium', description: '' });
  });

  it('makes a price with its lookup key, tax included and repeating as the period says, and a thing bought once with no repeat', async () => {
    const calls = stripeApi({ json: { data: [] } }, { json: { id: 'price_new' } }, { json: { data: [] } }, { json: { id: 'price_once' } });
    expect(await catalog.ensurePrice({ key: 'app_premium_year_eur_v1', productId: 'app_premium', period: 'year', currency: 'EUR', amountMinor: 2490 })).toBe('price_new');
    expect(new URL(calls[0]!.url).searchParams.get('lookup_keys[]')).toBe('app_premium_year_eur_v1');
    expect(Object.fromEntries(calls[1]!.form)).toEqual({ product: 'app_premium', currency: 'eur', unit_amount: '2490', lookup_key: 'app_premium_year_eur_v1', tax_behavior: 'inclusive', 'recurring[interval]': 'year' });
    await catalog.ensurePrice({ key: 'app_topup_once_eur_v1', productId: 'app_topup', period: 'once', currency: 'EUR', amountMinor: 1999 });
    expect(calls[3]!.form.has('recurring[interval]')).toBe(false);
  });

  it('finds a price already made under the key and makes nothing, but refuses one under it that is not this price', async () => {
    const found = stripeApi({ json: { data: [{ id: 'price_have', unit_amount: 2490, currency: 'eur', product: 'app_premium' }] } });
    expect(await catalog.ensurePrice({ key: 'k', productId: 'app_premium', period: 'year', currency: 'EUR', amountMinor: 2490 })).toBe('price_have');
    expect(found).toHaveLength(1);
    stripeApi({ json: { data: [{ id: 'price_have', unit_amount: 2000, currency: 'eur', product: 'app_premium' }] } });
    await expect(catalog.ensurePrice({ key: 'k', productId: 'app_premium', period: 'year', currency: 'EUR', amountMinor: 2490 })).rejects.toThrow(/not this one/);
  });

  it('does not hand back a price that was taken off sale, which Stripe still finds by its key', async () => {
    stripeApi({ json: { data: [{ id: 'price_old', active: false, unit_amount: 2490, currency: 'eur', product: 'app_premium' }] } });
    await expect(catalog.ensurePrice({ key: 'k', productId: 'app_premium', period: 'year', currency: 'EUR', amountMinor: 2490 })).rejects.toThrow(/taken off sale/);
  });

  it('takes a price off sale without deleting it', async () => {
    const calls = stripeApi({ json: { id: 'price_have', active: false } });
    await catalog.archivePrice('price_have');
    expect(`${calls[0]!.method} ${new URL(calls[0]!.url).pathname}`).toBe('POST /v1/prices/price_have');
    expect(Object.fromEntries(calls[0]!.form)).toEqual({ active: 'false' });
  });
});

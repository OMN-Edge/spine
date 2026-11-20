import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { buildTestApp, loginSession } from './helpers/app.js';

/** The billing details an invoice needs: asked for only where the operator issues invoices, kept as the provider's customer, and a purchase waits for them. */
const ENV = {
  SPINE_BILLING: 'on', SPINE_BILLING_PROVIDER: 'stripe', STRIPE_SECRET_KEY: 'sk_test_details', STRIPE_WEBHOOK_SECRET: 'whsec_details',
  SPINE_STRIPE_PRICE_YEAR: 'pri_year', SPINE_STRIPE_PRICE_MONTH: 'pri_month', SPINE_STRIPE_PRICE_FOUNDING: 'pri_founding',
  SPINE_INVOICING_PROVIDER: 'billyou', SPINE_INVOICING_VAT_PERCENT: '0', SPINE_INVOICING_ZERO_VAT: 'O', BILLYOU_API_KEY: 'bk_details_not_real', BILLYOU_SERIES_ID: 'series_1',
};
const RO = { name: 'Ana Test', country: 'RO', county: 'CJ', city: 'Cluj-Napoca', address: 'Str. Test 1' };

describe('the billing details', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  let cookie: string;
  const dir = mkdtempSync(path.join(tmpdir(), 'spine-details-'));
  const saved: Record<string, string | undefined> = {};
  beforeAll(async () => {
    process.env.DATA_DIR = dir;
    for (const k of Object.keys(ENV)) saved[k] = process.env[k];
    Object.assign(process.env, ENV);
    app = await buildTestApp();
    cookie = await loginSession(app);
  });
  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  /** Stripe, as far as these routes ask it: a customer is made or changed, and a checkout started. */
  function stripe(customer: Record<string, unknown> = { id: 'cus_details' }) {
    const calls: Array<{ url: string; form: URLSearchParams }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: { method?: string; body?: string }) => {
      calls.push({ url: String(url), form: new URLSearchParams(init?.body ?? '') });
      if (String(url).includes('/v1/checkout/sessions')) return new Response(JSON.stringify({ url: 'https://checkout.stripe.com/c/pay/cs_test_1' }));
      return new Response(JSON.stringify(customer));
    }));
    return calls;
  }
  const put = (body: unknown) => app.inject({ method: 'PUT', url: '/api/billing/details', headers: { cookie }, payload: body as object });
  const checkout = () => app.inject({ method: 'POST', url: '/api/billing/checkout', headers: { cookie }, payload: { interval: 'year' } });

  it('are asked for before a purchase, and the purchase says so rather than going to the provider’s page', async () => {
    const calls = stripe();
    const read = await app.inject({ method: 'GET', url: '/api/billing/details', headers: { cookie } });
    expect(read.json()).toEqual({ required: true, details: null });
    const early = await checkout();
    expect(early.statusCode).toBe(409);
    expect(early.json()).toMatchObject({ code: 'billing_details_required' });
    expect(calls).toHaveLength(0);
    const plan = await app.inject({ method: 'GET', url: '/api/billing', headers: { cookie } });
    expect(plan.json()).toMatchObject({ billing_details: true });
  });

  it('refuse an address in Romania with no county, naming the field, and make no customer', async () => {
    const calls = stripe();
    const res = await put({ ...RO, county: undefined });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ field: 'county' });
    expect(calls).toHaveLength(0);
    expect((await put({ ...RO, county: 'B' })).json()).toMatchObject({ field: 'sector' });
  });

  it('are kept as the provider’s customer, which is all that is kept here, and the purchase then uses it', async () => {
    const calls = stripe();
    const saved = await put(RO);
    expect(saved.statusCode).toBe(200);
    expect(calls[0]!.url).toBe('https://api.stripe.com/v1/customers');
    expect(calls[0]!.form.get('address[state]')).toBe('CJ');
    const go = await checkout();
    expect(go.statusCode).toBe(200);
    expect(go.json()).toEqual({ url: 'https://checkout.stripe.com/c/pay/cs_test_1' });
    const session = calls.find(c => c.url.includes('/v1/checkout/sessions'))!;
    expect(session.form.get('customer')).toBe('cus_details');
    expect(session.form.has('billing_address_collection')).toBe(false);
  });

  it('are read from the customer to fill the form again, and a second save changes that customer and does not make another', async () => {
    const calls = stripe({ id: 'cus_details', name: 'Ana Test', address: { line1: 'Str. Test 1', city: 'Cluj-Napoca', country: 'RO', state: 'CJ' }, metadata: {} });
    const read = await app.inject({ method: 'GET', url: '/api/billing/details', headers: { cookie } });
    expect(read.json()).toMatchObject({ required: true, details: { name: 'Ana Test', country: 'RO', county: 'CJ' } });
    expect((await put({ ...RO, city: 'Dej' })).statusCode).toBe(200);
    expect(calls.at(-1)!.url).toBe('https://api.stripe.com/v1/customers/cus_details');
  });

  it('say the provider cannot be reached when it cannot, and keep nothing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
    const res = await put({ ...RO, name: 'Someone Else' });
    expect(res.statusCode).toBe(502);
  });
});

describe('where the operator issues no invoices', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  let cookie: string;
  const dir = mkdtempSync(path.join(tmpdir(), 'spine-details-off-'));
  const saved: Record<string, string | undefined> = {};
  beforeAll(async () => {
    process.env.DATA_DIR = dir;
    const env = { ...ENV, SPINE_INVOICING_PROVIDER: 'none' };
    for (const k of Object.keys(env)) saved[k] = process.env[k];
    Object.assign(process.env, env);
    app = await buildTestApp();
    cookie = await loginSession(app);
  });
  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('are asked for all the same: the invoice and its PDF are Spine’s whoever issues them, so the details are required and can be saved, and a purchase waits for them', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/billing/details', headers: { cookie } })).json()).toEqual({ required: true, details: null });
    expect((await app.inject({ method: 'PUT', url: '/api/billing/details', headers: { cookie }, payload: RO })).statusCode).not.toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/billing', headers: { cookie } })).json()).toMatchObject({ billing_details: true });
  });
});

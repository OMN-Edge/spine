import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { loadBillingConfig } from '../billing/config.js';
import type { Enabled } from '../billing/provider.js';
import { resetCatalog } from '../billing/catalog.js';
import { plansFor } from '../plans/mapping.js';
import { buildTestApp, loginAs } from './helpers/app.js';
import { createTestUser, TEST_PASSWORD } from './helpers/seed.js';

/** The catalog on the admin page, end to end against a Stripe that keeps what it is sent: what is edited and sent is what the pricing page shows and a checkout charges. */
const ADMIN = 'admin-catalog@spine.test';
const ENV = {
  SPINE_BILLING: 'on', SPINE_BILLING_PROVIDER: 'stripe', STRIPE_SECRET_KEY: 'sk_test_catalog', STRIPE_WEBHOOK_SECRET: 'whsec_catalog',
  SPINE_STRIPE_PRICE_YEAR: 'price_env_year', SPINE_STRIPE_PRICE_MONTH: 'price_env_month', SPINE_STRIPE_PRICE_FOUNDING: 'price_env_founding',
  SPINE_STRIPE_PRICE_ESSENTIAL_YEAR: 'price_env_ess_year', SPINE_STRIPE_PRICE_ESSENTIAL_MONTH: 'price_env_ess_month', SPINE_DOMAIN: 'spine.test',
};

/** A Stripe with products and prices in memory, answering the calls the catalog and the pricing page make. */
function stripe() {
  const products = new Map<string, { id: string; name: string; description: string | null }>();
  const prices = new Map<string, { id: string; product: string; unit_amount: number; currency: string; lookup_key: string | null; active: boolean; recurring: { interval: string } | null }>();
  const checkouts: URLSearchParams[] = [];
  let n = 0;
  // the environment's own prices, as the operator made them in the dashboard
  const seed = (id: string, amount: number, interval: string | null, product = 'prod_env') => prices.set(id, { id, product, unit_amount: amount, currency: 'eur', lookup_key: null, active: true, recurring: interval ? { interval } : null });
  seed('price_env_year', 2490, 'year'); seed('price_env_month', 299, 'month'); seed('price_env_founding', 1990, 'year');
  seed('price_env_ess_year', 1490, 'year'); seed('price_env_ess_month', 199, 'month');
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const fetcher = vi.fn(async (input: string, init: { method?: string; body?: string } = {}) => {
    const url = new URL(String(input));
    const form = new URLSearchParams(init.body ?? '');
    const method = init.method ?? 'GET';
    const p = url.pathname;
    let m: RegExpMatchArray | null;
    if ((m = p.match(/^\/v1\/products\/([^/]+)$/))) {
      const found = products.get(m[1]!);
      if (method === 'GET') return found ? json(found) : json({ error: { code: 'resource_missing' } }, 404);
      if (found) { found.name = form.get('name') ?? found.name; found.description = form.get('description') || null; return json(found); }
    }
    if (p === '/v1/products' && method === 'POST') { const id = form.get('id') ?? `prod_${++n}`; products.set(id, { id, name: form.get('name')!, description: form.get('description') }); return json({ id }); }
    if (p === '/v1/prices' && method === 'GET') { const k = url.searchParams.get('lookup_keys[]'); return json({ data: [...prices.values()].filter(x => x.lookup_key === k) }); }
    if (p === '/v1/prices' && method === 'POST') {
      const id = `price_${++n}`;
      prices.set(id, { id, product: form.get('product')!, unit_amount: Number(form.get('unit_amount')), currency: form.get('currency')!, lookup_key: form.get('lookup_key'), active: true, recurring: form.get('recurring[interval]') ? { interval: form.get('recurring[interval]')! } : null });
      return json({ id });
    }
    if ((m = p.match(/^\/v1\/prices\/([^/]+)$/))) {
      const found = prices.get(m[1]!);
      if (!found) return json({ error: { code: 'resource_missing' } }, 404);
      if (method === 'POST') { found.active = form.get('active') !== 'false'; return json(found); }
      return json(found);
    }
    if (p === '/v1/checkout/sessions' && method === 'POST') { checkouts.push(form); return json({ id: 'cs_1', url: 'https://checkout.stripe.test/c/1' }); }
    return json({ error: { code: 'not_stubbed', path: p } }, 500);
  });
  return { fetcher, prices, products, checkouts };
}

describe('the catalog on the admin page', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  const dir = mkdtempSync(path.join(tmpdir(), 'spine-catalog-'));
  const saved: Record<string, string | undefined> = {};
  const api = stripe();
  beforeAll(async () => {
    process.env.DATA_DIR = dir;
    for (const k of Object.keys(ENV)) saved[k] = process.env[k];
    Object.assign(process.env, ENV);
    app = await buildTestApp({ accounts: { registration: 'approval' }, admin: { admins: () => new Set([ADMIN]), readers: () => new Set([ADMIN]) } });
    await createTestUser(ADMIN);
    resetCatalog();
  });
  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  afterEach(() => { vi.unstubAllGlobals(); });
  const cookie = () => loginAs(app, ADMIN, TEST_PASSWORD);
  const get = async (url: string) => app.inject({ method: 'GET', url, headers: { cookie: await cookie() } });
  const send = async (method: 'PUT' | 'POST', url: string, payload?: unknown) => app.inject({ method, url, payload: payload as never, headers: { cookie: await cookie() } });
  const online = () => vi.stubGlobal('fetch', api.fetcher);
  type Catalog = { provider: string; canPublish: boolean; adoptable: number; products: Array<{ id: string; on_sale: boolean; in_step: boolean; prices: Array<{ period: string; amount_minor: number; version: number; sent: boolean }> }> };

  it('is for an administrator, and lists the products the application declares with what is waiting to be taken in', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/admin/catalog' })).statusCode).toBe(401);
    const res = await get('/api/admin/catalog');
    expect(res.statusCode).toBe(200);
    const body = res.json() as Catalog;
    expect(body).toMatchObject({ provider: 'stripe', canPublish: true, adoptable: 5 });
    expect(body.products.map(p => p.id)).toEqual(['premium', 'essential', 'family', 'founding', 'page_topup']);
  });

  it('is refused to an account that is not an administrator, for every call that reads or changes it', async () => {
    const other = await createTestUser('not-admin-catalog@spine.test');
    const headers = { cookie: await loginAs(app, other.email, TEST_PASSWORD) };
    for (const [method, url] of [['GET', '/api/admin/catalog'], ['PUT', '/api/admin/catalog/premium'], ['PUT', '/api/admin/catalog/premium/price'], ['POST', '/api/admin/catalog/publish'], ['POST', '/api/admin/catalog/adopt'], ['POST', '/api/admin/catalog/check']] as const) {
      expect((await app.inject({ method, url, headers, payload: {} })).statusCode, `${method} ${url}`).toBe(403);
    }
    expect(api.prices.get('price_env_month')!.active).toBe(true);
  });

  it('starts from the prices named in the environment, taking them as the first versions and making nothing at Stripe', async () => {
    online();
    const adopted = await send('POST', '/api/admin/catalog/adopt');
    expect(adopted.json()).toEqual({ adopted: 5 });
    expect((await send('POST', '/api/admin/catalog/adopt')).json()).toEqual({ adopted: 0 });
    expect([...api.products.keys()]).toEqual([]);
    const premium = ((await get('/api/admin/catalog')).json() as Catalog).products.find(p => p.id === 'premium')!;
    expect(premium.prices).toEqual(expect.arrayContaining([expect.objectContaining({ period: 'year', amount_minor: 2490, version: 1, sent: true }), expect.objectContaining({ period: 'month', amount_minor: 299, version: 1, sent: true })]));
  });

  it('sends a changed price as a new one, and what is shown and charged is then the new one while the old one is known for what it was', async () => {
    online();
    await send('PUT', '/api/admin/catalog/premium', { on_sale: true });
    expect((await send('PUT', '/api/admin/catalog/premium/price', { period: 'month', amount_minor: 349 })).json()).toEqual({ ok: true, version: 2 });
    expect(((await get('/api/admin/catalog')).json() as Catalog).products.find(p => p.id === 'premium')).toMatchObject({ in_step: false });
    const published = (await send('POST', '/api/admin/catalog/publish')).json() as { reports: Array<{ product: string; state: string }> };
    expect(published.reports.find(r => r.product === 'premium')).toMatchObject({ state: 'published' });
    expect(api.prices.get('price_env_month')!.active).toBe(false);
    const made = [...api.prices.values()].find(p => p.lookup_key === 'spine_premium_month_eur_v2')!;
    expect(made).toMatchObject({ unit_amount: 349, currency: 'eur', recurring: { interval: 'month' } });

    // the pricing page reads the price the catalog sent, and a checkout charges it
    resetCatalog();
    const pricing = (await app.inject({ method: 'GET', url: '/api/pricing' })).json() as { prices: { premium: { month: number; year: number } } };
    expect(pricing.prices.premium).toEqual({ month: 3.49, year: 24.9 });
    const buyer = await createTestUser('buyer-catalog@spine.test');
    const start = await app.inject({ method: 'POST', url: '/api/billing/checkout', payload: { plan: 'premium', interval: 'month' }, headers: { cookie: await loginAs(app, buyer.email, TEST_PASSWORD) } });
    expect(start.statusCode).toBe(200);
    expect(api.checkouts.at(-1)!.get('line_items[0][price]')).toBe(made.id);

    // a subscription on the price that was replaced is still the plan it was bought as
    const plans = await plansFor(loadBillingConfig() as Enabled);
    expect(plans.planOf(['price_env_month'])).toBe('premium');
    expect(plans.planOf(['price_env_ess_month'])).toBe('essential');
    expect(plans.planOf([made.id])).toBe('premium');
    expect(plans.capped(['price_env_founding'])).toBe(true);
  });

  it('shows the catalog\u2019s price on the account page as well as on the pricing page, and the founding and Essential ones too', async () => {
    online();
    resetCatalog();
    const buyer = await createTestUser('account-prices-catalog@spine.test');
    const res = await app.inject({ method: 'GET', url: '/api/billing', headers: { cookie: await loginAs(app, buyer.email, TEST_PASSWORD) } });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { prices: { premium: { month: number } } }).prices.premium.month).toBe(3.49);
  });

  it('stops selling a plan the catalog holds when it is taken off sale, whatever the environment still names, and sells it again when it is put back', async () => {
    online();
    resetCatalog();
    const sold = async () => (await app.inject({ method: 'GET', url: '/api/pricing' })).json() as { essential: boolean; prices: { essential?: { month: number } } };
    expect((await sold()).essential).toBe(true);
    expect((await send('PUT', '/api/admin/catalog/essential', { on_sale: false })).statusCode).toBe(200);
    resetCatalog();
    expect(await sold()).toMatchObject({ essential: false });
    expect((await sold()).prices.essential).toBeUndefined();
    await send('PUT', '/api/admin/catalog/essential', { on_sale: true });
    resetCatalog();
    expect(await sold()).toMatchObject({ essential: true, prices: { essential: { month: 1.99 } } });
  });

  it('does not let Premium or the founding price be taken off sale, since the application cannot do without them', async () => {
    online();
    for (const id of ['premium', 'founding']) {
      const res = await send('PUT', `/api/admin/catalog/${id}`, { on_sale: false });
      expect(res.statusCode, id).toBe(400);
      expect(res.json().error).toMatch(/always on sale/);
    }
    resetCatalog();
    expect(((await app.inject({ method: 'GET', url: '/api/pricing' })).json() as { prices: { premium: { month: number } } }).prices.premium.month).toBe(3.49);
  });

  it('keeps the product\u2019s name and refuses one that is empty or long, and a description that is long', async () => {
    expect((await send('PUT', '/api/admin/catalog/essential', { name: 'Spine Essential (new)' })).statusCode).toBe(200);
    expect(((await get('/api/admin/catalog')).json() as { products: Array<{ id: string; name: string }> }).products.find(p => p.id === 'essential')!.name).toBe('Spine Essential (new)');
    expect((await send('PUT', '/api/admin/catalog/essential', { name: '   ' })).statusCode).toBe(400);
    expect((await send('PUT', '/api/admin/catalog/essential', { name: 'x'.repeat(121) })).statusCode).toBe(400);
    expect((await send('PUT', '/api/admin/catalog/essential', { description: 'x'.repeat(501) })).statusCode).toBe(400);
    expect((await send('PUT', '/api/admin/catalog/essential', { name: 5 })).statusCode).toBe(400);
  });

  it('reports a product Stripe refused and still sends the others, and says when Stripe cannot be reached for an import', async () => {
    online();
    await send('PUT', '/api/admin/catalog/essential/price', { period: 'year', amount_minor: 1590 });
    await send('PUT', '/api/admin/catalog/page_topup/price', { period: 'once', amount_minor: 1999 });
    const real = api.fetcher.getMockImplementation()!;
    vi.stubGlobal('fetch', vi.fn(async (input: string, init: { method?: string; body?: string } = {}) =>
      (new URL(String(input)).pathname === '/v1/prices' && (init.method ?? 'GET') === 'POST' && (init.body ?? '').includes('page_topup')
        ? new Response(JSON.stringify({ error: { code: 'rate_limit' } }), { status: 429 })
        : real(input, init))));
    const out = (await send('POST', '/api/admin/catalog/publish')).json() as { reports: Array<{ product: string; state: string; message: string | null }> };
    expect(out.reports.find(r => r.product === 'essential')?.state).toBe('published');
    expect(out.reports.find(r => r.product === 'page_topup')).toMatchObject({ state: 'failed' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    expect((await send('POST', '/api/admin/catalog/adopt')).statusCode).toBe(502);
  });

  it('refuses an amount that is not a price, a product that is not Spine’s and a product with nothing to sell on sale', async () => {
    expect((await send('PUT', '/api/admin/catalog/premium/price', { period: 'month', amount_minor: 0 })).statusCode).toBe(400);
    expect((await send('PUT', '/api/admin/catalog/premium/price', { period: 'month', amount_minor: 12.5 })).statusCode).toBe(400);
    expect((await send('PUT', '/api/admin/catalog/premium/price', { period: 'week', amount_minor: 100 })).statusCode).toBe(400);
    expect((await send('PUT', '/api/admin/catalog/nothing/price', { period: 'month', amount_minor: 100 })).statusCode).toBe(404);
    expect((await send('PUT', '/api/admin/catalog/family', { on_sale: true })).statusCode).toBe(400);
  });

  it('says where Stripe differs from the catalog', async () => {
    online();
    expect(((await send('POST', '/api/admin/catalog/check')).json() as { differences: unknown[] }).differences).toEqual([]);
    const made = [...api.prices.values()].find(p => p.lookup_key === 'spine_premium_month_eur_v2')!;
    made.unit_amount = 300;
    expect(((await send('POST', '/api/admin/catalog/check')).json() as { differences: Array<{ product: string; expectedMinor: number; foundMinor: number }> }).differences).toEqual([expect.objectContaining({ product: 'premium', expectedMinor: 349, foundMinor: 300 })]);
  });
});

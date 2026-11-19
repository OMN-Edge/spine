import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAccountsStore } from 'spine-core/store/index.js';
import { adopt, CatalogError, drift, loadCatalog, offSale, onSalePrices, productOfPrice, publish, setPrice, setProduct, type ProductTemplate } from 'spine-billing/products.js';
import type { BillingProvider, ProviderPriceInput } from '../billing/provider.js';
import { buildTestApp } from './helpers/app.js';

/** The product catalog: versions of prices, what is sent to a provider and what is not, with a provider that keeps what it is sent (the real one's keys and ids behave the same). */
/** Each test has products of its own: the catalog is the operator's and nothing here deletes from it. */
let counter = 0;
function fresh() {
  counter++;
  const a = `plan_a${counter}`, b = `pack_b${counter}`;
  const templates: ProductTemplate[] = [
    { id: a, periods: ['month', 'year'], currencies: ['EUR'], name: 'Plan A' },
    { id: b, periods: ['once'], currencies: ['EUR'], name: 'Pack B' },
  ];
  return { templates, a, b };
}
const T0 = new Date('2026-11-20T10:00:00.000Z');

/** The provider's ids differ from one test to the next, as the real one's do: the catalog's links outlive a test. */
let priceCounter = 0;

function fakeProvider(options: { failOn?: string; catalog?: boolean } = {}) {
  const products = new Map<string, { name: string; description: string | null }>();
  const prices = new Map<string, { id: string; input: ProviderPriceInput; active: boolean }>();
  const calls: string[] = [];
  const provider = {
    id: 'stripe',
    ...(options.catalog === false ? {} : {
      catalog: {
        async ensureProduct(input: { key: string; name: string; description: string | null }) {
          calls.push(`product ${input.key}`);
          products.set(input.key, { name: input.name, description: input.description });
          return `prod_${input.key}`;
        },
        async ensurePrice(input: ProviderPriceInput) {
          calls.push(`price ${input.key}`);
          if (options.failOn && input.key.includes(options.failOn)) throw new Error('the provider refused');
          const found = prices.get(input.key);
          if (found) return found.id;
          const id = `price_${++priceCounter}`;
          prices.set(input.key, { id, input, active: true });
          return id;
        },
        async archivePrice(id: string) {
          calls.push(`archive ${id}`);
          for (const p of prices.values()) if (p.id === id) p.active = false;
        },
      },
    }),
    async readPrice(id: string) {
      const found = [...prices.values()].find(p => p.id === id);
      if (!found || !found.active) throw new Error('not there');
      return { amount: found.input.amountMinor / 100, currency: found.input.currency.toUpperCase(), interval: found.input.period === 'once' ? null : found.input.period, productId: `prod_${found.input.productId}` };
    },
  } as unknown as BillingProvider;
  return { provider, prices, products, calls };
}

describe('the product catalog', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  beforeAll(async () => { app = await buildTestApp({}); });
  afterAll(async () => { await app.close(); });
  it('makes the products the application declares, with no price and not on sale', async () => {
    const X = fresh();
    const view = await loadCatalog(X.templates, null, T0);
    expect(view.map(v => v.id)).toEqual([X.a, X.b]);
    expect(view[0]).toMatchObject({ name: 'Plan A', on_sale: 0, prices: [], inStep: true });
  });

  it('keeps every amount as a version, and a new amount is a new version, not a change', async () => {
    const X = fresh();
    const first = await setPrice(X.templates, X.a, 'month', 'eur', 499, T0);
    expect(first).toMatchObject({ period: 'month', currency: 'EUR', amount_minor: 499, version: 1 });
    expect((await setPrice(X.templates, X.a, 'month', 'EUR', 499, T0)).version).toBe(1);
    const second = await setPrice(X.templates, X.a, 'month', 'EUR', 599, T0);
    expect(second).toMatchObject({ amount_minor: 599, version: 2 });
    const price = (await loadCatalog(X.templates, null, T0)).find(v => v.id === X.a)!.prices.find(p => p.period === 'month')!;
    expect(price.current.version).toBe(2);
    expect(price.earlier.map(p => [p.version, p.amount_minor])).toEqual([[1, 499]]);
  });

  it('refuses what is not a price: another period, another currency, an amount that is not a positive whole number of cents or is far too large', async () => {
    const X = fresh();
    await expect(setPrice(X.templates, X.b, 'month', 'EUR', 100, T0)).rejects.toThrow(CatalogError);
    await expect(setPrice(X.templates, X.a, 'year', 'USD', 100, T0)).rejects.toThrow(/not priced in USD/);
    for (const bad of [0, -1, 1.5, Number.NaN, 100_000_01]) await expect(setPrice(X.templates, X.a, 'year', 'EUR', bad, T0)).rejects.toThrow(/whole number of cents/);
    await expect(setPrice(X.templates, 'nope', 'year', 'EUR', 100, T0)).rejects.toMatchObject({ status: 404 });
  });

  it('puts a product on sale only when it has a price, and keeps the name the operator gave', async () => {
    const X = fresh();
    await expect(setProduct(X.templates, X.b, { onSale: true }, T0)).rejects.toThrow(/no price/);
    await setPrice(X.templates, X.b, 'once', 'EUR', 1900, T0);
    await setProduct(X.templates, X.b, { onSale: true, name: ' Pages, 250 ', description: 'More pages' }, T0);
    expect((await loadCatalog(X.templates, null, T0)).find(v => v.id === X.b)).toMatchObject({ name: 'Pages, 250', description: 'More pages', on_sale: 1 });
    await expect(setProduct(X.templates, X.b, { name: '  ' }, T0)).rejects.toThrow(/name/);
  });

  it('sends what is new to the provider once, and finds it again instead of making it twice', async () => {
    const X = fresh();
    const f = fakeProvider();
    await setPrice(X.templates, X.a, 'month', 'EUR', 499, T0);
    await setPrice(X.templates, X.a, 'year', 'EUR', 4900, T0);
    const first = await publish(X.templates, f.provider, { prefix: 'app', now: T0 });
    expect(first.find(r => r.product === X.a)).toMatchObject({ state: 'published', message: null });
    expect([...f.prices.keys()].sort()).toEqual([`app_${X.a}_month_eur_v1`, `app_${X.a}_year_eur_v1`]);
    const again = await publish(X.templates, f.provider, { prefix: 'app', now: T0 });
    expect(again.find(r => r.product === X.a)?.state).toBe('in_step');
    expect(f.prices.size).toBe(2);
    expect((await loadCatalog(X.templates, f.provider, T0)).find(v => v.id === X.a)!.inStep).toBe(true);
  });

  it('sends a changed amount as a new price and takes the old one off sale, which the subscribers who bought it keep', async () => {
    const X = fresh();
    const f = fakeProvider();
    await setPrice(X.templates, X.a, 'month', 'EUR', 499, T0);
    await publish(X.templates, f.provider, { prefix: 'chg', now: T0 });
    const v1 = [...f.prices.values()][0]!.id;
    await setPrice(X.templates, X.a, 'month', 'EUR', 549, T0);
    expect((await loadCatalog(X.templates, f.provider, T0)).find(v => v.id === X.a)!.inStep).toBe(false);
    await publish(X.templates, f.provider, { prefix: 'chg', now: T0 });
    expect(f.calls.filter(c => c === `archive ${v1}`)).toHaveLength(1);
    expect([...f.prices.values()].map(p => [p.input.amountMinor, p.active])).toEqual([[499, false], [549, true]]);
    // a subscription on the first price is still known for the product it was
    expect((await productOfPrice('stripe')).get(v1)).toBe(X.a);
  });

  it('charges the newest price that has been sent, of a product that is on sale, and nothing before', async () => {
    const X = fresh();
    const f = fakeProvider();
    await setPrice(X.templates, X.b, 'once', 'EUR', 1900, T0);
    expect((await onSalePrices('stripe')).has(`${X.b}:once:EUR`)).toBe(false);
    await publish(X.templates, f.provider, { prefix: 'sale', now: T0 });
    expect((await onSalePrices('stripe')).has(`${X.b}:once:EUR`)).toBe(false); // sent, not on sale
    await setProduct(X.templates, X.b, { onSale: true }, T0);
    const sale = await onSalePrices('stripe');
    expect(sale.get(`${X.b}:once:EUR`)).toBe([...f.prices.values()].find(p => p.input.productId.endsWith(X.b))!.id);
    // a new amount that has not been sent yet is not charged: the one before it is not, either
    await setPrice(X.templates, X.b, 'once', 'EUR', 2100, T0);
    expect((await onSalePrices('stripe')).has(`${X.b}:once:EUR`)).toBe(false);
  });

  it('reports a failure for its product and still sends the others', async () => {
    const X = fresh();
    const f = fakeProvider({ failOn: X.b });
    await setPrice(X.templates, X.a, 'year', 'EUR', 4900, T0);
    await setPrice(X.templates, X.b, 'once', 'EUR', 1900, T0);
    const reports = await publish(X.templates, f.provider, { prefix: 'fail', now: T0 });
    expect(reports.find(r => r.product === X.a)?.state).toBe('published');
    expect(reports.find(r => r.product === X.b)).toMatchObject({ state: 'failed', message: 'the provider refused' });
  });

  it('is refused for a provider that has no catalog (the merchant of record)', async () => {
    const X = fresh();
    await expect(publish(X.templates, fakeProvider({ catalog: false }).provider, { prefix: 'x' })).rejects.toMatchObject({ status: 501 });
  });

  it('takes the prices that exist at the provider as the first versions and sends nothing, and does it once', async () => {
    const X = fresh();
    const f = fakeProvider();
    // two prices made at the provider before there was a catalog
    const ensure = f.provider.catalog!;
    const month = await ensure.ensurePrice({ key: 'old_month', productId: X.a, period: 'month', currency: 'EUR', amountMinor: 399 });
    const once = await ensure.ensurePrice({ key: 'old_once', productId: X.b, period: 'once', currency: 'EUR', amountMinor: 1500 });
    f.calls.length = 0;
    const found = [{ productId: X.a, period: 'month' as const, providerPriceId: month }, { productId: X.b, period: 'once' as const, providerPriceId: once }];
    expect(await adopt(X.templates, f.provider, found, T0)).toBe(2);
    expect(await adopt(X.templates, f.provider, found, T0)).toBe(0);
    expect(f.calls).toEqual([]);
    const view = await loadCatalog(X.templates, f.provider, T0);
    expect(view.find(v => v.id === X.a)!.prices[0]).toMatchObject({ providerPriceId: month, current: { amount_minor: 399, version: 1 } });
    expect(await productOfPrice('stripe')).toEqual(expect.objectContaining({}));
    expect((await productOfPrice('stripe')).get(month)).toBe(X.a);
  });

  it('puts a product on sale when it takes its price in, since it was on sale under the environment\u2019s ids, and lists a product as off sale only when it holds a price', async () => {
    const X2 = fresh();
    const f = fakeProvider();
    const price = await f.provider.catalog!.ensurePrice({ key: `old_${X2.a}`, productId: X2.a, period: 'month', currency: 'EUR', amountMinor: 399 });
    expect((await offSale()).has(X2.a)).toBe(false); // no price held: the catalog is not in charge of it
    await loadCatalog(X2.templates, f.provider, T0);
    expect((await offSale()).has(X2.a)).toBe(false);
    await adopt(X2.templates, f.provider, [{ productId: X2.a, period: 'month', providerPriceId: price }], T0);
    const view = (await loadCatalog(X2.templates, f.provider, T0)).find(v => v.id === X2.a)!;
    expect(view.on_sale).toBe(1);
    expect((await offSale()).has(X2.a)).toBe(false);
    await setProduct(X2.templates, X2.a, { onSale: false }, T0);
    expect((await offSale()).has(X2.a)).toBe(true);
    await setProduct(X2.templates, X2.a, { onSale: true }, T0);
    expect((await offSale()).has(X2.a)).toBe(false);
  });

  it('refuses to take a product off sale that the application cannot do without', async () => {
    const X2 = fresh();
    const required: ProductTemplate[] = [{ ...X2.templates[0]!, required: true }];
    await setPrice(required, X2.a, 'month', 'EUR', 499, T0);
    await setProduct(required, X2.a, { onSale: true }, T0);
    await expect(setProduct(required, X2.a, { onSale: false }, T0)).rejects.toThrow(/always on sale/);
    await setProduct(required, X2.a, { name: 'Renamed' }, T0); // the rest can still be edited
    expect((await loadCatalog(required, null, T0))[0]).toMatchObject({ name: 'Renamed', on_sale: 1 });
  });

  it('says where the provider differs from the catalog', async () => {
    const X = fresh();
    const f = fakeProvider();
    await setPrice(X.templates, X.a, 'month', 'EUR', 499, T0);
    await publish(X.templates, f.provider, { prefix: 'dr', now: T0 });
    expect(await drift(X.templates, f.provider)).toEqual([]);
    for (const p of f.prices.values()) p.input = { ...p.input, amountMinor: 450 };
    expect(await drift(X.templates, f.provider)).toEqual([{ product: X.a, period: 'month', currency: 'EUR', expectedMinor: 499, foundMinor: 450, message: null }]);
    for (const p of f.prices.values()) p.active = false;
    expect((await drift(X.templates, f.provider))[0]).toMatchObject({ foundMinor: null, message: 'not there' });
  });
});

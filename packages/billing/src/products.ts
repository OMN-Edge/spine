import { store as billingStore } from './host.js';
import type { CatalogLink, CatalogPrice, CatalogProduct } from './store.js';
import type { BillingProvider, ProviderCatalog } from './provider.js';

/**
 * The operator's product catalog: what is sold, each price as a version, and where each version is at the payment provider. **The application declares its products**
 * (`ProductTemplate`: which products there are, which periods each may be sold in) and **the operator edits what is commercial** (the name, the description, whether it is on sale,
 * the amount of each price). What a product includes (pages, seats, features) is the application's code, never a field here. No product's name appears in this file.
 *
 * A price is never changed: a new amount is a new version, the provider is sent that version (a key that is found again, so sending it twice makes one), and the version it replaces is
 * taken off sale there while the subscriptions that bought it go on with it. Nothing is deleted, so an old subscription and its invoices still say what was sold.
 */
export type Period = 'month' | 'year' | 'once';

export interface ProductTemplate {
  /** The application's key for the product (`premium`): what its code and the catalog call it. Letters, digits and underscores. */
  id: string;
  /** The periods it may be sold for: a subscription's `month` and `year`, a thing bought once's `once`. */
  periods: Period[];
  /** The currencies it may be priced in (three letters). */
  currencies: string[];
  /** What it is called until the operator says otherwise. */
  name: string;
  description?: string | null;
  /** The application cannot do without it, so it cannot be taken off sale. */
  required?: boolean;
}

/** The largest amount accepted, in the minor unit: a typing error of a digit or two is refused, not sold. */
export const MAX_AMOUNT_MINOR = 100_000_00;

export class CatalogError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 501 = 400) {
    super(message);
    this.name = 'CatalogError';
  }
}

const store = () => billingStore().catalog;
const templateOf = (templates: ProductTemplate[], id: string): ProductTemplate => {
  const t = templates.find(x => x.id === id);
  if (!t) throw new CatalogError(`there is no product ${id}`, 404);
  return t;
};

/** What the operator sees of one price: the version on sale (the newest) and what the provider has of it. */
export interface PriceView {
  period: Period;
  currency: string;
  /** The newest version: the one that is, or is waiting to be, on sale. */
  current: CatalogPrice;
  /** The provider's price for it, once sent; null while it is only here. */
  providerPriceId: string | null;
  /** The older versions, newest first (what subscribers may still be on). */
  earlier: CatalogPrice[];
}

export interface ProductView extends CatalogProduct {
  template: Pick<ProductTemplate, 'periods' | 'currencies'>;
  prices: PriceView[];
  /** Whether every current price has been sent to the provider (and so is what a buyer is charged). */
  inStep: boolean;
}

/** The products the application declares, made in the catalog where they are not yet (not on sale, no price), and each with its prices and where they are at the provider. */
export async function loadCatalog(templates: ProductTemplate[], provider: BillingProvider | null, now = new Date()): Promise<ProductView[]> {
  const s = store();
  const known = new Map((await s.products()).map(p => [p.id, p]));
  for (const t of templates) {
    if (!known.has(t.id)) {
      await s.saveProduct({ id: t.id, name: t.name, description: t.description ?? null, on_sale: 0 }, now.toISOString());
    }
  }
  const [products, prices, links] = await Promise.all([s.products(), s.prices(), provider ? s.links(provider.id) : Promise.resolve([] as CatalogLink[])]);
  const linkOf = new Map(links.map(l => [l.price_id, l]));
  return templates.map(t => products.find(p => p.id === t.id)!).map(p => {
    const t = templateOf(templates, p.id);
    const mine = prices.filter(x => x.product_id === p.id);
    const groups = new Map<string, CatalogPrice[]>();
    for (const price of mine) groups.set(`${price.period}:${price.currency}`, [...(groups.get(`${price.period}:${price.currency}`) ?? []), price]);
    const views: PriceView[] = [...groups.values()].map(versions => {
      const newest = [...versions].sort((a, b) => b.version - a.version);
      const link = linkOf.get(newest[0]!.id);
      return { period: newest[0]!.period, currency: newest[0]!.currency, current: newest[0]!, providerPriceId: link && !link.archived_at ? link.provider_price_id : null, earlier: newest.slice(1) };
    });
    return { ...p, template: { periods: t.periods, currencies: t.currencies }, prices: views, inStep: views.every(v => v.providerPriceId !== null) };
  });
}

/** Changes what the operator may edit of a product. */
export async function setProduct(templates: ProductTemplate[], id: string, patch: { name?: string; description?: string | null; onSale?: boolean }, now = new Date()): Promise<void> {
  const t = templateOf(templates, id);
  const current = (await store().products()).find(p => p.id === id);
  const name = patch.name === undefined ? current?.name ?? t.name : patch.name.trim();
  if (!name || name.length > 120) throw new CatalogError('a product needs a name of up to 120 characters');
  const description = patch.description === undefined ? current?.description ?? t.description ?? null : patch.description?.trim() || null;
  if (description && description.length > 500) throw new CatalogError('a description is up to 500 characters');
  const onSale = patch.onSale === undefined ? current?.on_sale === 1 : patch.onSale;
  if (!onSale && t.required) throw new CatalogError(`${t.name} is always on sale: the application cannot do without it`);
  if (onSale) {
    const views = await loadCatalog(templates, null, now);
    const view = views.find(v => v.id === id);
    if (!view || view.prices.length === 0) throw new CatalogError('a product with no price cannot be put on sale');
  }
  await store().saveProduct({ id, name, description, on_sale: onSale ? 1 : 0 }, now.toISOString());
}

/** Sets a price: a new version where the amount differs from the newest, nothing where it is the same. Returns the version that now stands. */
export async function setPrice(templates: ProductTemplate[], productId: string, period: Period, currency: string, amountMinor: number, now = new Date()): Promise<CatalogPrice> {
  const t = templateOf(templates, productId);
  if (!t.periods.includes(period)) throw new CatalogError(`${productId} is not sold ${period === 'once' ? 'once' : `by the ${period}`}`);
  const code = currency.trim().toUpperCase();
  if (!t.currencies.includes(code)) throw new CatalogError(`${productId} is not priced in ${code}`);
  if (!Number.isInteger(amountMinor) || amountMinor <= 0 || amountMinor > MAX_AMOUNT_MINOR) throw new CatalogError('an amount is a whole number of cents, above zero and not above 100000.00');
  await loadCatalog(templates, null, now); // the product row exists
  const same = (await store().prices()).filter(p => p.product_id === productId && p.period === period && p.currency === code).sort((a, b) => b.version - a.version)[0];
  if (same && same.amount_minor === amountMinor) return same;
  return store().addPrice({ product_id: productId, period, currency: code, amount_minor: amountMinor }, now.toISOString());
}

export interface PublishReport { product: string; state: 'in_step' | 'published' | 'failed'; message: string | null }

const keyOf = (prefix: string, id: string) => `${prefix}_${id}`;
const priceKey = (prefix: string, p: CatalogPrice) => `${prefix}_${p.product_id}_${p.period}_${p.currency.toLowerCase()}_v${p.version}`;

/**
 * Sends the catalog to the provider: each product, then the newest version of each price that is not there yet, then takes the versions they replace off sale. Done again it finds what
 * it made and changes nothing. One product's failure is reported and does not stop the others. A provider that has no catalog (the merchant of record) is refused.
 */
export async function publish(templates: ProductTemplate[], provider: BillingProvider, options: { prefix: string; now?: Date }): Promise<PublishReport[]> {
  const remote: ProviderCatalog | undefined = provider.catalog;
  if (!remote) throw new CatalogError('this payment provider has no catalog to send to: its prices are made in its own dashboard', 501);
  const s = store();
  const at = (options.now ?? new Date()).toISOString();
  const views = await loadCatalog(templates, provider, options.now);
  const reports: PublishReport[] = [];
  for (const view of views) {
    if (view.prices.length === 0) { reports.push({ product: view.id, state: 'in_step', message: null }); continue; }
    try {
      const links = new Map((await s.links(provider.id)).map(l => [l.price_id, l]));
      let sent = false;
      const providerProduct = await remote.ensureProduct({ key: keyOf(options.prefix, view.id), name: view.name, description: view.description });
      for (const price of view.prices) {
        const link = links.get(price.current.id);
        if (!link || link.archived_at) {
          const providerPriceId = await remote.ensurePrice({ key: priceKey(options.prefix, price.current), productId: providerProduct, period: price.period, currency: price.currency, amountMinor: price.current.amount_minor });
          await s.saveLink({ price_id: price.current.id, provider: provider.id, provider_product_id: providerProduct, provider_price_id: providerPriceId, synced_at: at });
          sent = true;
        }
        for (const old of price.earlier) {
          const oldLink = links.get(old.id);
          if (oldLink && !oldLink.archived_at) { await remote.archivePrice(oldLink.provider_price_id); await s.archiveLink(old.id, provider.id, at); sent = true; }
        }
      }
      reports.push({ product: view.id, state: sent ? 'published' : 'in_step', message: null });
    } catch (err) {
      reports.push({ product: view.id, state: 'failed', message: err instanceof Error ? err.message : String(err) });
    }
  }
  return reports;
}

/** The provider's price id for each product's period and currency: the newest version that has been sent, of a product that is on sale. What a checkout charges. */
export async function onSalePrices(providerId: string): Promise<Map<string, string>> {
  const s = store();
  const [products, prices, links] = await Promise.all([s.products(), s.prices(), s.links(providerId)]);
  const sale = new Set(products.filter(p => p.on_sale === 1).map(p => p.id));
  const linkOf = new Map(links.filter(l => !l.archived_at).map(l => [l.price_id, l]));
  const out = new Map<string, string>();
  for (const price of [...prices].sort((a, b) => a.version - b.version)) {
    const link = linkOf.get(price.id);
    if (sale.has(price.product_id) && link) out.set(`${price.product_id}:${price.period}:${price.currency}`, link.provider_price_id);
    else if (sale.has(price.product_id)) out.delete(`${price.product_id}:${price.period}:${price.currency}`);
  }
  return out;
}

/** The products the catalog holds prices for and has taken off sale: where the catalog is in charge of a product, being off sale is being gone, whatever the application's settings still name. */
export async function offSale(): Promise<Set<string>> {
  const s = store();
  const [products, prices] = await Promise.all([s.products(), s.prices()]);
  const priced = new Set(prices.map(p => p.product_id));
  return new Set(products.filter(p => p.on_sale !== 1 && priced.has(p.id)).map(p => p.id));
}

/** Which product each provider price is of, every version ever sent, so a subscription on a price that has since been replaced is still known for what it is. */
export async function productOfPrice(providerId: string): Promise<Map<string, string>> {
  const s = store();
  const [prices, links] = await Promise.all([s.prices(), s.links(providerId)]);
  const productOf = new Map(prices.map(p => [p.id, p.product_id]));
  const out = new Map<string, string>();
  for (const l of links) { const product = productOf.get(l.price_id); if (product) out.set(l.provider_price_id, product); }
  return out;
}

/**
 * Takes prices that already exist at the provider (the ones the operator named before there was a catalog) into the catalog, so they become its first versions and are linked
 * to the provider's ids; nothing is made at the provider. Done again it adds nothing. Where the catalog already has a version with that amount it is the one linked.
 */
export async function adopt(templates: ProductTemplate[], provider: BillingProvider, found: Array<{ productId: string; period: Period; providerPriceId: string }>, now = new Date()): Promise<number> {
  const s = store();
  const at = now.toISOString();
  await loadCatalog(templates, provider, now);
  let adopted = 0;
  for (const f of found) {
    const t = templateOf(templates, f.productId);
    const reading = await provider.readPrice(f.providerPriceId);
    const currency = reading.currency.toUpperCase();
    const digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
    const minor = Math.round(reading.amount * 10 ** digits);
    if (!t.periods.includes(f.period) || !t.currencies.includes(currency)) throw new CatalogError(`${f.productId} cannot take the price ${f.providerPriceId} (${f.period}, ${currency})`);
    const links = await s.links(provider.id);
    if (links.some(l => l.provider_price_id === f.providerPriceId)) continue;
    const existing = (await s.prices()).filter(p => p.product_id === f.productId && p.period === f.period && p.currency === currency && p.amount_minor === minor).sort((a, b) => b.version - a.version)[0];
    const version = existing ?? (await s.addPrice({ product_id: f.productId, period: f.period, currency, amount_minor: minor }, at));
    await s.saveLink({ price_id: version.id, provider: provider.id, provider_product_id: reading.productId ?? '', provider_price_id: f.providerPriceId, synced_at: at });
    // what was on sale under the environment's ids is on sale in the catalog
    const product = (await s.products()).find(p => p.id === f.productId)!;
    if (product.on_sale !== 1) await s.saveProduct({ id: product.id, name: product.name, description: product.description, on_sale: 1 }, at);
    adopted++;
  }
  return adopted;
}

export interface Difference { product: string; period: Period; currency: string; expectedMinor: number; foundMinor: number | null; message: string | null }

/** Asks the provider about each price on sale and says where it differs from the catalog (a price changed there by hand, or taken off sale there). */
export async function drift(templates: ProductTemplate[], provider: BillingProvider): Promise<Difference[]> {
  const out: Difference[] = [];
  for (const view of await loadCatalog(templates, provider)) {
    for (const price of view.prices) {
      if (!price.providerPriceId) continue;
      try {
        const reading = await provider.readPrice(price.providerPriceId);
        const digits = new Intl.NumberFormat('en', { style: 'currency', currency: reading.currency }).resolvedOptions().maximumFractionDigits ?? 2;
        const found = Math.round(reading.amount * 10 ** digits);
        if (found !== price.current.amount_minor || reading.currency.toUpperCase() !== price.currency) out.push({ product: view.id, period: price.period, currency: price.currency, expectedMinor: price.current.amount_minor, foundMinor: found, message: null });
      } catch (err) {
        out.push({ product: view.id, period: price.period, currency: price.currency, expectedMinor: price.current.amount_minor, foundMinor: null, message: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  return out;
}

import type { Enabled } from '../billing/provider.js';
import { adopt, offSale, onSalePrices, productOfPrice, type Period, type ProductTemplate } from 'spine-billing/products.js';
import { billingProvider } from '../billing/provider.js';

/**
 * What Spine sells, as the catalog's templates (`billing/products.ts`): which products there are and the periods and currency each is priced in. What each includes is `core/src/billing/plans.ts`;
 * the amounts are the operator's (the admin page), never written here. Euros are the one currency, as the pricing page shows one.
 */
export const CURRENCY = 'EUR';
const subscription: Pick<ProductTemplate, 'periods' | 'currencies'> = { periods: ['month', 'year'], currencies: [CURRENCY] };

export const SPINE_PRODUCTS: ProductTemplate[] = [
  { id: 'premium', ...subscription, name: 'Spine Premium', required: true },
  { id: 'essential', ...subscription, name: 'Spine Essential' },
  { id: 'family', ...subscription, name: 'Spine Family' },
  { id: 'founding', periods: ['year'], currencies: [CURRENCY], name: 'Spine Premium, founding price', required: true },
  { id: 'page_topup', periods: ['once'], currencies: [CURRENCY], name: '250 more pages' },
];

/** What the prefix of the provider's keys is, so Spine's products and prices are found again there and nothing else is touched. */
export const PROVIDER_PREFIX = 'spine';

type Found = Array<{ productId: string; period: Period; providerPriceId: string }>;

/** The prices the operator named in the environment, as products and periods: where the catalog starts from. */
export function configuredPrices(config: Enabled): Found {
  const out: Found = [
    { productId: 'premium', period: 'year', providerPriceId: config.prices.year },
    { productId: 'premium', period: 'month', providerPriceId: config.prices.month },
    { productId: 'founding', period: 'year', providerPriceId: config.prices.founding },
  ];
  if (config.essential) out.push({ productId: 'essential', period: 'year', providerPriceId: config.essential.year }, { productId: 'essential', period: 'month', providerPriceId: config.essential.month });
  if (config.family) out.push({ productId: 'family', period: 'year', providerPriceId: config.family.year }, { productId: 'family', period: 'month', providerPriceId: config.family.month });
  if (config.addons.pageTopup) out.push({ productId: 'page_topup', period: 'once', providerPriceId: config.addons.pageTopup });
  return out;
}

/** Takes the prices named in the environment into the catalog (nothing is made at the provider), so the catalog starts from what is on sale now. */
export async function adoptConfigured(config: Enabled, now = new Date()): Promise<number> {
  return adopt(SPINE_PRODUCTS, billingProvider(config), configuredPrices(config), now);
}

/**
 * The configuration with the catalog's prices where it has them: for each price a product has on sale that has been sent to the provider, that price's id replaces the one in the
 * environment, so the pricing page and the checkout use what the operator edited and the code downstream is unchanged. Where the catalog has nothing the environment stands. A plan
 * whose two prices the catalog has is on sale even if the environment named none.
 */
export async function withCatalog(config: Enabled): Promise<Enabled> {
  const [sale, gone] = await Promise.all([onSalePrices(config.provider), offSale()]);
  if (sale.size === 0 && gone.size === 0) return config;
  const at = (product: string, period: Period) => sale.get(`${product}:${period}:${CURRENCY}`);
  const pair = (product: string, current: { year: string; month: string } | null): { year: string; month: string } | null => {
    const year = at(product, 'year') ?? current?.year, month = at(product, 'month') ?? current?.month;
    return year && month ? { year, month } : null;
  };
  return {
    ...config,
    prices: { year: at('premium', 'year') ?? config.prices.year, month: at('premium', 'month') ?? config.prices.month, founding: at('founding', 'year') ?? config.prices.founding },
    // a plan or a top-up the catalog holds and has taken off sale is not sold, whatever the environment names; Premium and the founding price cannot be taken off
    essential: gone.has('essential') ? null : pair('essential', config.essential),
    family: gone.has('family') ? null : pair('family', config.family),
    addons: { pageTopup: gone.has('page_topup') ? null : at('page_topup', 'once') ?? config.addons.pageTopup },
  };
}

/** Every provider price the catalog has ever sent, by product: what a subscription on a price that has since been replaced is still known by. */
export const catalogProducts = (config: Enabled): Promise<Map<string, string>> => productOfPrice(config.provider);

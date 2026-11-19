import { logger } from 'spine-core/logger.js';
import { billingProvider, type Enabled } from './provider.js';

/** What a plan costs, in the major unit of one currency (euros, not cents). */
export interface Amounts { year: number; month: number }
/**
 * The prices a person is shown. **Every amount is what the payment provider says about the price the operator named**; nothing is written in the code, so the page and
 * the checkout (which charges that same price) cannot disagree. A plan the operator does not sell is absent.
 */
export interface Prices {
  currency: string;
  essential?: Amounts;
  premium: Amounts;
  founding: { year: number };
  family?: Amounts;
  /** What the things bought once cost, for the ones the operator sells. */
  addons?: { page_topup?: number };
}

/** How long what the provider said is believed, and how long the last good answer is kept when it cannot be reached. */
const FRESH_MS = 10 * 60 * 1000;
let cache: { at: number; key: string; prices: Prices } | null = null;
/** When the provider last failed to answer: it is not asked again for a little while, so a slow outage is not made worse by every visitor to the pricing page. */
let failedAt = 0;
const RETRY_MS = 30_000;
/** Tests: forget what was read. */
export const resetCatalog = (): void => { cache = null; failedAt = 0; inFlight = null; };

/**
 * The prices of the plans on sale, read from the payment provider and kept ten minutes. Where it cannot be reached the last answer is still used; with none, or if
 * the prices are not all in one currency, the answer is null and the screens show no amount (and offer no purchase) rather than a guess.
 */
export function loadPrices(config: Enabled, now = Date.now()): Promise<Prices | null> {
  // The pricing page is public: when what the provider said has gone stale, every visitor at that moment would ask it seven times. One reading serves them all.
  inFlight ??= readPrices(config, now).finally(() => { inFlight = null; });
  return inFlight;
}
let inFlight: Promise<Prices | null> | null = null;

async function readPrices(config: Enabled, now: number): Promise<Prices | null> {
  const ids = [config.prices.year, config.prices.month, config.prices.founding, config.essential?.year, config.essential?.month, config.family?.year, config.family?.month, config.addons.pageTopup];
  const key = ids.join(',');
  if (cache && cache.key === key && now - cache.at < FRESH_MS) return cache.prices;
  const stale = cache && cache.key === key ? cache.prices : null;
  if (failedAt && now - failedAt < RETRY_MS) return stale;
  try {
    const wanted = ids.filter((id): id is string => !!id);
    const provider = billingProvider(config);
    const read = new Map(await Promise.all(wanted.map(async id => [id, await provider.readPrice(id)] as const)));
    const at = (id: string) => read.get(id)!;
    const currencies = new Set([...read.values()].map(r => r.currency));
    if (currencies.size !== 1) throw new Error('the prices are not all in one currency');
    const pair = (p: { year: string; month: string }): Amounts => {
      if (at(p.year).interval !== 'year' || at(p.month).interval !== 'month') throw new Error('a plan\'s prices are not one yearly and one monthly');
      return { year: at(p.year).amount, month: at(p.month).amount };
    };
    const once = (id: string): number => {
      if (at(id).interval !== null) throw new Error('a price for a thing bought once repeats');
      return at(id).amount;
    };
    const prices: Prices = {
      currency: [...currencies][0]!,
      premium: pair(config.prices),
      founding: { year: at(config.prices.founding).amount },
      ...(config.essential ? { essential: pair(config.essential) } : {}),
      ...(config.family ? { family: pair(config.family) } : {}),
      ...(config.addons.pageTopup ? { addons: { page_topup: once(config.addons.pageTopup) } } : {}),
    };
    cache = { at: now, key, prices };
    failedAt = 0;
    return prices;
  } catch (err) {
    logger.warn('the prices could not be read from the payment provider', { reason: err instanceof Error ? err.message : String(err) });
    failedAt = now;
    return stale;
  }
}

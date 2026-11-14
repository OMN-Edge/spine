import { logger } from 'spine-core/logger.js';
import type { BillingConfig } from './config.js';

type Enabled = Extract<BillingConfig, { enabled: true }>;

/** What a plan costs, in the major unit of one currency (euros, not cents). */
export interface Amounts { year: number; month: number }
/**
 * The prices a person is shown. **Every amount is what Paddle says about the price the operator named**; nothing is written in the code, so the page and
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

/** How long what Paddle said is believed, and how long the last good answer is kept when Paddle cannot be reached. */
const FRESH_MS = 10 * 60 * 1000;
let cache: { at: number; key: string; prices: Prices } | null = null;
/** When Paddle last failed to answer: it is not asked again for a little while, so a slow outage is not made worse by every visitor to the pricing page. */
let failedAt = 0;
const RETRY_MS = 30_000;
/** Tests: forget what was read. */
export const resetCatalog = (): void => { cache = null; failedAt = 0; inFlight = null; };

interface PaddlePrice { unit_price?: { amount?: string; currency_code?: string }; billing_cycle?: { interval?: string; frequency?: number } | null; status?: string }

async function readPrice(config: Enabled, id: string): Promise<{ amount: number; currency: string; interval: string | null }> {
  const base = config.environment === 'sandbox' ? 'https://sandbox-api.paddle.com' : 'https://api.paddle.com';
  const res = await fetch(`${base}/prices/${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${config.apiKey}` }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`the payment provider answered ${res.status} for a price`);
  const price = ((await res.json()) as { data?: PaddlePrice }).data;
  const minor = Number(price?.unit_price?.amount);
  const currency = price?.unit_price?.currency_code;
  if (!price || price.status === 'archived' || !Number.isInteger(minor) || minor < 0 || !currency) throw new Error('a price the payment provider returned cannot be shown');
  // Paddle's amounts are in the currency's lowest unit; most have two decimals, a few none.
  const digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  return { amount: minor / 10 ** digits, currency, interval: price.billing_cycle?.interval ?? null };
}

/**
 * The prices of the plans on sale, read from Paddle and kept ten minutes. Where Paddle cannot be reached the last answer is still used; with none, or if
 * the prices are not all in one currency, the answer is null and the screens show no amount (and offer no purchase) rather than a guess.
 */
export function loadPrices(config: Enabled, now = Date.now()): Promise<Prices | null> {
  // The pricing page is public: when what Paddle said has gone stale, every visitor at that moment would ask Paddle seven times. One reading serves them all.
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
    const read = new Map(await Promise.all(wanted.map(async id => [id, await readPrice(config, id)] as const)));
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

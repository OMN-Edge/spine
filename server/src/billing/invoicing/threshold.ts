import type { AccountsStore } from 'spine-core/store/types.js';
import type { Sale } from '../provider.js';
import { alertOperator } from './alert.js';
import { bnrRate } from './bnr.js';

/**
 * The EU's yearly threshold for services sold to consumers in other member states (docs/billing.md, "VAT"): under 10,000 EUR in the year, and in the one before, the
 * seller charges its own country's VAT; past it, the buyer's country's, through the one-stop shop. Each invoice records what it counts for (`eu_minor`), and the
 * operator is told at 70% and 90% so that crossing it is never a surprise. Only a consumer (no tax id) in another member state counts; Romania does not.
 */
export const EU_THRESHOLD_MINOR = 10_000 * 100;
/** The member states other than Romania (ISO codes). */
const OTHER_EU = 'AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT SK SI ES SE'.split(' ');

/** What a sale counts for, in minor units of EUR, or null where it counts for nothing (a company, Romania, outside the EU) or the rate could not be had. */
export async function euMinorOf(sale: Sale, rate: (currency: string) => Promise<number> = bnrRate): Promise<number | null> {
  if (sale.buyer.taxId || !OTHER_EU.includes(sale.buyer.country.toUpperCase())) return null;
  const minor = sale.lines.reduce((sum, l) => sum + l.amountMinor, 0);
  if (sale.currency.toUpperCase() === 'EUR') return minor;
  try {
    return Math.round((minor * (await rate(sale.currency))) / (await rate('EUR')));
  } catch {
    return null;
  }
}

export interface EuTotals { year: number; thisYear: number; lastYear: number; limit: number }

export async function euSalesTotals(store: AccountsStore, now = new Date()): Promise<EuTotals> {
  const year = now.getUTCFullYear();
  return { year, thisYear: await store.billing.euSalesMinor(year), lastYear: await store.billing.euSalesMinor(year - 1), limit: EU_THRESHOLD_MINOR };
}

/** Tells the operator once for each of 70%, 90% and 100% of the threshold in a year (the larger of this year's total and last year's, since either counts). */
export async function watchEuThreshold(store: AccountsStore, now = new Date()): Promise<number> {
  const totals = await euSalesTotals(store, now);
  const share = Math.max(totals.thisYear, totals.lastYear) / totals.limit;
  const said = new Set((await store.settings.all()).map(s => s.key));
  let told = 0;
  for (const [percent, label] of [[100, 'has been passed'], [90, 'is at 90%'], [70, 'is at 70%']] as const) {
    if (share < percent / 100) continue;
    const key = `eu_threshold_alerted:${totals.year}:${percent}`;
    if (!said.has(key)) {
      await store.settings.set(key, '1', now.toISOString());
      await alertOperator('the EU consumer sales threshold', [`Sales to consumers in other EU countries ${label}: ${(totals.thisYear / 100).toFixed(2)} EUR this year, ${(totals.lastYear / 100).toFixed(2)} EUR last year, against ${(totals.limit / 100).toFixed(0)} EUR.`, 'Past it, the buyer’s country’s VAT applies and the one-stop shop (OSS): talk to the accountant before the next sale.']);
      told++;
    }
    // Only the highest reached is told of; the lower ones are marked so they are not told later.
    for (const lower of [90, 70]) if (lower < percent) await store.settings.set(`eu_threshold_alerted:${totals.year}:${lower}`, '1', now.toISOString());
    break;
  }
  return told;
}

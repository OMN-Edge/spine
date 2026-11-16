import type { CatalogView } from '../api';

/**
 * What the Products page works out before it asks the server for anything: an amount typed by a person as the whole number of cents the server takes, which prices of a product were
 * changed, how a price is shown, and how the provider is named. Kept apart from the page so each can be tested on its own.
 */
export type CatalogProduct = NonNullable<CatalogView['products']>[number];
export type CatalogPrice = CatalogProduct['prices'][number];
export type Period = CatalogProduct['periods'][number];

/** The largest amount the server accepts, in cents (`MAX_AMOUNT_MINOR` there). */
export const MAX_MINOR = 100_000_00;

/** Whole cents from what was typed ("4.99", "4,99", "49", " 5 "), or null when it is not an amount a price can be: nothing, zero, a negative, text, a third decimal, or too large. */
export function parseAmount(text: string): number | null {
  const t = text.trim().replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const minor = Math.round(Number(t) * 100);
  return minor > 0 && minor <= MAX_MINOR ? minor : null;
}

/** An amount in cents as it is typed back into a field: no cents where there are none, two where there are. */
export function amountText(minor: number): string {
  return minor % 100 === 0 ? String(minor / 100) : (minor / 100).toFixed(2);
}

export function formatMinor(minor: number, currency: string, locale?: string): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency, minimumFractionDigits: minor % 100 === 0 ? 0 : 2 }).format(minor / 100);
}

export type Draft = Partial<Record<Period, string>>;

/** The prices a person changed in a product's fields: the periods whose typed amount is a different amount from the current one, or an error naming the first period whose text is not an amount. */
export function changesOf(product: CatalogProduct, draft: Draft): { changes: Array<{ period: Period; amountMinor: number }> } | { error: Period } {
  const changes: Array<{ period: Period; amountMinor: number }> = [];
  for (const period of product.periods) {
    const typed = draft[period];
    if (typed === undefined) continue;
    const current = product.prices.find(p => p.period === period);
    // A field left as it was, or emptied where there is no price yet, is no change.
    if (typed.trim() === '' && !current) continue;
    const amountMinor = parseAmount(typed);
    if (amountMinor === null) return { error: period };
    if (amountMinor !== current?.amount_minor) changes.push({ period, amountMinor });
  }
  return { changes };
}

export type PriceState = 'none' | 'sent' | 'waiting';
export const stateOf = (price: CatalogPrice | undefined): PriceState => (!price ? 'none' : price.sent ? 'sent' : 'waiting');

/** The provider's name for a person, from its id. */
export const providerName = (id: string | undefined): string => (id ? id.charAt(0).toUpperCase() + id.slice(1) : '');

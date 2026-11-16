import { describe, expect, it } from 'vitest';
import { amountText, changesOf, formatMinor, MAX_MINOR, parseAmount, providerName, stateOf, type CatalogProduct } from './catalog-view';

/** What the Products page works out before it asks the server for anything. */
const product = (over: Partial<CatalogProduct> = {}): CatalogProduct => ({
  id: 'premium', name: 'Premium', description: null, on_sale: true, in_step: true, periods: ['month', 'year'],
  prices: [
    { period: 'month', currency: 'EUR', amount_minor: 499, version: 2, sent: true, earlier: [{ version: 1, amount_minor: 399 }] },
    { period: 'year', currency: 'EUR', amount_minor: 4990, version: 1, sent: false, earlier: [] },
  ], ...over,
});

describe('an amount typed by a person', () => {
  it('becomes whole cents, with a dot or a comma and with or without cents', () => {
    expect(parseAmount('4.99')).toBe(499);
    expect(parseAmount('4,99')).toBe(499);
    expect(parseAmount(' 49 ')).toBe(4900);
    expect(parseAmount('0.5')).toBe(50);
    expect(parseAmount('19.9')).toBe(1990);
    expect(parseAmount('1000.00')).toBe(100_000);
  });

  it('is nothing for what a price cannot be: empty, zero, negative, text, a third decimal, more than one separator, or too large', () => {
    for (const bad of ['', ' ', '0', '0.00', '-1', '-0.5', 'abc', '4.999', '4..9', '4.9.9', '1e3', '€5', '5 €', '12,345', `${MAX_MINOR / 100 + 0.01}`]) expect(parseAmount(bad), bad).toBeNull();
    expect(parseAmount(`${MAX_MINOR / 100}`)).toBe(MAX_MINOR);
  });

  it('is typed back as the amount without cents where there are none, and with two where there are', () => {
    expect(amountText(4900)).toBe('49');
    expect(amountText(499)).toBe('4.99');
    expect(amountText(1990)).toBe('19.90');
    expect(parseAmount(amountText(1990))).toBe(1990);
    for (const minor of [1, 99, 100, 101, 12345, MAX_MINOR]) expect(parseAmount(amountText(minor)), String(minor)).toBe(minor);
  });
});

describe('an amount shown', () => {
  it('has no cents where there are none, and two where there are', () => {
    expect(formatMinor(4900, 'EUR', 'en')).toBe('€49');
    expect(formatMinor(499, 'EUR', 'en')).toBe('€4.99');
    expect(formatMinor(1990, 'EUR', 'en')).toBe('€19.90');
  });
  it('names the provider for a person', () => {
    expect(providerName('stripe')).toBe('Stripe');
    expect(providerName('paddle')).toBe('Paddle');
    expect(providerName(undefined)).toBe('');
  });
  it('says where a price is: none, sent, or waiting to be sent', () => {
    expect(stateOf(undefined)).toBe('none');
    expect(stateOf(product().prices[0])).toBe('sent');
    expect(stateOf(product().prices[1])).toBe('waiting');
  });
});

describe('the prices a person changed', () => {
  it('are the periods whose typed amount differs from the current one, in cents', () => {
    expect(changesOf(product(), { month: '5.49' })).toEqual({ changes: [{ period: 'month', amountMinor: 549 }] });
    expect(changesOf(product(), { month: '5.49', year: '55' })).toEqual({ changes: [{ period: 'month', amountMinor: 549 }, { period: 'year', amountMinor: 5500 }] });
  });

  it('are none where a field is untouched, or typed back to the amount it had, in either spelling', () => {
    expect(changesOf(product(), {})).toEqual({ changes: [] });
    expect(changesOf(product(), { month: '4.99', year: '49.90' })).toEqual({ changes: [] });
    expect(changesOf(product(), { month: '4,99' })).toEqual({ changes: [] });
  });

  it('name the first period whose text is not an amount, and change nothing then', () => {
    expect(changesOf(product(), { month: 'abc' })).toEqual({ error: 'month' });
    expect(changesOf(product(), { month: '5.49', year: '' })).toEqual({ error: 'year' });
    expect(changesOf(product(), { month: '0' })).toEqual({ error: 'month' });
  });

  it('leave a period with no price yet alone while its field is empty, and take it as a first price when an amount is typed', () => {
    const fresh = product({ periods: ['once'], prices: [] });
    expect(changesOf(fresh, { once: '' })).toEqual({ changes: [] });
    expect(changesOf(fresh, {})).toEqual({ changes: [] });
    expect(changesOf(fresh, { once: '19.99' })).toEqual({ changes: [{ period: 'once', amountMinor: 1999 }] });
    expect(changesOf(fresh, { once: 'x' })).toEqual({ error: 'once' });
  });

  it('only look at the periods the product is sold for', () => {
    const yearly = product({ periods: ['year'], prices: [product().prices[1]!] });
    expect(changesOf(yearly, { month: 'abc', year: '60' } as never)).toEqual({ changes: [{ period: 'year', amountMinor: 6000 }] });
  });
});

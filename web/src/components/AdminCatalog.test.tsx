import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../i18n';
import { CatalogActions, firstRun, ProductCard } from './AdminCatalog';
import type { CatalogProduct } from './catalog-view';

/** The parts of the Products page, drawn: what each says, which buttons there are, and that no button is long. */
const product = (over: Partial<CatalogProduct> = {}): CatalogProduct => ({
  id: 'premium', name: 'Spine Premium', description: null, on_sale: true, in_step: false, periods: ['month', 'year'],
  prices: [
    { period: 'month', currency: 'EUR', amount_minor: 499, version: 2, sent: false, earlier: [{ version: 1, amount_minor: 399 }] },
    { period: 'year', currency: 'EUR', amount_minor: 4990, version: 1, sent: true, earlier: [] },
  ], ...over,
});
const noop = async () => undefined;
const card = (p: CatalogProduct, busy = false) => renderToStaticMarkup(<I18nProvider><ProductCard product={p} currency="EUR" busy={busy} period={x => (x === 'month' ? 'Monthly' : x === 'year' ? 'Yearly' : 'Once')} onRename={noop} onSale={noop} onSave={noop} /></I18nProvider>);
const actions = (adoptable: number, busy = false) => renderToStaticMarkup(<I18nProvider><CatalogActions provider="Stripe" adoptable={adoptable} busy={busy} onPublish={() => undefined} onCheck={() => undefined} onImport={() => undefined} /></I18nProvider>);
const buttonTexts = (html: string) => [...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map(m => m[1]!.replace(/<[^>]+>/g, '').trim());

describe('a product on the page', () => {
  it('shows its name and whether it is on sale, with a way to rename it', () => {
    const html = card(product());
    expect(html).toContain('>Spine Premium</h3>');
    expect(html).toContain('>Rename</button>');
    expect(html).toMatch(/<input type="checkbox" checked=""/);
    expect(card(product({ on_sale: false }))).not.toMatch(/<input type="checkbox" checked=""/);
  });

  it('shows each period with its amount in a field, where it is at the provider, and the amounts before', () => {
    const html = card(product());
    expect(html).toContain('Monthly');
    expect(html).toContain('Yearly');
    expect(html).toContain('value="4.99"');
    expect(html).toContain('value="49.90"');
    expect(html).toContain('>Not sent</span>');
    expect(html).toContain('>Sent</span>');
    expect(html).toContain('Earlier: €3.99');
    expect(html).toContain('€</span>');
  });

  it('shows a period with no price as empty, and says so', () => {
    const html = card(product({ periods: ['once'], prices: [] }));
    expect(html).toContain('>No price</span>');
    expect(html).toContain('value=""');
    expect(html).not.toContain('Earlier');
  });

  it('shows no Save until a price is changed (it is drawn untouched), and no invalid mark', () => {
    const html = card(product());
    expect(buttonTexts(html)).toEqual(['Rename']);
    expect(html).not.toContain('aria-invalid="true"');
    expect(html).not.toContain('Not an amount');
  });

  it('has a field for each period the product is sold for and no other', () => {
    expect([...card(product()).matchAll(/inputMode="decimal"/g)]).toHaveLength(2);
    expect([...card(product({ periods: ['year'], prices: [product().prices[1]!] })).matchAll(/inputMode="decimal"/g)]).toHaveLength(1);
  });

  it('disables the on-sale switch and the rename while something is being saved, and not otherwise', () => {
    expect(card(product(), true)).toMatch(/<input type="checkbox"[^>]*disabled=""/);
    expect(card(product(), false)).not.toMatch(/<input type="checkbox"[^>]*disabled=""/);
  });
});

describe('the actions on the whole catalog', () => {
  it('are Publish and Check, and Import only when there is something to import, with the count', () => {
    expect(buttonTexts(actions(0))).toEqual(['Publish', 'Check']);
    expect(buttonTexts(actions(5))).toEqual(['Publish', 'Check', 'Import (5)']);
  });

  it('say what they do in a line beside them, naming the provider, and not in the buttons', () => {
    const html = actions(5);
    expect(html).toContain('Publish sends the new prices to Stripe. Check compares them with what Stripe holds.');
    expect(html).toContain('Import brings in the 5 prices already in use there.');
    expect(actions(0)).not.toContain('Import brings in');
    expect(html).toContain('title="Send the new prices to Stripe"');
  });

  it('are disabled while something is being done', () => {
    for (const text of buttonTexts(actions(5, true))) expect(text).toBeTruthy();
    expect([...actions(5, true).matchAll(/disabled=""/g)]).toHaveLength(3);
    expect([...actions(5, false).matchAll(/disabled=""/g)]).toHaveLength(0);
  });
});

describe('the buttons of the page', () => {
  it('are one or two words, however many products and prices there are (a button with a sentence in it is not allowed)', () => {
    const all = [actions(12), card(product()), card(product({ periods: ['once'], prices: [] })), card(product({ on_sale: false }))].flatMap(buttonTexts);
    expect(all.length).toBeGreaterThan(5);
    for (const text of all) {
      expect(text.split(/\s+/).length, text).toBeLessThanOrEqual(2);
      expect(text.length, text).toBeLessThanOrEqual(14);
    }
  });
});

describe('the first time on the page', () => {
  const html = (props: { adoptable: number; firstRun?: boolean; publishable?: boolean }) => renderToStaticMarkup(<I18nProvider><CatalogActions provider="Stripe" busy={false} onPublish={() => undefined} onCheck={() => undefined} onImport={() => undefined} {...props} /></I18nProvider>);

  it('knows it when prices are on sale at the provider and the catalog holds none', () => {
    expect(firstRun({ adoptable: 8, products: [{ prices: [] }, { prices: [] }] })).toBe(true);
    expect(firstRun({ adoptable: 8, products: [{ prices: [{}] }, { prices: [] }] })).toBe(false);
    expect(firstRun({ adoptable: 0, products: [{ prices: [] }] })).toBe(false);
  });

  it('says what to do: a banner, Import as the one primary button, and Publish disabled with nothing to publish', () => {
    const page = html({ adoptable: 8, firstRun: true, publishable: false });
    expect(page).toContain('8 prices are on sale at Stripe but not in the catalog yet. Import them to edit them here.');
    expect(page.match(/bg-accent px-4/g)).toHaveLength(1);
    expect(page).toMatch(/<button[^>]*bg-accent[^>]*>Import \(8\)<\/button>/);
    expect(page).toMatch(/<button[^>]*disabled=""[^>]*>Publish<\/button>/);
  });

  it('is gone after the import: no banner, Publish primary again when something changed', () => {
    const page = html({ adoptable: 0, firstRun: false, publishable: true });
    expect(page).not.toContain('not in the catalog yet');
    expect(page).toMatch(/<button[^>]*bg-accent[^>]*>Publish<\/button>/);
    expect(page).not.toMatch(/<button[^>]*disabled=""[^>]*>Publish<\/button>/);
  });
});

import { describe, expect, it } from 'vitest';
import { readBillingConfig } from '../billing/config.js';
import { readInvoicingConfig } from '../billing/invoicing/config.js';
import { bnrRate, forgetRates, parseRates } from 'spine-billing/invoicing/bnr.js';

/** The operator's invoicing settings: off unless named, only with Stripe, and every setting of the service named, the VAT said and never assumed. */
const STRIPE = { SPINE_BILLING: 'on', SPINE_BILLING_PROVIDER: 'stripe', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_x', SPINE_STRIPE_PRICE_YEAR: 'p1', SPINE_STRIPE_PRICE_MONTH: 'p2', SPINE_STRIPE_PRICE_FOUNDING: 'p3' };
const read = (env: Record<string, string>) => {
  const problems: string[] = [];
  const billing = readBillingConfig({ ...STRIPE, ...env } as never, 'public', problems);
  const invoicing = readInvoicingConfig({ ...STRIPE, ...env } as never, billing, problems);
  return { invoicing, problems };
};
const BILLYOU = { SPINE_INVOICING: 'billyou', BILLYOU_API_KEY: 'k', BILLYOU_SERIES_ID: 's1' };

describe('the invoicing settings', () => {
  it('are off unless a service is named', () => {
    expect(read({})).toEqual({ invoicing: { enabled: false }, problems: [] });
    expect(read({ SPINE_INVOICING: 'off' }).invoicing).toEqual({ enabled: false });
  });

  it('read a Billyou account, with e-Factura off and the service’s mail on unless said, and no VAT of their own: the buyer’s is decided when an invoice is made', () => {
    const { invoicing, problems } = read(BILLYOU);
    expect(problems).toEqual([]);
    expect(invoicing).toMatchObject({ enabled: true, issuer: 'billyou', vatPercent: 0, efactura: false, mail: true, billyou: { apiKey: 'k', seriesId: 's1', zeroVat: { taxCategory: 'O' } } });
    expect(read({ ...BILLYOU, SPINE_INVOICING_EFACTURA: 'on', SPINE_INVOICING_MAIL: 'off' }).invoicing).toMatchObject({ efactura: true, mail: false });
  });

  it('stop the start with a live Stripe key and no invoicing, which a test key may go without', () => {
    expect(read({}).problems).toEqual([]);
    expect(read({ STRIPE_SECRET_KEY: 'sk_live_not_real' }).problems).toEqual([expect.stringContaining('live Stripe key needs SPINE_INVOICING')]);
    expect(read({ STRIPE_SECRET_KEY: 'sk_live_not_real', ...BILLYOU }).problems).toEqual([]);
  });

  it('stop the start without a service’s settings, and with billing off', () => {
    expect(read({ SPINE_INVOICING: 'billyou' }).problems).toEqual(expect.arrayContaining([expect.stringContaining('BILLYOU_API_KEY'), expect.stringContaining('BILLYOU_SERIES_ID')]));
    expect(read({ SPINE_INVOICING: 'nobody' }).problems.join()).toContain('expected off, billyou or efactura');
    const problems: string[] = [];
    readInvoicingConfig({ ...BILLYOU } as never, { enabled: false } as never, problems);
    expect(problems.join()).toContain('SPINE_INVOICING needs SPINE_BILLING=on');
  });

  it('read no VAT percentage, tax class or exemption code: the VAT follows the buyer’s country and the company’s registration, and only the wording of the art. 310 mention is set', () => {
    // The old settings are ignored, not an error.
    expect(read({ ...BILLYOU, SPINE_INVOICING_VAT_PERCENT: 'abc', SPINE_INVOICING_ZERO_VAT: 'E' })).toMatchObject({ problems: [], invoicing: { vatPercent: 0, billyou: { zeroVat: { taxCategory: 'O' } } } });
    expect((read(BILLYOU).invoicing as { exemptNote?: string }).exemptNote).toBeUndefined();
    expect((read({ ...BILLYOU, SPINE_INVOICING_VAT_NOTE: 'off' }).invoicing as { exemptNote?: string }).exemptNote).toBe('');
    expect((read({ ...BILLYOU, SPINE_INVOICING_VAT_NOTE: 'Scutit de TVA' }).invoicing as { exemptNote?: string }).exemptNote).toBe('Scutit de TVA');
  });
});

const FILE = '<?xml version="1.0" encoding="utf-8"?><DataSet xmlns="https://www.bnr.ro/xsd"><Header><Publisher>National Bank of Romania</Publisher></Header><Body><Cube date="2026-11-13"><Rate currency="EUR">5.3498</Rate><Rate currency="HUF" multiplier="100">1.4619</Rate></Cube></Body></DataSet>';

describe('the National Bank’s rates', () => {
  it('are asked of the file where the bank keeps it now, once an hour, and RON needs none', async () => {
    forgetRates();
    const urls: string[] = [];
    const fetcher = (async (url: string) => { urls.push(String(url)); return new Response(FILE); }) as unknown as typeof fetch;
    expect(await bnrRate('eur', fetcher, 1_000)).toBe(5.3498);
    expect(await bnrRate('EUR', fetcher, 2_000)).toBe(5.3498);
    expect(await bnrRate('RON', fetcher)).toBe(1);
    expect(urls).toEqual(['https://curs.bnr.ro/nbrfxrates.xml']);
    await expect(bnrRate('XXX', fetcher, 3_000)).rejects.toThrow(/no rate for XXX/);
    forgetRates();
  });

  it('are the rate of the day the invoice is dated: the newest published on or before it, from that year\u2019s file, and the latest for a day not before the latest', async () => {
    forgetRates();
    const cube = (date: string, eur: string) => `<Cube date="${date}"><Rate currency="EUR">${eur}</Rate></Cube>`;
    const year = (...cubes: string[]) => `<?xml version="1.0"?><DataSet xmlns="http://www.bnr.ro/xsd"><Body>${cubes.join('')}</Body></DataSet>`;
    const urls: string[] = [];
    const files: Record<string, string> = {
      'https://curs.bnr.ro/nbrfxrates.xml': year(cube('2026-11-19', '5.1000')),
      'https://curs.bnr.ro/files/xml/years/nbrfxrates2026.xml': year(cube('2026-01-02', '4.9000'), cube('2026-11-13', '5.3498'), cube('2026-11-16', '5.2000'), cube('2026-11-19', '5.1000')),
      'https://curs.bnr.ro/files/xml/years/nbrfxrates2025.xml': year(cube('2025-12-30', '4.8500'), cube('2025-12-31', '4.8600')),
    };
    const fetcher = (async (url: string) => { urls.push(String(url)); return new Response(files[String(url)] ?? 'missing', { status: files[String(url)] ? 200 : 404 }); }) as unknown as typeof fetch;
    // Today's and a later day: the latest file alone.
    expect(await bnrRate('EUR', fetcher, 1_000, '2026-11-19')).toBe(5.1);
    expect(urls).toEqual(['https://curs.bnr.ro/nbrfxrates.xml']);
    // A Saturday takes Friday's; a day with its own rate, its own; the year's file is read once.
    expect(await bnrRate('EUR', fetcher, 2_000, '2026-11-14')).toBe(5.3498);
    expect(await bnrRate('EUR', fetcher, 3_000, '2026-11-16')).toBe(5.2);
    expect(urls.filter(u => u.includes('2026.xml'))).toHaveLength(1);
    // The first days of a year before its first publication take the year before's last.
    files['https://curs.bnr.ro/files/xml/years/nbrfxrates2026.xml'] = year(cube('2026-01-05', '4.9500'), cube('2026-11-19', '5.1000'));
    forgetRates();
    expect(await bnrRate('EUR', fetcher, 4_000, '2026-01-01')).toBe(4.86);
    forgetRates();
  });

  it('say that the file has moved, not that a rate is missing, when the bank answers with its web page', async () => {
    forgetRates();
    const page = (async () => new Response('<!doctype html><html><title>BNR</title></html>')) as unknown as typeof fetch;
    await expect(bnrRate('EUR', page)).rejects.toThrow(/not at the address/);
    forgetRates();
  });

  it('are read from its file, a quote for a hundred units as one', () => {
    const rates = parseRates('<Cube date="2026-11-13"><Rate currency="EUR">4.9772</Rate><Rate currency="HUF" multiplier="100">1.2500</Rate></Cube>');
    expect(rates.get('EUR')).toBe(4.9772);
    expect(rates.get('HUF')).toBe(0.0125);
  });
});

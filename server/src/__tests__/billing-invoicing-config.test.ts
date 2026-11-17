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
const BILLYOU = { SPINE_INVOICING: 'billyou', SPINE_INVOICING_VAT_PERCENT: '21', BILLYOU_API_KEY: 'k', BILLYOU_SERIES_ID: 's1' };

describe('the invoicing settings', () => {
  it('are off unless a service is named', () => {
    expect(read({})).toEqual({ invoicing: { enabled: false }, problems: [] });
    expect(read({ SPINE_INVOICING: 'off' }).invoicing).toEqual({ enabled: false });
  });

  it('read a Billyou account, with e-Factura off and the service’s mail on unless said', () => {
    const { invoicing, problems } = read(BILLYOU);
    expect(problems).toEqual([]);
    expect(invoicing).toMatchObject({ enabled: true, issuer: 'billyou', vatPercent: 21, efactura: false, mail: true, billyou: { apiKey: 'k', seriesId: 's1', zeroVat: null } });
    expect(read({ ...BILLYOU, SPINE_INVOICING_EFACTURA: 'on', SPINE_INVOICING_MAIL: 'off' }).invoicing).toMatchObject({ efactura: true, mail: false });
  });

  it('stop the start without the VAT, without a service’s settings, and with Paddle, which sends its own invoices', () => {
    expect(read({ SPINE_INVOICING: 'billyou' }).problems).toEqual(expect.arrayContaining([expect.stringContaining('SPINE_INVOICING_VAT_PERCENT'), expect.stringContaining('BILLYOU_API_KEY'), expect.stringContaining('BILLYOU_SERIES_ID')]));
    expect(read({ ...BILLYOU, SPINE_INVOICING_VAT_PERCENT: 'abc' }).problems.join()).toContain('expected a number');
    expect(read({ SPINE_INVOICING: 'nobody' }).problems.join()).toContain('expected off, billyou or efactura');
    const problems: string[] = [];
    readInvoicingConfig({ ...BILLYOU } as never, { enabled: true, provider: 'paddle' } as never, problems);
    expect(problems.join()).toContain('Paddle is the seller');
  });

  it('need the tax class of a line with no VAT, and an exemption code with the exempt class', () => {
    expect(read({ ...BILLYOU, SPINE_INVOICING_VAT_PERCENT: '0' }).problems.join()).toContain('SPINE_INVOICING_ZERO_VAT');
    expect(read({ ...BILLYOU, SPINE_INVOICING_VAT_PERCENT: '0', SPINE_INVOICING_ZERO_VAT: 'o' }).invoicing).toMatchObject({ billyou: { zeroVat: { taxCategory: 'O' } } });
    expect(read({ ...BILLYOU, SPINE_INVOICING_VAT_PERCENT: '0', SPINE_INVOICING_ZERO_VAT: 'E' }).problems.join()).toContain('SPINE_INVOICING_EXEMPTION_CODE');
    expect(read({ ...BILLYOU, SPINE_INVOICING_VAT_PERCENT: '0', SPINE_INVOICING_ZERO_VAT: 'E', SPINE_INVOICING_EXEMPTION_CODE: 'VATEX-EU-132' }).invoicing).toMatchObject({ billyou: { zeroVat: { taxCategory: 'E', vatExemptionCode: 'VATEX-EU-132' } } });
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

describe('one company on the pages and on the invoice', () => {
  const efactura = (name: string) => ({ enabled: true as const, issuer: 'efactura' as const, vatPercent: 0, efactura: true as const, mail: false as const, direct: { seller: { name } } as never });
  it('says nothing where the names are the same, however they are written', async () => {
    const { sellerNameWarning } = await import('../billing/invoicing/config.js');
    expect(sellerNameWarning(efactura('Exemplu Software SRL'), 'Exemplu Software SRL')).toBeNull();
    expect(sellerNameWarning(efactura('Exemplu Software S.R.L.'), ' exemplu software srl ')).toBeNull();
  });
  it('warns where they differ, or the operator’s is not set, and only where Spine makes the invoices', async () => {
    const { sellerNameWarning } = await import('../billing/invoicing/config.js');
    expect(sellerNameWarning(efactura('Exemplu Software SRL'), 'Altă Firmă SRL')).toContain('two companies');
    expect(sellerNameWarning(efactura('Exemplu Software SRL'), undefined)).toContain('SPINE_OPERATOR_NAME is not set');
    expect(sellerNameWarning({ enabled: false }, 'x')).toBeNull();
  });
});

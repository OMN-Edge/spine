import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { getAccountsStore } from 'spine-core/store/index.js';
import { forgetRates } from 'spine-billing/invoicing/bnr.js';
import { buildTestApp } from './helpers/app.js';
import { changeSeller } from '../billing/invoicing/seller.js';
import { changeVat } from '../billing/invoicing/vat.js';

/** From a payment to an invoice, through the route: Stripe's signed message, the sale read back from Stripe, the invoice made at Billyou (both scripted). */
const SECRET = 'whsec_invoicing_route';
const ENV = {
  SPINE_BILLING: 'on', SPINE_BILLING_PROVIDER: 'stripe', STRIPE_SECRET_KEY: 'sk_test_route', STRIPE_WEBHOOK_SECRET: SECRET,
  SPINE_STRIPE_PRICE_YEAR: 'pri_year', SPINE_STRIPE_PRICE_MONTH: 'pri_month', SPINE_STRIPE_PRICE_FOUNDING: 'pri_founding',
  SPINE_INVOICING: 'billyou', SPINE_INVOICING_VAT_PERCENT: '21', BILLYOU_API_KEY: 'bk_route_not_real', BILLYOU_SERIES_ID: 'series_1', SPINE_INVOICING_MAIL: 'off',
};
const sign = (body: string) => { const t = Math.floor(Date.now() / 1000); return `t=${t},v1=${createHmac('sha256', SECRET).update(`${t}.${body}`).digest('hex')}`; };

describe('a payment on its way to an invoice', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  const dir = mkdtempSync(path.join(tmpdir(), 'spine-invoicing-route-'));
  const saved: Record<string, string | undefined> = {};
  beforeAll(async () => {
    process.env.DATA_DIR = dir;
    for (const k of Object.keys(ENV)) saved[k] = process.env[k];
    Object.assign(process.env, ENV);
    app = await buildTestApp();
  });
  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  afterEach(() => { vi.unstubAllGlobals(); forgetRates(); });

  /** Stripe, the National Bank and Billyou, as far as the route asks them. */
  function services(billyou: (url: string, method: string, body: unknown) => { status?: number; json: unknown }) {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: { method?: string; body?: string }) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      const json = (j: unknown, status = 200) => new Response(JSON.stringify(j), { status });
      if (url.startsWith('https://api.stripe.com/v1/checkout/sessions?payment_intent=')) return json({ data: [{ id: 'cs_route' }] });
      if (url.startsWith('https://api.stripe.com/v1/invoice_payments')) return json({ data: [] });
      if (url.includes('/line_items')) return json({ data: [{ price: { id: 'pri_year' } }] });
      if (url.startsWith('https://api.stripe.com/v1/checkout/sessions/cs_route')) {
        return json({ id: 'cs_route', currency: 'eur', created: 1_794_000_000, customer_details: { name: 'Eva Test', email: 'eva@spine.test', address: { country: 'FR', city: 'Paris', state: 'Ile-de-France' } }, line_items: { data: [{ description: 'Spine Premium', amount_total: 5929, quantity: 1 }] } });
      }
      if (url.startsWith('https://curs.bnr.ro')) return new Response('<DataSet><Body><Cube date="2026-01-01"><Rate currency="EUR">4.9772</Rate></Cube></Body></DataSet>');
      const b = billyou(url, init?.method ?? 'GET', init?.body ? JSON.parse(init.body) : undefined);
      return json(b.json, b.status);
    }));
    return calls;
  }
  const deliver = async () => {
    const raw = JSON.stringify({ id: 'evt_route', type: 'checkout.session.completed', created: 1_794_000_000, data: { object: { id: 'cs_route', mode: 'subscription', payment_status: 'paid', amount_total: 5929, client_reference_id: 'nobody', customer: 'cus_route', subscription: 'sub_route' } } });
    return app.inject({ method: 'POST', url: '/api/billing/webhook', headers: { 'content-type': 'application/json', 'stripe-signature': sign(raw) }, payload: raw });
  };

  it('is invoiced when the message arrives, from the sale as Stripe tells it, and acknowledged', async () => {
    const posted: Array<{ url: string; body: any }> = [];
    services((url, method, body) => {
      if (method === 'POST') posted.push({ url, body });
      if (url.includes('/clients?search')) return { json: { success: true, data: [] } };
      if (url.endsWith('/clients')) return { json: { success: true, data: { _id: 'c_1' } } };
      if (url.endsWith('/invoices')) return { json: { success: true, data: { invoiceId: 'i_1', serialNumber: 'SPN-00001', isDraft: false } } };
      if (url.endsWith('/payments')) return { json: { success: true, data: { data: [], paymentStatus: 'paid' } } };
      return { status: 404, json: { success: false } };
    });
    // The company is registered for VAT, without the One Stop Shop (a service takes only Romania's rates): a buyer in France is charged 21%.
    const store = getAccountsStore();
    expect(await changeSeller(store, { name: 'Exemplu SRL', cif: '12345678', vatId: 'RO12345678', street: 's', city: 'c', county: 'CJ', postalCode: '1' }, '2026-01-01T00:00:00.000Z')).toBeNull();
    expect(await changeVat(store, { registered: true, from: '2026-01-01', oss: false }, '2026-01-01T00:00:00.000Z')).toBeNull();
    const res = await deliver();
    expect(res.statusCode).toBe(200);
    expect(await getAccountsStore().billing.invoice('cs_route')).toMatchObject({ state: 'done', issuer_ref: 'i_1', series: 'SPN', number: '00001' });
    const invoice = posted.find(p => p.url.endsWith('/invoices'))!.body;
    expect(invoice).toMatchObject({ clientId: 'c_1', seriesId: 'series_1', currency: 'EUR', exchangeRate: 4.9772, notes: 'Plata cs_route' });
    // 59.29 paid, 21% in it: 49.00 before VAT.
    expect(invoice.services[0]).toMatchObject({ description: 'Spine Premium', unitPrice: 49, vatRate: 21 });
  });

  it('is acknowledged when the invoicing service is down, and left on the queue to be tried again, and a payment told twice is invoiced once', async () => {
    const calls = services(() => ({ status: 503, json: { success: false, errorCode: 'INTERNAL_ERROR' } }));
    const raw = JSON.stringify({ id: 'evt_route_down', type: 'checkout.session.completed', created: 1_794_000_100, data: { object: { id: 'cs_route_down', mode: 'subscription', payment_status: 'paid', amount_total: 5929, client_reference_id: 'nobody', customer: 'cus_route', subscription: 'sub_route_down' } } });
    const send = () => app.inject({ method: 'POST', url: '/api/billing/webhook', headers: { 'content-type': 'application/json', 'stripe-signature': sign(raw) }, payload: raw });
    expect((await send()).statusCode).toBe(200);
    const row = (await getAccountsStore().billing.invoice('cs_route_down'))!;
    expect(row).toMatchObject({ state: 'pending', attempts: 1, issuer_ref: null });
    expect(row.last_error).toContain('503');
    // Told again at once: it is not yet its time, so the service is not asked again.
    const before = calls.filter(c => c.includes('billyou')).length;
    expect((await send()).statusCode).toBe(200);
    expect(calls.filter(c => c.includes('billyou')).length).toBe(before);
    expect((await getAccountsStore().billing.invoice('cs_route_down'))!.attempts).toBe(1);
  });

  it('reverses the invoice when the payment is refunded: the refund is traced to the queue, a storno is made, and the plan is left alone', async () => {
    const posted: string[] = [];
    services((url, method) => {
      if (method === 'POST') posted.push(url);
      if (url.endsWith('/storno')) return { status: 201, json: { success: true, data: { invoiceId: 'i_storno', serialNumber: 'SPN-00002', originalInvoiceId: 'i_1', isDraft: false } } };
      return { status: 404, json: { success: false } };
    });
    const raw = JSON.stringify({ id: 'evt_refund', type: 'charge.refunded', created: 1_794_000_200, data: { object: { id: 'ch_route', amount: 5929, amount_refunded: 5929, refunded: true, currency: 'eur', payment_intent: 'pi_route' } } });
    const res = await app.inject({ method: 'POST', url: '/api/billing/webhook', headers: { 'content-type': 'application/json', 'stripe-signature': sign(raw) }, payload: raw });
    expect(res.statusCode).toBe(200);
    expect(posted).toEqual(['https://app.billyou.ro/api/invoices/i_1/storno']);
    expect(await getAccountsStore().billing.invoice('storno:cs_route')).toMatchObject({ state: 'done', issuer_ref: 'i_storno', series: 'SPN', number: '00002' });
    // The same refund told again makes no second storno.
    posted.length = 0;
    await app.inject({ method: 'POST', url: '/api/billing/webhook', headers: { 'content-type': 'application/json', 'stripe-signature': sign(raw) }, payload: raw });
    expect(posted).toEqual([]);
  });
});

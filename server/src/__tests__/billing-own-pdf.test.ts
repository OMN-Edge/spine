import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { getAccountsStore } from 'spine-core/store/index.js';
import { processInvoice, reverseRefunded, type InvoicingContext } from '../billing/invoicing/queue.js';
import { loadInvoicingConfig } from '../billing/invoicing/config.js';
import { loadBillingConfig } from '../billing/config.js';
import { keepDocument } from '../billing/invoicing/own-pdf.js';
import { readSeller } from '../billing/invoicing/seller.js';
import type { InvoiceIssuer, IssuedInvoice } from 'spine-billing/invoicing/issuer.js';
import type { Sale } from '../billing/provider.js';
import { buildTestApp, loginAs } from './helpers/app.js';
import { createTestUser, TEST_PASSWORD } from './helpers/seed.js';

/**
 * Spine's own PDF of an invoice Billyou issued (`billing/invoicing/own-pdf.ts`): the seller comes from the admin page, a copy of the invoice is kept when it is made, the PDF is made from
 * the copy (so the seller's or the buyer's later changes do not touch it), a refund gives a credit note naming the invoice, and where there is no copy the service's PDF is served.
 */
const ADMIN = 'admin-own-pdf@spine.test';
const ENV = {
  SPINE_BILLING: 'on', SPINE_BILLING_PROVIDER: 'stripe', STRIPE_SECRET_KEY: 'sk_test_ownpdf', STRIPE_WEBHOOK_SECRET: 'whsec_ownpdf',
  SPINE_STRIPE_PRICE_YEAR: 'pri_year', SPINE_STRIPE_PRICE_MONTH: 'pri_month', SPINE_STRIPE_PRICE_FOUNDING: 'pri_founding',
  SPINE_INVOICING: 'billyou', SPINE_INVOICING_VAT_PERCENT: '0', SPINE_INVOICING_ZERO_VAT: 'O', SPINE_INVOICING_MAIL: 'off', BILLYOU_API_KEY: 'bk_ownpdf_not_real', BILLYOU_SERIES_ID: 'series_1',
};
const SELLER = {
  name: 'Exemplu Software SRL', cif: 'RO 12345678', registerNo: 'J40/1234/2020', street: 'Strada Exemplului 1', city: 'Cluj-Napoca', county: 'cj', postalCode: '400000',
  email: 'billing@example.com', phone: '+40 700 000 000',
  accounts: [{ iban: 'ro49 aaaa 1b31 0075 9384 0000', bank: 'Banca Exemplu', bic: 'exmpro22', currency: 'ron' }, { iban: 'RO12BBBB1B31007593840001', bank: 'Banca Exemplu', bic: 'EXMPRO22', currency: 'EUR' }],
};
const SALE: Sale = { paidAt: '2026-11-15T10:00:00.000Z', currency: 'EUR', buyer: { name: 'Jonas Beispiel', email: 'jonas@example.com', country: 'DE', city: 'München', address: 'Musterstraße 12' }, lines: [{ name: 'Spine Premium', amountMinor: 1900, quantity: 1 }] };

async function textOf(pdf: Buffer): Promise<string> {
  const loaded = await getDocument({ data: new Uint8Array(pdf), useSystemFonts: false }).promise;
  let out = '';
  for (let i = 1; i <= loaded.numPages; i++) out += ` ${(await (await loaded.getPage(i)).getTextContent()).items.map(it => ('str' in it ? it.str : '')).join(' ')}`;
  return out.replace(/\s+/g, ' ');
}

describe('Spine’s own PDF of an invoice a service issued', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  const dir = mkdtempSync(path.join(tmpdir(), 'spine-own-pdf-'));
  const saved: Record<string, string | undefined> = {};
  const store = () => getAccountsStore();
  beforeAll(async () => {
    process.env.DATA_DIR = dir;
    for (const k of Object.keys(ENV)) saved[k] = process.env[k];
    Object.assign(process.env, ENV);
    app = await buildTestApp({ admin: { admins: () => new Set([ADMIN]), readers: () => new Set([ADMIN]) } });
    await createTestUser(ADMIN);
  });
  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  afterEach(() => vi.unstubAllGlobals());

  const issuer = (): InvoiceIssuer => ({
    id: 'billyou', repeatSafe: true,
    async issue(): Promise<IssuedInvoice> { return { id: 'inv_own_1', series: 'TEST', number: '00022', link: null }; },
    async pdfUrl() { return 'https://files.example/billyou.pdf'; },
    async reverse() { return { id: 'inv_own_2', series: 'TEST', number: '00023', link: null }; },
    async sendToAnaf() { return { sent: false, code: -1, text: 'not required' }; },
  });
  const context = (now: string): InvoicingContext => {
    const config = loadInvoicingConfig(loadBillingConfig());
    if (!config.enabled) throw new Error('invoicing is off');
    return { issuer: issuer(), config, readSale: async () => SALE, now: () => new Date(now), keep: keepDocument(config, () => new Date(now)) };
  };
  async function buyer(name: string) {
    const user = await createTestUser(`${name}@spine.test`);
    return { ...user, cookie: await loginAs(app, user.email, TEST_PASSWORD) };
  }
  const T0 = '2026-11-16T10:00:00.000Z';

  it('checks the seller like the environment’s: the tax number, the county, an IBAN and a BIC, and writes them down in their usual form', () => {
    expect(readSeller({ ...SELLER, cif: 'abc' })).toMatchObject({ ok: false });
    expect(readSeller({ ...SELLER, county: 'B' })).toMatchObject({ ok: false, error: expect.stringContaining('sector') });
    expect(readSeller({ ...SELLER, accounts: [{ iban: 'not an iban' }] })).toMatchObject({ ok: false });
    expect(readSeller({ ...SELLER, accounts: [{ iban: 'RO49AAAA1B31007593840000', bic: 'xx' }] })).toMatchObject({ ok: false });
    const read = readSeller(SELLER);
    expect(read).toMatchObject({ ok: true, seller: { cif: '12345678', county: 'CJ', accounts: [{ iban: 'RO49 AAAA 1B31 0075 9384 0000', bic: 'EXMPRO22', currency: 'RON' }, { iban: 'RO12BBBB1B31007593840001' }] } });
  });

  it('lets an administrator save the seller and a reader see it, and nobody else', async () => {
    const admin = await loginAs(app, ADMIN, TEST_PASSWORD);
    const nobody = (await buyer('own-pdf-nobody')).cookie;
    expect((await app.inject({ method: 'GET', url: '/api/admin/seller', headers: { cookie: nobody } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PUT', url: '/api/admin/seller', headers: { cookie: nobody }, payload: SELLER })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PUT', url: '/api/admin/seller', headers: { cookie: admin }, payload: { ...SELLER, cif: '' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/admin/seller', headers: { cookie: admin } })).json()).toMatchObject({ seller: null, issuer: 'billyou', can_edit: true });
    const saved = await app.inject({ method: 'PUT', url: '/api/admin/seller', headers: { cookie: admin }, payload: SELLER });
    expect(saved.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/admin/seller', headers: { cookie: admin } })).json().seller).toMatchObject({ name: 'Exemplu Software SRL', cif: '12345678', phone: '+40 700 000 000' });
  });

  it('keeps a copy of the invoice when it is made, serves Spine’s own PDF from it, and does not follow a later change of the seller', async () => {
    const b = await buyer('own-pdf-a');
    const admin = await loginAs(app, ADMIN, TEST_PASSWORD);
    await app.inject({ method: 'PUT', url: '/api/admin/seller', headers: { cookie: admin }, payload: SELLER });
    await store().billing.queueInvoice('cs_own_a', b.id, T0);
    expect(await processInvoice('cs_own_a', context(T0))).toBe('done');
    const kept = JSON.parse((await store().billing.invoiceDocument('cs_own_a'))!);
    expect(kept).toMatchObject({ kind: 'invoice', id: 'TEST-00022', issueDate: '2026-11-15', currency: 'EUR', note: 'Payment cs_own_a', seller: { name: 'Exemplu Software SRL' }, buyer: { name: 'Jonas Beispiel', country: 'DE' } });
    // The seller changes: the invoice already made keeps the seller it was made with.
    await app.inject({ method: 'PUT', url: '/api/admin/seller', headers: { cookie: admin }, payload: { ...SELLER, name: 'Another Company SRL' } });
    const link = (await app.inject({ method: 'POST', url: '/api/billing/invoices/pdf', headers: { cookie: b.cookie }, payload: { ref: 'cs_own_a' } })).json().url as string;
    expect(link).toMatch(/^\/api\/billing\/invoice-pdf\/cs_own_a\?t=/);
    const pdf = await app.inject({ method: 'GET', url: link });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    const text = await textOf(pdf.rawPayload);
    for (const shown of ['TEST-00022', 'Exemplu Software SRL', 'RO-CJ', 'RO49 AAAA 1B31 0075 9384 0000 (RON)', 'BIC EXMPRO22', '+40 700 000 000', 'Jonas Beispiel', 'Rechnung', 'Payment cs_own_a', 'Valid without stamp or signature']) expect(text).toContain(shown);
    expect(text).not.toContain('Another Company');
    // A link that is not signed for this invoice gives nothing.
    expect((await app.inject({ method: 'GET', url: '/api/billing/invoice-pdf/cs_own_a?t=1.nope' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: link.replace('cs_own_a', 'cs_other') })).statusCode).toBe(404);
  });

  it('makes the credit note of a refund from the invoice, naming it, and serves it the same way', async () => {
    const b = await buyer('own-pdf-b');
    await store().billing.queueInvoice('cs_own_b', b.id, T0);
    const ctx = context(T0);
    expect(await processInvoice('cs_own_b', ctx)).toBe('done');
    await reverseRefunded(['cs_own_b'], true, 're_own_b', ctx);
    const credit = JSON.parse((await store().billing.invoiceDocument('storno:cs_own_b'))!);
    expect(credit).toMatchObject({ kind: 'credit', id: 'TEST-00023', reverses: 'TEST-00022', issueDate: '2026-11-16' });
    const link = (await app.inject({ method: 'POST', url: '/api/billing/invoices/pdf', headers: { cookie: b.cookie }, payload: { ref: 'storno:cs_own_b' } })).json().url as string;
    const text = await textOf((await app.inject({ method: 'GET', url: link })).rawPayload);
    expect(text).toContain('Credit note');
    expect(text).toContain('TEST-00022');
  });

  it('serves the service’s own PDF where no copy was kept (an invoice made before a seller was saved)', async () => {
    const b = await buyer('own-pdf-c');
    await store().billing.queueInvoice('cs_own_c', b.id, T0);
    await store().billing.updateInvoice('cs_own_c', { state: 'done', issuer_ref: 'inv_own_c', series: 'TEST', number: '00001' }, T0);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (String(url).endsWith('/invoices/inv_own_c/pdf')
      ? new Response(JSON.stringify({ success: true, data: { downloadUrl: 'https://files.example/billyou.pdf', expiresIn: 600 } }))
      : new Response('{}', { status: 404 }))));
    expect((await app.inject({ method: 'POST', url: '/api/billing/invoices/pdf', headers: { cookie: b.cookie }, payload: { ref: 'cs_own_c' } })).json()).toEqual({ url: 'https://files.example/billyou.pdf' });
  });

  it('keeps no copy while there is no seller, and the invoice is made all the same', async () => {
    await store().settings.clear('invoice.seller');
    const b = await buyer('own-pdf-d');
    await store().billing.queueInvoice('cs_own_d', b.id, T0);
    expect(await processInvoice('cs_own_d', context(T0))).toBe('done');
    expect(await store().billing.invoiceDocument('cs_own_d')).toBeNull();
  });
});

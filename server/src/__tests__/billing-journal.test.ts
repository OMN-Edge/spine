import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { getAccountsStore } from 'spine-core/store/index.js';
import { forgetRates } from 'spine-billing/invoicing/bnr.js';
import type { UblDocument } from 'spine-anaf/index.js';
import { buildTestApp, loginAs } from './helpers/app.js';
import { createTestUser, TEST_PASSWORD } from './helpers/seed.js';
import { changeSeller } from '../billing/invoicing/seller.js';
import { buildJournal } from '../billing/invoicing/journal.js';

/** The month's summary for the accountant: what it lists, in which form, to whom, and that nothing outside the month or the rules gets in. */
const ADMIN = 'admin-journal@spine.test';
const SELLER = { name: 'Omni Edge SRL', cif: '12345678', registerNo: 'J40/1234/2020', street: 'Str. Exemplului 1', city: 'Sector 1', county: 'B', sector: '1', postalCode: '010101' };
const ENV = {
  SPINE_BILLING: 'on', SPINE_BILLING_PROVIDER: 'stripe', STRIPE_SECRET_KEY: 'sk_test_journal', STRIPE_WEBHOOK_SECRET: 'whsec_journal',
  SPINE_STRIPE_PRICE_YEAR: 'pri_year', SPINE_STRIPE_PRICE_MONTH: 'pri_month', SPINE_STRIPE_PRICE_FOUNDING: 'pri_founding',
  SPINE_INVOICING_PROVIDER: 'efactura', SPINE_INVOICING_VAT_PERCENT: '0', SPINE_INVOICING_ZERO_VAT: 'O', SPINE_DOMAIN: 'spine.test',
  ANAF_CLIENT_ID: 'client-id', ANAF_CLIENT_SECRET: 'client-secret', SPINE_EFACTURA_REDIRECT_URI: 'https://spine.test/api/admin/efactura/callback', SPINE_EFACTURA_KEY: Buffer.alloc(32, 7).toString('base64'),
};
const doc = (over: Partial<UblDocument> & { id: string; issueDate: string }): UblDocument => ({
  kind: 'invoice', currency: 'EUR', seller: SELLER, buyer: { name: 'Ion Popescu', country: 'RO', street: 'Str. Mare 5', city: 'Cluj-Napoca', county: 'CJ' },
  lines: [{ name: 'Spine Premium, lunar', quantity: 1, netMinor: 1190, vatPercent: 0 }], zeroVat: { category: 'O', note: 'Scutit de TVA' }, paid: true, ...over,
});
const cube = (date: string, eur: string) => `<Cube date="${date}"><Rate currency="EUR">${eur}</Rate></Cube>`;
const bank = (...cubes: string[]) => `<?xml version="1.0"?><DataSet xmlns="http://www.bnr.ro/xsd"><Body>${cubes.join('')}</Body></DataSet>`;

describe('the month’s invoices for the accountant', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  const dir = mkdtempSync(path.join(tmpdir(), 'spine-journal-'));
  const saved: Record<string, string | undefined> = {};
  const store = () => getAccountsStore().billing;
  /** An e-Factura document of the month, numbered and made from `input`. */
  const efactura = async (draftId: string, number: number, input: UblDocument, state: 'ok' | 'sent' | 'nok' | 'abroad' | null = 'ok') => {
    await store().efacturaReserve(draftId, input.kind, 'SPN', input.issueDate, '2026-11-20T00:00:00.000Z', input.reverses ?? null);
    await store().efacturaUpdateDocument(draftId, { input: JSON.stringify(input), xml: '<Invoice/>', ...(state ? { anaf_state: state } : {}) }, '2026-11-20T00:00:00.000Z');
    return number;
  };
  beforeAll(async () => {
    process.env.DATA_DIR = dir;
    for (const k of Object.keys(ENV)) saved[k] = process.env[k];
    Object.assign(process.env, ENV);
    app = await buildTestApp({ accounts: { registration: 'approval' }, admin: { admins: () => new Set([ADMIN]), readers: () => new Set([ADMIN, 'reader-journal@spine.test']) } });
    await createTestUser(ADMIN);
    await createTestUser('reader-journal@spine.test');
    expect(await changeSeller(getAccountsStore(), SELLER, '2026-11-01T00:00:00.000Z')).toBeNull();
    // Three e-Factura documents in November (an invoice, a person with no id, a credit note for the first) and one in October; a service's copy dated in November and one in December.
    await efactura('cs_a', 1, doc({ id: 'SPN-00001', issueDate: '2026-11-05' }));
    await efactura('cs_b', 2, doc({ id: 'SPN-00002', issueDate: '2026-11-14', buyer: { name: '=HYPERLINK("http://evil.test")', country: 'RO', street: 's', city: 'c', county: 'CJ' }, lines: [{ name: 'Plan', quantity: 1, netMinor: 5000, vatPercent: 0 }] }), 'sent');
    await efactura('credit:cs_a', 3, doc({ id: 'SPN-00003', issueDate: '2026-11-18', kind: 'credit', reverses: 'SPN-00001', note: 'Rambursare' }));
    await efactura('cs_oct', 4, doc({ id: 'SPN-00000', issueDate: '2026-10-31' }));
    await store().keepInvoiceDocument('cs_svc', JSON.stringify(doc({ id: 'BY-0007', issueDate: '2026-11-09', currency: 'RON', buyer: { name: 'Eva Test', country: 'FR', street: 's', city: 'Paris' }, note: 'Payment cs_svc' })), '2026-11-09T10:00:00.000Z');
    await store().keepInvoiceDocument('cs_dec', JSON.stringify(doc({ id: 'BY-0008', issueDate: '2026-12-02' })), '2026-12-02T10:00:00.000Z');
  });
  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  afterEach(() => { vi.unstubAllGlobals(); forgetRates(); });
  const stubBank = () => vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const files: Record<string, string> = {
      'https://curs.bnr.ro/nbrfxrates.xml': bank(cube('2026-11-19', '5.1000')),
      'https://curs.bnr.ro/files/xml/years/nbrfxrates2026.xml': bank(cube('2026-11-05', '5.0000'), cube('2026-11-13', '5.0500'), cube('2026-11-18', '5.1500'), cube('2026-11-19', '5.1000')),
    };
    return new Response(files[String(url)] ?? 'missing', { status: files[String(url)] ? 200 : 404 });
  }));
  const as = (email: string) => loginAs(app, email, TEST_PASSWORD);

  it('lists the invoices and credit notes dated in the month, from both kinds of document, and nothing dated in another', async () => {
    stubBank();
    const made = await buildJournal('2026-11', () => new Date('2026-12-01T09:00:00Z'));
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(made.journal.rows.map(r => r.number)).toEqual(['SPN-00001', 'BY-0007', 'SPN-00002', 'SPN-00003']);
    expect(made.journal).toMatchObject({ period: '2026-11', preparedOn: '2026-12-01', seller: { name: 'Omni Edge SRL' } });
  });

  it('gives a credit note its amounts negative and the invoice it reverses, each row its rate of its own day, and a person with no tax number the thirteen zeros', async () => {
    stubBank();
    const made = await buildJournal('2026-11');
    if (!made.ok) throw new Error(made.error);
    const [first, service, second, credit] = made.journal.rows;
    expect(first).toMatchObject({ kind: 'invoice', date: '2026-11-05', currency: 'EUR', netMinor: 1190, vatMinor: 0, grossMinor: 1190, rate: 5, ronMinor: 5950, taxId: '0000000000000', anaf: 'ok', reference: 'cs_a' });
    // The Saturday-free case: the 14th has no rate of its own, so the 13th's.
    expect(second).toMatchObject({ rate: 5.05, ronMinor: 25250, anaf: 'sent' });
    expect(credit).toMatchObject({ kind: 'credit', date: '2026-11-18', netMinor: -1190, grossMinor: -1190, rate: 5.15, ronMinor: -6129, reverses: 'SPN-00001', reference: 'SPN-00001' });
    // A copy of a service's invoice in lei: rate 1, no bank call needed for it, the payment's reference from its note, nothing said of ANAF.
    expect(service).toMatchObject({ number: 'BY-0007', currency: 'RON', rate: 1, ronMinor: 1190, taxId: '', reference: 'cs_svc', anaf: null });
  });

  it('leaves the rate and the total in lei empty, and says nothing false, when the bank cannot be asked', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const made = await buildJournal('2026-11');
    if (!made.ok) throw new Error(made.error);
    expect(made.journal.rows.find(r => r.number === 'SPN-00001')).toMatchObject({ rate: null, ronMinor: null });
    expect(made.journal.rows.find(r => r.number === 'BY-0007')).toMatchObject({ rate: 1, ronMinor: 1190 });
  });

  it('is made for a quarter as well, the three months together, which is what a One Stop Shop declaration is for', async () => {
    stubBank();
    const made = await buildJournal('2026-Q4');
    if (!made.ok) throw new Error(made.error);
    // October's document is now in, and the December copy (dated the 2nd) too.
    expect(made.journal.rows.map(r => r.number)).toEqual(['SPN-00000', 'SPN-00001', 'BY-0007', 'SPN-00002', 'SPN-00003', 'BY-0008']);
    expect(made.journal.period).toBe('2026-Q4');
    expect(await buildJournal('2026-Q5')).toMatchObject({ ok: false });
    expect((await app.inject({ method: 'GET', url: '/api/admin/invoices/export?period=2026-Q4&format=csv', headers: { cookie: await as(ADMIN) } })).headers['content-disposition']).toBe('attachment; filename="centralizator-facturi-2026-Q4.csv"');
  });

  it('is an empty month for a month with nothing, and refuses what is not a month', async () => {
    stubBank();
    expect(await buildJournal('2026-09')).toMatchObject({ ok: true, journal: { rows: [] } });
    expect(await buildJournal('2026-13')).toMatchObject({ ok: false });
    expect(await buildJournal('november')).toMatchObject({ ok: false });
  });

  describe('as a download', () => {
    const get = async (query: string, email: string | null = ADMIN) => app.inject({ method: 'GET', url: `/api/admin/invoices/export?${query}`, ...(email ? { headers: { cookie: await as(email) } } : {}) });

    it('is for administrators: no one signed out, and not the marketing role that may only read the page', async () => {
      expect((await get('period=2026-11', null)).statusCode).toBe(401);
      expect((await get('period=2026-11', 'reader-journal@spine.test')).statusCode).toBe(403);
    });

    it('is a CSV a Romanian spreadsheet opens: a mark, semicolons, comma decimals, a line for each document, and a name that is a formula made harmless', async () => {
      stubBank();
      const res = await get('period=2026-11&format=csv');
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
      expect(res.headers['content-disposition']).toBe('attachment; filename="centralizator-facturi-2026-11.csv"');
      expect(res.headers['cache-control']).toContain('no-store');
      const text = res.body;
      expect(text.startsWith('﻿Tip;Număr;Data;Client;')).toBe(true);
      const lines = text.trim().split('\r\n');
      expect(lines).toHaveLength(5);
      expect(lines[1]).toBe('Factură;SPN-00001;05.11.2026;Ion Popescu;RO;0000000000000;EUR;11,90;0;0,00;11,90;5,0000;59,50;;cs_a;acceptată');
      expect(lines[3]).toContain(`"'=HYPERLINK(""http://evil.test"")"`);
      expect(lines[4]).toBe('Notă de credit;SPN-00003;18.11.2026;Ion Popescu;RO;0000000000000;EUR;-11,90;0;0,00;-11,90;5,1500;-61,29;SPN-00001;SPN-00001;acceptată');
    });

    it('is a PDF to print and sign', async () => {
      stubBank();
      const res = await app.inject({ method: 'GET', url: '/api/admin/invoices/export?period=2026-11&format=pdf', headers: { cookie: await as(ADMIN) } });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
      expect(res.headers['content-disposition']).toBe('attachment; filename="centralizator-facturi-2026-11.pdf"');
    });

    it('refuses a month that is not one, a month that has not begun, and a format it does not make', async () => {
      expect((await get('period=2026-13')).statusCode).toBe(400);
      expect((await get('period=')).statusCode).toBe(400);
      expect((await get('period=2099-01')).statusCode).toBe(400);
      expect((await get('period=2026-11&format=xls')).statusCode).toBe(400);
    });
  });
});

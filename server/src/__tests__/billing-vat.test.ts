import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { getAccountsStore } from 'spine-core/store/index.js';
import { AnafLink } from 'spine-anaf/anaf.js';
import { efacturaIssuer } from 'spine-anaf/issuer.js';
import { vatTreatment, type UblDocument } from 'spine-anaf/index.js';
import type { InvoiceDraft } from 'spine-anaf/invoice.js';
import { buildTestApp, loginAs } from './helpers/app.js';
import { createTestUser, TEST_PASSWORD } from './helpers/seed.js';
import { changeSeller } from '../billing/invoicing/seller.js';
import { changeVat, readVat, vatOf } from '../billing/invoicing/vat.js';

/** Whether the company is registered for VAT, kept on the invoices page, and what each invoice Spine's own link makes carries because of it. */
const ADMIN = 'admin-vat@spine.test';
const KEY = Buffer.alloc(32, 7);
const SELLER = { name: 'Omni Edge SRL', cif: '12345678', registerNo: 'J40/1234/2020', street: 'Str. Exemplului 1', city: 'Sector 1', county: 'B', sector: '1', postalCode: '010101' };
const ENV = {
  SPINE_BILLING: 'on', SPINE_BILLING_PROVIDER: 'stripe', STRIPE_SECRET_KEY: 'sk_test_vat', STRIPE_WEBHOOK_SECRET: 'whsec_vat',
  SPINE_STRIPE_PRICE_YEAR: 'pri_year', SPINE_STRIPE_PRICE_MONTH: 'pri_month', SPINE_STRIPE_PRICE_FOUNDING: 'pri_founding',
  SPINE_INVOICING_PROVIDER: 'efactura', SPINE_DOMAIN: 'spine.test', ANAF_CLIENT_ID: 'client-id', ANAF_CLIENT_SECRET: 'client-secret',
  SPINE_EFACTURA_REDIRECT_URI: 'https://spine.test/api/admin/efactura/callback', SPINE_EFACTURA_KEY: KEY.toString('base64'),
};
const T0 = new Date('2026-12-05T10:00:00.000Z');

describe('the company’s VAT', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  const dir = mkdtempSync(path.join(tmpdir(), 'spine-vat-'));
  const saved: Record<string, string | undefined> = {};
  const store = () => getAccountsStore();
  beforeAll(async () => {
    process.env.DATA_DIR = dir;
    for (const k of Object.keys(ENV)) saved[k] = process.env[k];
    Object.assign(process.env, ENV);
    app = await buildTestApp({ accounts: { registration: 'approval' }, admin: { admins: () => new Set([ADMIN]), readers: () => new Set([ADMIN, 'reader-vat@spine.test']) } });
    await createTestUser(ADMIN);
    await createTestUser('reader-vat@spine.test');
  });
  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  afterEach(() => vi.unstubAllGlobals());
  const as = (email: string) => loginAs(app, email, TEST_PASSWORD);

  describe('the settings', () => {
    it('are a company not registered where nothing is saved, and checked when they are: registered needs its day, and the seller needs a VAT id', async () => {
      expect(await vatOf(store())).toEqual({ registered: false, from: null, oss: false });
      expect(readVat({ registered: true })).toMatchObject({ ok: false });
      expect(readVat({ registered: true, from: '2026-13-01' })).toMatchObject({ ok: false });
      expect(readVat({ registered: true, from: '2026-12-01', oss: true })).toEqual({ ok: true, vat: { registered: true, from: '2026-12-01', oss: true } });
      // Not registered drops the rest.
      expect(readVat({ registered: false, from: '2026-12-01', oss: true })).toEqual({ ok: true, vat: { registered: false, from: null, oss: false } });
      expect(await changeSeller(store(), SELLER, T0.toISOString())).toBeNull();
      expect(await changeVat(store(), { registered: true, from: '2026-12-01', oss: true }, T0.toISOString())).toContain('VAT id');
      expect(await changeSeller(store(), { ...SELLER, vatId: 'RO12345678' }, T0.toISOString())).toBeNull();
      expect(await changeVat(store(), { registered: true, from: '2026-12-01', oss: true }, T0.toISOString())).toBeNull();
      expect(await vatOf(store())).toEqual({ registered: true, from: '2026-12-01', oss: true });
      expect(await changeVat(store(), { registered: false }, T0.toISOString())).toBeNull();
      expect(await vatOf(store())).toEqual({ registered: false, from: null, oss: false });
    });

    it('are read and changed on the page: by an administrator who has just typed the password, read by the marketing role, not by anyone signed out', async () => {
      expect((await app.inject({ method: 'GET', url: '/api/admin/vat' })).statusCode).toBe(401);
      const read = await app.inject({ method: 'GET', url: '/api/admin/vat', headers: { cookie: await as('reader-vat@spine.test') } });
      expect(read.statusCode).toBe(200);
      expect(read.json()).toMatchObject({ vat: { registered: false }, issuer: 'efactura', seller_has_vat_id: true, romania_rate: 21, can_edit: false });
      const put = (cookie: string, body: unknown) => app.inject({ method: 'PUT', url: '/api/admin/vat', headers: { cookie }, payload: body as object });
      expect((await put(await as('reader-vat@spine.test'), { registered: true, from: '2026-12-01' })).statusCode).toBe(403);
      const admin = await as(ADMIN);
      expect((await put(admin, { registered: true })).statusCode).toBe(400);
      const done = await put(admin, { registered: true, from: '2026-12-01', oss: true });
      expect(done.statusCode).toBe(200);
      expect(done.json()).toEqual({ vat: { registered: true, from: '2026-12-01', oss: true } });
      expect((await app.inject({ method: 'GET', url: '/api/admin/vat', headers: { cookie: admin } })).json().vat).toMatchObject({ registered: true, oss: true });
      await changeVat(store(), { registered: false }, T0.toISOString());
    });
  });

  describe('an invoice made by Spine’s own link', () => {
    const draft = (id: string, country: string, over: Partial<InvoiceDraft> = {}): InvoiceDraft => ({
      id, paidAt: '2026-12-05T09:00:00.000Z', currency: 'EUR', sendEmail: false,
      buyer: { name: 'Anna Test', email: 'anna@spine.test', country, city: 'Berlin', address: 'Hauptstr. 1' },
      lines: [{ name: 'Spine Premium, monthly', amountMinor: 1190, quantity: 1, vatPercent: 0 }], ...over,
    });
    const issuerOver = (seller: typeof SELLER & { vatId?: string }) => {
      const fetcher = (async () => { throw new Error('ANAF is not asked'); }) as unknown as typeof fetch;
      const link = new AnafLink({ mode: 'test', clientId: 'c', clientSecret: 's', redirectUri: 'https://spine.test/cb', key: KEY, fetcher, now: () => T0 }, store().billing);
      return efacturaIssuer({
        seller: async () => seller, series: 'VAT', zeroVat: { category: 'O' }, now: () => T0, fetcher, exchangeRate: async () => 5, pdfLink: id => `https://spine.test/pdf/${id}`,
        vat: async (country, date) => vatTreatment(country, date, await vatOf(store())),
      }, store().billing, link);
    };
    const made = async (id: string) => JSON.parse((await store().billing.efacturaDocument(id))!.input!) as UblDocument;
    const registered = async (oss: boolean) => { expect(await changeVat(store(), { registered: true, from: '2026-12-01', oss }, T0.toISOString())).toBeNull(); };

    it('carries no VAT and the art. 310 mention while the company is not registered, for a person in Romania or in Germany, and "not taxable" for one in the United States', async () => {
      await changeVat(store(), { registered: false }, T0.toISOString());
      const issuer = issuerOver({ ...SELLER });
      await issuer.issue(draft('cs_n_ro', 'RO', { buyer: { name: 'Ion Test', email: 'i@spine.test', country: 'RO', city: 'Cluj-Napoca', region: 'CJ', address: 'Str. Mare 5' } }));
      await issuer.issue(draft('cs_n_de', 'DE'));
      await issuer.issue(draft('cs_n_us', 'US'));
      for (const id of ['cs_n_ro', 'cs_n_de']) expect(await made(id)).toMatchObject({ lines: [{ vatPercent: 0 }], zeroVat: { category: 'O', note: 'Scutit de TVA conform art. 310 din Codul fiscal' } });
      expect(await made('cs_n_us')).toMatchObject({ lines: [{ vatPercent: 0 }], zeroVat: { category: 'O', note: expect.stringContaining('alin. (5) lit. h)') } });
    });

    it('carries the rate of the buyer’s country once the company is registered and has joined the One Stop Shop, Romania’s for a person in Romania, and none outside the EU', async () => {
      await changeSeller(store(), { ...SELLER, vatId: 'RO12345678' }, T0.toISOString());
      await registered(true);
      const issuer = issuerOver({ ...SELLER, vatId: 'RO12345678' });
      await issuer.issue(draft('cs_v_ro', 'RO', { buyer: { name: 'Ion Test', email: 'i@spine.test', country: 'RO', city: 'Cluj-Napoca', region: 'CJ', address: 'Str. Mare 5' } }));
      await issuer.issue(draft('cs_v_de', 'DE'));
      await issuer.issue(draft('cs_v_fi', 'FI'));
      await issuer.issue(draft('cs_v_us', 'US'));
      expect((await made('cs_v_ro')).lines[0]).toMatchObject({ vatPercent: 21 });
      expect((await made('cs_v_de')).lines[0]).toMatchObject({ vatPercent: 19 });
      expect((await made('cs_v_fi')).lines[0]).toMatchObject({ vatPercent: 25.5 });
      expect((await made('cs_v_us')).lines[0]).toMatchObject({ vatPercent: 0 });
      // The VAT is inside the price: 11,90 EUR at 19% is 10,00 of it and 1,90 VAT, and the invoice says so, with the rate of the day since it is in euro.
      const de = await made('cs_v_de');
      expect(de).toMatchObject({ rate: 5 });
      expect(de.lines[0]!.netMinor).toBe(1000);
      const xml = (await store().billing.efacturaDocument('cs_v_de'))!.xml!;
      expect(xml).toContain('<cbc:Percent>19</cbc:Percent>');
      expect(xml).toContain('RO12345678');
      // An invoice for a person outside the EU has no seller VAT id (BR-O-02).
      expect((await store().billing.efacturaDocument('cs_v_us'))!.xml).not.toContain('RO12345678');
    });

    it('carries Romania’s rate for a person in another EU country while the company has not joined the One Stop Shop', async () => {
      await registered(false);
      await issuerOver({ ...SELLER, vatId: 'RO12345678' }).issue(draft('cs_v_de_home', 'DE'));
      expect((await made('cs_v_de_home')).lines[0]).toMatchObject({ vatPercent: 21 });
    });

    it('is the exempt kind where it is dated before the day the company is registered', async () => {
      await registered(true);
      await issuerOver({ ...SELLER, vatId: 'RO12345678' }).issue(draft('cs_v_early', 'RO', { paidAt: '2026-11-20T09:00:00.000Z', buyer: { name: 'Ion Test', email: 'i@spine.test', country: 'RO', city: 'Cluj-Napoca', region: 'CJ', address: 'Str. Mare 5' } }));
      expect(await made('cs_v_early')).toMatchObject({ issueDate: '2026-11-20', lines: [{ vatPercent: 0 }], zeroVat: { note: expect.stringContaining('art. 310') } });
    });

    it('waits, numbered, where the company charges VAT and the seller has no VAT id, and is made once it is saved', async () => {
      await registered(true);
      await expect(issuerOver({ ...SELLER }).issue(draft('cs_v_wait', 'RO', { buyer: { name: 'Ion Test', email: 'i@spine.test', country: 'RO', city: 'Cluj-Napoca', region: 'CJ', address: 'Str. Mare 5' } }))).rejects.toMatchObject({ name: 'AnafError', retry: true, message: expect.stringContaining('VAT id') });
      expect((await store().billing.efacturaDocument('cs_v_wait'))!.xml).toBeNull();
      await issuerOver({ ...SELLER, vatId: 'RO12345678' }).issue(draft('cs_v_wait', 'RO', { buyer: { name: 'Ion Test', email: 'i@spine.test', country: 'RO', city: 'Cluj-Napoca', region: 'CJ', address: 'Str. Mare 5' } }));
      expect((await made('cs_v_wait')).lines[0]).toMatchObject({ vatPercent: 21 });
    });

    it('is reversed by a credit note with the VAT the invoice carried, whatever the settings are now', async () => {
      await registered(true);
      const issuer = issuerOver({ ...SELLER, vatId: 'RO12345678' });
      const invoice = await issuer.issue(draft('cs_v_credit', 'DE'));
      await changeVat(store(), { registered: false }, T0.toISOString());
      await issuer.reverse({ id: 'cs_v_credit', series: invoice.series, number: invoice.number }, 'Rambursare');
      expect(await made('credit:cs_v_credit')).toMatchObject({ kind: 'credit', lines: [{ vatPercent: 19 }] });
    });
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAccountsStore } from 'spine-core/store/index.js';
import { DEFAULT_PAGE, MAX_PAGE, pagingOf } from '../routes/paging.js';
import { buildTestApp, loginAs } from './helpers/app.js';
import { createTestUser, TEST_PASSWORD } from './helpers/seed.js';

/**
 * Every list a route gives has a size (T-31): a page of the newest first, with the total, so no screen grows with the data. Each list is walked here, page by page: every row seen once,
 * in order, the last page short, and a limit above the most clamped.
 */
const ADMIN = 'admin-paging@spine.test';
const COUNT = 60;

describe('the pages of a list', () => {
  it('reads the page and the limit from the query, clamping a wrong or a large one', () => {
    expect(pagingOf(undefined)).toEqual({ page: 1, limit: DEFAULT_PAGE, offset: 0 });
    expect(pagingOf({ page: '3', limit: '10' })).toEqual({ page: 3, limit: 10, offset: 20 });
    expect(pagingOf({ limit: '5000' }).limit).toBe(MAX_PAGE);
    expect(pagingOf({ limit: '0' }).limit).toBe(1);
    expect(pagingOf({ page: '-2', limit: 'abc' })).toEqual({ page: 1, limit: DEFAULT_PAGE, offset: 0 });
    expect(pagingOf({ page: '0' }).page).toBe(1);
    expect(pagingOf({}, 20).limit).toBe(20);
  });

  describe('as the routes answer them', () => {
    let app: Awaited<ReturnType<typeof buildTestApp>>;
    let cookie: string;
    const store = () => getAccountsStore();
    beforeAll(async () => {
      app = await buildTestApp({ accounts: { registration: 'approval' }, admin: { admins: () => new Set([ADMIN]), readers: () => new Set([ADMIN]) } });
      await createTestUser(ADMIN);
      cookie = await loginAs(app, ADMIN, TEST_PASSWORD);
    });
    afterAll(async () => { await app.close(); });

    const get = async (url: string) => {
      const res = await app.inject({ method: 'GET', url, headers: { cookie } });
      expect(res.statusCode).toBe(200);
      return res.json();
    };
    /** Walks a list five at a time and returns every key in the order seen, with the totals each page said. */
    async function walk(url: string, rows: string, key: (row: Record<string, unknown>) => string) {
      const seen: string[] = [];
      const totals = new Set<number>();
      let sizes: number[] = [];
      for (let page = 1; page <= 20; page++) {
        const body = await get(`${url}${url.includes('?') ? '&' : '?'}page=${page}&limit=5`);
        const list = body[rows] as Array<Record<string, unknown>>;
        totals.add(body.total);
        expect(body.page).toBe(page);
        expect(body.limit).toBe(5);
        sizes.push(list.length);
        seen.push(...list.map(key));
        if (list.length < 5) break;
      }
      return { seen, totals: [...totals], sizes };
    }

    it('gives the accounts waiting for approval a page at a time, oldest first, and never every account', async () => {
      for (let i = 0; i < COUNT; i++) await createTestUser(`waiting-${String(i).padStart(2, '0')}@spine.test`, { approved: false, createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString() });
      const { seen, totals, sizes } = await walk('/api/admin/accounts', 'pending', r => String(r.email));
      expect(totals).toEqual([COUNT]);
      expect(seen).toHaveLength(COUNT);
      expect(new Set(seen).size).toBe(COUNT);
      expect(seen).toEqual([...seen].sort());
      expect(sizes.at(-1)).toBeLessThan(5);
      expect((await get('/api/admin/accounts?limit=5000')).pending.length).toBeLessThanOrEqual(MAX_PAGE);
      // Waiting accounts only: the administrator is approved and is not on any page.
      expect(seen).not.toContain(ADMIN);
    });

    it('gives the subscriptions a page at a time, with their emails, newest change first', async () => {
      for (let i = 0; i < COUNT; i++) {
        const user = await createTestUser(`subscriber-${String(i).padStart(2, '0')}@spine.test`);
        await store().billing.put({ user_id: user.id, provider: 'operator', customer_id: null, subscription_id: null, interval: null, plan: 'premium', status: 'active', founding: false, current_period_end: null, cancel_scheduled: true, updated_at: new Date(Date.UTC(2026, 1, 1, 0, i)).toISOString() });
      }
      const { seen, totals } = await walk('/api/admin/subscriptions', 'subscriptions', r => String(r.email));
      expect(totals).toEqual([COUNT]);
      expect(seen).toHaveLength(COUNT);
      expect(new Set(seen).size).toBe(COUNT);
      expect(seen[0]).toBe('subscriber-59@spine.test');
      expect(seen.at(-1)).toBe('subscriber-00@spine.test');
    });

    it('gives the open withdrawal requests a page at a time, with what the operator weighs for each', async () => {
      for (let i = 0; i < 12; i++) {
        const user = await createTestUser(`asker-${String(i).padStart(2, '0')}@spine.test`);
        await store().billing.requestWithdrawal(`w_page_${String(i).padStart(2, '0')}`, user.id, new Date(Date.UTC(2026, 2, 1, 0, i)).toISOString());
      }
      const { seen, totals } = await walk('/api/admin/withdrawals', 'requests', r => String(r.id));
      expect(totals).toEqual([12]);
      expect(seen).toEqual(Array.from({ length: 12 }, (_, i) => `w_page_${String(11 - i).padStart(2, '0')}`));
    });

    it('reaches every e-Factura document and every invoice that stopped, the oldest too, which a fixed newest-thirty never did', async () => {
      for (let i = 0; i < 45; i++) await store().billing.efacturaReserve(`d_page_${String(i).padStart(2, '0')}`, 'invoice', 'PAG', '2026-05-01', new Date(Date.UTC(2026, 4, 1, 0, i)).toISOString(), null);
      expect(await store().billing.efacturaDocumentCount()).toBe(45);
      const documents = [...(await store().billing.efacturaDocuments(20, 0)), ...(await store().billing.efacturaDocuments(20, 20)), ...(await store().billing.efacturaDocuments(20, 40))].map(d => d.draft_id);
      expect(documents).toHaveLength(45);
      expect(documents[0]).toBe('d_page_44');
      expect(documents.at(-1)).toBe('d_page_00');
      for (let i = 0; i < 12; i++) {
        const ref = `cs_stopped_${String(i).padStart(2, '0')}`;
        const at = new Date(Date.UTC(2026, 5, 1, 0, i)).toISOString();
        await store().billing.queueInvoice(ref, null, at);
        await store().billing.updateInvoice(ref, { state: i % 2 ? 'failed' : 'check' }, at);
      }
      const stopped = [...(await store().billing.invoicesStopped(5, 0)), ...(await store().billing.invoicesStopped(5, 5)), ...(await store().billing.invoicesStopped(5, 10))].map(r => r.ref);
      expect(stopped).toEqual(Array.from({ length: 12 }, (_, i) => `cs_stopped_${String(11 - i).padStart(2, '0')}`));
      const body = await get('/api/admin/invoices?page=3&limit=5');
      expect(body).toMatchObject({ total: 12, page: 3 });
      expect(body.stopped).toHaveLength(2);
    });

    it('gives the account’s own invoices a page at a time, newest first, only its own, only the ones that are made', async () => {
      const own = await createTestUser('invoiced@spine.test');
      const other = await createTestUser('invoiced-other@spine.test');
      for (let i = 0; i < 12; i++) {
        const ref = `cs_page_${String(i).padStart(2, '0')}`;
        const at = new Date(Date.UTC(2026, 3, 1, 0, i)).toISOString();
        await store().billing.queueInvoice(ref, own.id, at);
        await store().billing.updateInvoice(ref, { state: 'done', series: 'SPN', number: String(i + 1).padStart(5, '0') }, at);
      }
      // Not made yet, and someone else's: neither is listed or counted.
      await store().billing.queueInvoice('cs_page_pending', own.id, new Date().toISOString());
      await store().billing.queueInvoice('cs_page_other', other.id, new Date().toISOString());
      await store().billing.updateInvoice('cs_page_other', { state: 'done', series: 'SPN', number: '00099' }, new Date().toISOString());
      const saved = { ...process.env };
      Object.assign(process.env, { SPINE_BILLING: 'on', SPINE_BILLING_PROVIDER: 'stripe', STRIPE_SECRET_KEY: ['sk', 'test', 'paging'].join('_'), STRIPE_WEBHOOK_SECRET: 'whsec_paging', SPINE_STRIPE_PRICE_YEAR: 'p1', SPINE_STRIPE_PRICE_MONTH: 'p2', SPINE_STRIPE_PRICE_FOUNDING: 'p3', SPINE_STRIPE_PRICE_TOPUP_PAGES: 'p4', SPINE_INVOICING_PROVIDER: 'billyou', SPINE_INVOICING_VAT_PERCENT: '21', BILLYOU_API_KEY: 'k', BILLYOU_SERIES_ID: 's' });
      try {
        const mine = await loginAs(app, 'invoiced@spine.test', TEST_PASSWORD);
        const page = async (n: number) => (await app.inject({ method: 'GET', url: `/api/billing/invoices?page=${n}&limit=5`, headers: { cookie: mine } })).json();
        const first = await page(1);
        expect(first).toMatchObject({ total: 12, page: 1, limit: 5 });
        const all = [...first.invoices, ...(await page(2)).invoices, ...(await page(3)).invoices].map((i: { number: string }) => i.number);
        expect(all).toEqual(Array.from({ length: 12 }, (_, i) => `SPN-${String(12 - i).padStart(5, '0')}`));
        expect((await page(3)).invoices).toHaveLength(2);
        expect((await page(4)).invoices).toEqual([]);
      } finally { process.env = saved; }
    });
  });
});

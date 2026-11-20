import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { getAccountsStore } from 'spine-core/store/index.js';
import { resetMailer, type Mailer, type MailMessage } from '../mail/index.js';
import { buildTestApp, loginAs } from './helpers/app.js';
import { createTestUser } from './helpers/seed.js';
import { TEST_PASSWORD } from './helpers/seed.js';

/** Withdrawing from a purchase (the fourteen days), the buyer's invoice history, and the operator's decision: pay back and end the plan, or decline. */
const ADMIN = 'admin-withdraw@spine.test';
const ENV = {
  SPINE_BILLING: 'on', SPINE_BILLING_PROVIDER: 'stripe', STRIPE_SECRET_KEY: 'sk_test_withdraw', STRIPE_WEBHOOK_SECRET: 'whsec_withdraw',
  SPINE_STRIPE_PRICE_YEAR: 'pri_year', SPINE_STRIPE_PRICE_MONTH: 'pri_month', SPINE_STRIPE_PRICE_FOUNDING: 'pri_founding',
  SPINE_INVOICING_PROVIDER: 'billyou', SPINE_INVOICING_VAT_PERCENT: '0', SPINE_INVOICING_ZERO_VAT: 'O', BILLYOU_API_KEY: 'bk_withdraw_not_real', BILLYOU_SERIES_ID: 'series_1',
};
const NOW = () => new Date().toISOString();
const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

describe('withdrawing from a purchase', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  let sent: MailMessage[];
  const fakeMailer: Mailer = { get enabled() { return true; }, async send(m) { sent.push(m); } };
  const dir = mkdtempSync(path.join(tmpdir(), 'spine-withdrawal-'));
  const saved: Record<string, string | undefined> = {};
  const store = () => getAccountsStore();
  beforeAll(async () => {
    process.env.DATA_DIR = dir;
    for (const k of Object.keys(ENV)) saved[k] = process.env[k];
    Object.assign(process.env, ENV);
    app = await buildTestApp({ accounts: { registration: 'approval' }, admin: { admins: () => new Set([ADMIN]), readers: () => new Set([ADMIN]) } });
    await createTestUser(ADMIN);
  });
  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(() => { sent = []; resetMailer(fakeMailer); });
  afterEach(() => { vi.unstubAllGlobals(); resetMailer(null); });

  /** A buyer with a Stripe subscription whose first payment was `days` ago, and its invoice. */
  async function buyer(name: string, days: number) {
    const user = await createTestUser(`${name}@spine.test`);
    await store().billing.put({ user_id: user.id, provider: 'stripe', customer_id: `cus_${name}`, subscription_id: `sub_${name}`, interval: 'month', plan: 'premium', status: 'active', founding: false, current_period_end: new Date(Date.now() + 20 * 86_400_000).toISOString(), cancel_scheduled: false, updated_at: NOW() });
    await store().billing.queueInvoice(`cs_${name}`, user.id, ago(days));
    await store().billing.updateInvoice(`cs_${name}`, { state: 'done', issuer_ref: `inv_${name}`, series: 'SPN', number: '00001' }, ago(days));
    return { ...user, cookie: await loginAs(app, user.email, TEST_PASSWORD) };
  }
  const stripe = (answers: Record<string, unknown>) => {
    const calls: Array<{ method: string; url: string; form: URLSearchParams; headers: Record<string, string> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: { method?: string; body?: string; headers?: Record<string, string> }) => {
      calls.push({ method: init?.method ?? 'GET', url: String(url), form: new URLSearchParams(init?.body ?? ''), headers: init?.headers ?? {} });
      const key = Object.keys(answers).find(k => String(url).includes(k));
      if (!key) return new Response('{}', { status: 404 });
      const a = answers[key] as { status?: number; json: unknown };
      return new Response(JSON.stringify(a.json), { status: a.status ?? 200 });
    }));
    return calls;
  };

  it('is offered within fourteen days of the first payment, with the day it ends, and not after, nor twice', async () => {
    const early = await buyer('wd-early', 3);
    const plan = (await app.inject({ method: 'GET', url: '/api/billing', headers: { cookie: early.cookie } })).json();
    expect(plan.withdrawal).toMatchObject({ allowed: true, requested: false });
    expect(Math.abs(Date.parse(plan.withdrawal.until) - Date.parse(ago(3)) - 14 * 86_400_000)).toBeLessThan(60_000);
    const late = await buyer('wd-late', 15);
    expect((await app.inject({ method: 'GET', url: '/api/billing', headers: { cookie: late.cookie } })).json().withdrawal).toMatchObject({ allowed: false });
    expect((await app.inject({ method: 'POST', url: '/api/billing/withdraw', headers: { cookie: late.cookie }, payload: {} })).statusCode).toBe(409);
  });

  it('sends the confirmation of the request to the buyer, in the buyer’s language, and keeps one request open', async () => {
    const b = await buyer('wd-ask', 2);
    await store().users.setLanguage(b.id, 'ro');
    const res = await app.inject({ method: 'POST', url: '/api/billing/withdraw', headers: { cookie: b.cookie }, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(b.email);
    expect(sent[0]!.subject).toBe('Cererea ta de retragere');
    expect(await store().billing.openWithdrawalOf(b.id)).toMatchObject({ state: 'requested' });
    const again = await app.inject({ method: 'POST', url: '/api/billing/withdraw', headers: { cookie: b.cookie }, payload: {} });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: 'withdrawal_open' });
    expect((await app.inject({ method: 'GET', url: '/api/billing', headers: { cookie: b.cookie } })).json().withdrawal).toMatchObject({ allowed: false, requested: true });
  });

  it('lists the open requests for the operator, who alone decides them', async () => {
    const b = await buyer('wd-list', 1);
    await app.inject({ method: 'POST', url: '/api/billing/withdraw', headers: { cookie: b.cookie }, payload: {} });
    expect((await app.inject({ method: 'GET', url: '/api/admin/withdrawals', headers: { cookie: b.cookie } })).statusCode).toBe(403);
    const admin = await loginAs(app, ADMIN, TEST_PASSWORD);
    // The last payment is read from Stripe to suggest what to pay back: nothing used since it, so the whole of it.
    stripe({ '/v1/invoices': { json: { data: [{ amount_paid: 1900, currency: 'eur' }] } } });
    const list = (await app.inject({ method: 'GET', url: '/api/admin/withdrawals', headers: { cookie: admin } })).json().requests as Array<{ email: string; plan: string; suggested: unknown }>;
    expect(list.find(r => r.email === b.email)).toMatchObject({ plan: 'premium', suggested: { refundMinor: 1900, keptMinor: 0, currency: 'EUR', basis: 'unused' } });
    vi.unstubAllGlobals();
    const id = (await store().billing.openWithdrawalOf(b.id))!.id;
    expect((await app.inject({ method: 'POST', url: '/api/admin/withdrawals', headers: { cookie: b.cookie }, payload: { id, action: 'decline' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/admin/withdrawals', headers: { cookie: admin }, payload: { id, action: 'refund', amount: -3 } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/admin/withdrawals', headers: { cookie: admin }, payload: { id: 'nope', action: 'decline' } })).statusCode).toBe(409);
  });

  it('ends the plan and pays the last payment back, in full or in part, when the operator says so, tells the buyer, and has the refund reverse the invoice', async () => {
    const b = await buyer('wd-refund', 4);
    await app.inject({ method: 'POST', url: '/api/billing/withdraw', headers: { cookie: b.cookie }, payload: {} });
    sent.length = 0;
    const calls = stripe({
      '/v1/invoices?': { json: { data: [{ id: 'in_1' }] } },
      '/v1/invoice_payments': { json: { data: [{ payment: { payment_intent: 'pi_1' } }] } },
      '/v1/subscriptions/sub_wd-refund': { json: { id: 'sub_wd-refund', status: 'canceled' } },
      '/v1/refunds': { json: { id: 're_1', amount: 499, currency: 'eur' } },
    });
    const admin = await loginAs(app, ADMIN, TEST_PASSWORD);
    const id = (await store().billing.openWithdrawalOf(b.id))!.id;
    const res = await app.inject({ method: 'POST', url: '/api/admin/withdrawals', headers: { cookie: admin }, payload: { id, action: 'refund' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ refunded: 4.99, currency: 'EUR' });
    // The plan first, then the money; each made once for the request.
    expect(calls.map(c => `${c.method} ${c.url.replace('https://api.stripe.com', '').split('?')[0]}`)).toEqual(['GET /v1/invoices', 'GET /v1/invoice_payments', 'DELETE /v1/subscriptions/sub_wd-refund', 'POST /v1/refunds']);
    expect(calls[2]!.headers['idempotency-key']).toBe(`withdrawal:${id}:end`);
    expect(calls[3]!.headers['idempotency-key']).toBe(`withdrawal:${id}:refund`);
    expect(calls[3]!.form.get('payment_intent')).toBe('pi_1');
    expect(calls[3]!.form.has('amount')).toBe(false);
    expect(await store().billing.withdrawal(id)).toMatchObject({ state: 'refunded', refunded_minor: 499 });
    const accepted = sent.find(m => m.subject === 'Your withdrawal was accepted');
    expect(accepted?.to).toBe(b.email);
    expect(accepted?.text).toContain('4.99 EUR');
    // Decided: a second decision is refused.
    expect((await app.inject({ method: 'POST', url: '/api/admin/withdrawals', headers: { cookie: admin }, payload: { id, action: 'refund' } })).statusCode).toBe(409);

    const part = await buyer('wd-part', 5);
    await app.inject({ method: 'POST', url: '/api/billing/withdraw', headers: { cookie: part.cookie }, payload: {} });
    const partCalls = stripe({
      '/v1/invoices?': { json: { data: [{ id: 'in_2' }] } },
      '/v1/invoice_payments': { json: { data: [{ payment: { payment_intent: 'pi_2' } }] } },
      '/v1/subscriptions/sub_wd-part': { status: 404, json: { error: { code: 'resource_missing' } } },
      '/v1/refunds': { json: { id: 're_2', amount: 250, currency: 'eur' } },
    });
    const partId = (await store().billing.openWithdrawalOf(part.id))!.id;
    expect((await app.inject({ method: 'POST', url: '/api/admin/withdrawals', headers: { cookie: admin }, payload: { id: partId, action: 'refund', amount: 2.5 } })).statusCode).toBe(200);
    expect(partCalls[3]!.form.get('amount')).toBe('250');
    expect(await store().billing.withdrawal(partId)).toMatchObject({ state: 'refunded', refunded_minor: 250 });
  });

  it('leaves the request open and says so when the provider cannot do it, and declines with a reason the buyer is told', async () => {
    const b = await buyer('wd-fail', 2);
    await app.inject({ method: 'POST', url: '/api/billing/withdraw', headers: { cookie: b.cookie }, payload: {} });
    stripe({ '/v1/invoices?': { status: 500, json: {} } });
    const admin = await loginAs(app, ADMIN, TEST_PASSWORD);
    const id = (await store().billing.openWithdrawalOf(b.id))!.id;
    const failed = await app.inject({ method: 'POST', url: '/api/admin/withdrawals', headers: { cookie: admin }, payload: { id, action: 'refund' } });
    expect(failed.statusCode).toBe(502);
    expect((await store().billing.withdrawal(id))!.state).toBe('requested');
    sent.length = 0;
    const declined = await app.inject({ method: 'POST', url: '/api/admin/withdrawals', headers: { cookie: admin }, payload: { id, action: 'decline', note: 'The service was fully used.' } });
    expect(declined.statusCode).toBe(200);
    expect(await store().billing.withdrawal(id)).toMatchObject({ state: 'declined', note: 'The service was fully used.' });
    expect(sent.find(m => m.subject === 'About your withdrawal request')?.text).toContain('The service was fully used.');
  });

  it('lists the account’s invoices, and gives the PDF of its own alone', async () => {
    const b = await buyer('wd-inv', 2);
    const list = (await app.inject({ method: 'GET', url: '/api/billing/invoices', headers: { cookie: b.cookie } })).json().invoices as Array<{ ref: string; number: string; credit_note: boolean }>;
    expect(list).toEqual([{ ref: 'cs_wd-inv', number: 'SPN-00001', at: expect.any(String), credit_note: false }]);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (String(url).endsWith('/invoices/inv_wd-inv/pdf')
      ? new Response(JSON.stringify({ success: true, data: { downloadUrl: 'https://files.example/a.pdf?sig=1', expiresIn: 600 } }))
      : new Response('{}', { status: 404 }))));
    const pdf = await app.inject({ method: 'POST', url: '/api/billing/invoices/pdf', headers: { cookie: b.cookie }, payload: { ref: 'cs_wd-inv' } });
    expect(pdf.json()).toEqual({ url: 'https://files.example/a.pdf?sig=1' });
    // Another account's reference is the same as none.
    const other = await buyer('wd-inv2', 2);
    expect((await app.inject({ method: 'POST', url: '/api/billing/invoices/pdf', headers: { cookie: other.cookie }, payload: { ref: 'cs_wd-inv' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/billing/invoices/pdf', headers: { cookie: b.cookie }, payload: {} })).statusCode).toBe(400);
  });
});

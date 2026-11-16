import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAccountsStore } from 'spine-core/store/index.js';
import { meterKey } from 'spine-core/billing/plans.js';
import { standingOf } from '../plans/seat.js';
import { buildTestApp, loginAs } from './helpers/app.js';
import { createTestUser, TEST_PASSWORD } from './helpers/seed.js';

/** The subscriptions on the admin page (an administrator's list), and what a withdrawal request shows of the use made since the purchase. */
const ADMIN = 'admin-subscriptions@spine.test';
const MARKETING = 'marketing-subscriptions@spine.test';
const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

describe('the subscriptions and the use shown with a withdrawal', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  const store = () => getAccountsStore();
  beforeAll(async () => {
    app = await buildTestApp({ accounts: { registration: 'approval' }, admin: { admins: () => new Set([ADMIN]), readers: () => new Set([ADMIN, MARKETING]) } });
    await createTestUser(ADMIN);
    await createTestUser(MARKETING);
  });
  afterAll(async () => { await app.close(); });
  const as = (email: string) => loginAs(app, email, TEST_PASSWORD);

  async function subscriber(name: string, provider: 'stripe' | 'operator', status = 'active') {
    const user = await createTestUser(`${name}@spine.test`);
    await store().billing.put({
      user_id: user.id, provider, customer_id: provider === 'stripe' ? `cus_${name}` : null, subscription_id: provider === 'stripe' ? `sub_${name}` : null, interval: provider === 'stripe' ? 'month' : null,
      plan: 'premium', status, founding: false, current_period_end: new Date(Date.now() + 20 * 86_400_000).toISOString(), cancel_scheduled: provider === 'operator', updated_at: new Date().toISOString(),
    });
    return user;
  }

  it('lists what each account pays for, to an administrator only', async () => {
    await subscriber('sub-paying', 'stripe');
    await subscriber('sub-granted', 'operator');
    expect((await app.inject({ method: 'GET', url: '/api/admin/subscriptions' })).statusCode).toBe(401);
    // The marketing role reads the numbers, and the numbers are never a person: this list names one, so it is not theirs.
    expect((await app.inject({ method: 'GET', url: '/api/admin/subscriptions', headers: { cookie: await as(MARKETING) } })).statusCode).toBe(403);
    const res = await app.inject({ method: 'GET', url: '/api/admin/subscriptions', headers: { cookie: await as(ADMIN) } });
    expect(res.statusCode).toBe(200);
    const rows = res.json().subscriptions as Array<{ email: string; provider: string; status: string; ends: boolean; interval: string | null }>;
    expect(rows.find(r => r.email === 'sub-paying@spine.test')).toMatchObject({ provider: 'stripe', status: 'active', ends: false, interval: 'month' });
    expect(rows.find(r => r.email === 'sub-granted@spine.test')).toMatchObject({ provider: 'operator', ends: true });
  });

  it('shows with a withdrawal request what the account used since its first payment, and how often it was paid back before', async () => {
    const user = await subscriber('sub-asks', 'stripe');
    await store().billing.queueInvoice('cs_sub_asks', user.id, ago(3));
    const standing = (await standingOf(store(), user.id, new Date()))!;
    await store().billing.requestWithdrawal('w_asks_1', user.id, new Date().toISOString());
    const list = async () => ((await app.inject({ method: 'GET', url: '/api/admin/withdrawals', headers: { cookie: await as(ADMIN) } })).json().requests as Array<{ email: string; used: { pages: number; questions: number; translated: number } | null; earlier_refunds: number }>).find(r => r.email === 'sub-asks@spine.test')!;
    expect(await list()).toMatchObject({ used: { pages: 0, questions: 0, translated: 0 }, earlier_refunds: 0 });
    await store().usage.aiAdd(user.id, meterKey('messages', standing.entitlements, new Date()), 4);
    expect((await list()).used).toMatchObject({ questions: 4 });
    // A request that was paid back earlier is counted against the account when it asks again.
    await store().billing.decideWithdrawal('w_asks_1', { state: 'refunded', refundedMinor: 1000, note: null }, new Date().toISOString());
    await store().billing.requestWithdrawal('w_asks_2', user.id, new Date().toISOString());
    expect((await list()).earlier_refunds).toBe(1);
  });
});

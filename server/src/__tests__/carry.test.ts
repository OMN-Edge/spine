import { describe, it, expect, beforeAll } from 'vitest';
import { getAccountsStore } from 'spine-core/store/index.js';
import { buildTestApp } from './helpers/app.js';
import { createTestUser } from './helpers/seed.js';
import { createRelayGate } from '../billing/gate.js';
import { pagesAllowed } from '../billing/carry.js';
import { standingOf } from '../billing/seat.js';
import { loginAs } from './helpers/app.js';

const LONG_AGO = '2020-01-01T00:00:00.000Z';

/** The pages a paid plan keeps for three months (docs/billing.md, SECURITY.md M-45). */
describe('the pages kept from month to month', () => {
  const store = () => getAccountsStore();
  let n = 0;
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  beforeAll(async () => { app = await buildTestApp(); });
  const premium = async () => {
    const user = await createTestUser(`carry-${++n}@spine.test`, { createdAt: LONG_AGO });
    await store().billing.put({ user_id: user.id, provider: 'operator', customer_id: null, subscription_id: null, interval: 'year', plan: 'premium', status: 'active', founding: false, current_period_end: null, cancel_scheduled: false, updated_at: LONG_AGO });
    return user;
  };
  const gate = (iso: string) => createRelayGate(() => store(), () => new Date(iso));
  const allowed = async (id: string, iso: string) => {
    const now = new Date(iso);
    const standing = (await standingOf(store(), id, now))!;
    return pagesAllowed(store(), id, standing.entitlements, standing.entitlements.allowance.pages, now, false);
  };

  it('lets an account that was idle for three months add ninety pages in the fourth, and refuses the ninety-first', async () => {
    const user = await premium();
    expect(await allowed(user.id, '2027-01-10T00:00:00Z')).toBe(30);
    expect(await allowed(user.id, '2027-02-10T00:00:00Z')).toBe(60);
    expect(await allowed(user.id, '2027-04-10T00:00:00Z')).toBe(90);
    const april = '2027-04-10T00:00:00Z';
    await store().usage.aiAdd(user.id, '2027-04:pages', 89);
    expect(await gate(april).admit(user.id, 'extraction', { pages: 1 })).toBeNull();
    await store().usage.aiAdd(user.id, '2027-04:pages', 1);
    expect(await gate(april).admit(user.id, 'extraction', { pages: 1 })).toMatchObject({ status: 402, code: 'allowance_used' });
    // And the next month has thirty again, nothing left over from the spike.
    expect(await allowed(user.id, '2027-05-10T00:00:00Z')).toBe(30);
  });

  it('keeps no more than three months’ worth however long it is idle', async () => {
    const user = await premium();
    await allowed(user.id, '2027-01-10T00:00:00Z');
    expect(await allowed(user.id, '2027-09-10T00:00:00Z')).toBe(90);
  });

  it('is the plan’s own setting: three months kept and thirty a month on Premium', async () => {
    const payer = await premium();
    const standing = (await standingOf(store(), payer.id, new Date('2027-01-10T00:00:00Z')))!;
    expect(standing.entitlements.carryMonths).toBe(3);
    expect(standing.entitlements.allowance.pages).toBe(30);
  });

  it('keeps what an account has done in all, its own, that no month forgets and that grows with every page, question and translation', async () => {
    const user = await premium();
    const g = (iso: string) => gate(iso);
    await g('2027-01-10T00:00:00Z').settle(user.id, 'extraction', 4000, { pages: 3 });
    await g('2027-01-11T00:00:00Z').settle(user.id, 'page', 4000);
    await g('2027-01-12T00:00:00Z').settle(user.id, 'agent', 4000, { work: 'question-total-0001' });
    await g('2027-01-12T00:01:00Z').settle(user.id, 'agent', 4000, { work: 'question-total-0001' });
    await g('2027-01-13T00:00:00Z').settle(user.id, 'translation', 4000, { work: 'translation-total-01', pages: 5 });
    expect(await store().usage.aiUsed(user.id, 'total:pages')).toBe(4);
    expect(await store().usage.aiUsed(user.id, 'total:messages')).toBe(1);
    expect(await store().usage.aiUsed(user.id, 'total:translated')).toBe(5);
    // A month much later forgets the month counts (thirteen months) and not these.
    await g('2028-09-01T00:00:00Z').settle(user.id, 'agent', 4000, { work: 'question-total-0002' });
    expect(await store().usage.aiUsed(user.id, '2027-01:pages')).toBe(0);
    expect(await store().usage.aiUsed(user.id, 'total:pages')).toBe(4);
    expect(await store().usage.aiUsed(user.id, 'total:messages')).toBe(2);
  });

  it('tells the account page its own totals and no one else’s', async () => {
    Object.assign(process.env, { SPINE_BILLING: 'on', PADDLE_ENVIRONMENT: 'sandbox', PADDLE_API_KEY: 'pdl_test_key', PADDLE_WEBHOOK_SECRET: 'whsec_test', SPINE_CHECKOUT_URL: 'https://pay.spine.example/', SPINE_PADDLE_PRICE_YEAR: 'pri_year', SPINE_PADDLE_PRICE_MONTH: 'pri_month', SPINE_PADDLE_PRICE_FOUNDING: 'pri_founding' });
    const mine = await premium();
    const other = await premium();
    await store().usage.aiAdd(mine.id, 'total:pages', 412);
    await store().usage.aiAdd(other.id, 'total:pages', 9);
    const cookie = await loginAs(app, mine.email, mine.password);
    const view = (await app.inject({ method: 'GET', url: '/api/billing', headers: { cookie } })).json();
    expect(view.totals).toEqual({ pages: 412, messages: 0, translated: 0 });
  });
});

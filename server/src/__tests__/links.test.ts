import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { getAccountsStore } from 'spine-core/store/index.js';
import { LINK_VIEWS_CEILING, linkKey, PLANS } from 'spine-core/billing/plans.js';
import { buildTestApp, loginAs } from './helpers/app.js';
import { createTestUser } from './helpers/seed.js';
import { fakeAuthValue, fakeVaultKeys } from 'spine-core/testing/vault.js';

const LONG_AGO = '2020-01-01T00:00:00.000Z';
const BILLING = {
  SPINE_BILLING: 'on', PADDLE_ENVIRONMENT: 'sandbox', PADDLE_API_KEY: 'pdl_test_key', PADDLE_WEBHOOK_SECRET: 'whsec_test', SPINE_CHECKOUT_URL: 'https://pay.spine.example/',
  SPINE_PADDLE_PRICE_YEAR: 'pri_year', SPINE_PADDLE_PRICE_MONTH: 'pri_month', SPINE_PADDLE_PRICE_FOUNDING: 'pri_founding',
};

/** What the plan lets share links send in a month: SECURITY.md M-45 and M-52, docs/scenarios.md 13.2d. */
describe('the views and bytes of share links', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  const saved = { ...process.env };
  const store = () => getAccountsStore();
  const month = () => new Date().toISOString().slice(0, 7);
  let n = 0;

  beforeAll(async () => { app = await buildTestApp(); });
  afterEach(() => { process.env = { ...saved }; });
  const on = () => Object.assign(process.env, BILLING);

  const account = async (plan: 'family' | 'premium' | null = null) => {
    const user = await createTestUser(`link-${++n}@spine.test`, { createdAt: LONG_AGO });
    if (plan) await store().billing.put({ user_id: user.id, provider: 'operator', customer_id: null, subscription_id: null, interval: 'year', plan, status: 'active', founding: false, current_period_end: null, cancel_scheduled: false, updated_at: LONG_AGO });
    return { ...user, cookie: await loginAs(app, user.email, user.password) };
  };
  const share = async (who: { cookie: string }, id: string) => {
    const res = await app.inject({
      method: 'PUT', url: `/api/shared/${id}`, payload: Buffer.from('sealed'),
      headers: { cookie: who.cookie, 'content-type': 'application/octet-stream', 'x-spine-pass-check': 'c'.repeat(43), 'x-spine-expires': new Date(Date.now() + 86400e3).toISOString() },
    });
    expect(res.statusCode).toBe(201);
  };
  const open = (id: string) => app.inject({ method: 'GET', url: `/api/shared/${id}/bundle` });

  it('counts each opening of a link and what it sent, against the owner’s plan', async () => {
    on();
    const owner = await account();
    await share(owner, 'aaaaaaaaaaaaaaaaaaaaaaa1');
    expect((await open('aaaaaaaaaaaaaaaaaaaaaaa1')).statusCode).toBe(200);
    expect((await open('aaaaaaaaaaaaaaaaaaaaaaa1')).statusCode).toBe(200);
    expect(await store().usage.aiUsed(owner.id, linkKey('views', new Date()))).toBe(2);
    expect(await store().usage.aiUsed(owner.id, linkKey('egress', new Date()))).toBe(12);
  });

  it('refuses a link’s readers when the month’s views are used, and opens it again the next month', async () => {
    on();
    const owner = await account();
    await share(owner, 'aaaaaaaaaaaaaaaaaaaaaaa2');
    await store().usage.aiAdd(owner.id, linkKey('views', new Date()), PLANS.free.linkViews - 1);
    expect((await open('aaaaaaaaaaaaaaaaaaaaaaa2')).statusCode).toBe(200);
    const refused = await open('aaaaaaaaaaaaaaaaaaaaaaa2');
    expect(refused.statusCode).toBe(429);
    expect(refused.json().code).toBe('link_limit');
    // A page image is refused too, and the link is still live: only its readers wait.
    const image = await app.inject({ method: 'GET', url: '/api/shared/aaaaaaaaaaaaaaaaaaaaaaa2/blob/page1' });
    expect(image.statusCode).toBe(429);
    expect((await app.inject({ method: 'GET', url: '/api/shared/aaaaaaaaaaaaaaaaaaaaaaa2/meta' })).statusCode).toBe(200);
    // The count is the month's: a new month starts at nothing.
    expect(await store().usage.aiUsed(owner.id, linkKey('views', new Date(Date.now() + 40 * 86400e3)))).toBe(0);
  });

  it('stops a link when its bytes are used up, whatever its views', async () => {
    on();
    const owner = await account();
    await share(owner, 'aaaaaaaaaaaaaaaaaaaaaaa3');
    await store().usage.aiAdd(owner.id, linkKey('egress', new Date()), PLANS.free.linkBytes);
    expect((await open('aaaaaaaaaaaaaaaaaaaaaaa3')).statusCode).toBe(429);
  });

  it('limits only the free plan: a paid plan’s links are counted and open for whoever needs them, behind a ceiling no use reaches', async () => {
    on();
    expect(PLANS.free).toMatchObject({ linkViews: 20, linkBytes: 1024 ** 3, liveShares: 1 });
    for (const plan of ['trial', 'premium', 'family'] as const) expect([plan, PLANS[plan].linkViews, PLANS[plan].linkBytes, PLANS[plan].liveShares]).toEqual([plan, Infinity, Infinity, null]);
    const paid = await account('premium');
    await share(paid, 'aaaaaaaaaaaaaaaaaaaaaaa6');
    // Past what the free plan allows, a paid plan’s link still opens, and the views are counted.
    await store().usage.aiAdd(paid.id, linkKey('views', new Date()), PLANS.free.linkViews + 1000);
    await store().usage.aiAdd(paid.id, linkKey('egress', new Date()), 10 * PLANS.free.linkBytes);
    expect((await open('aaaaaaaaaaaaaaaaaaaaaaa6')).statusCode).toBe(200);
    // Only at the hidden ceiling does it refuse.
    await store().usage.aiAdd(paid.id, linkKey('views', new Date()), LINK_VIEWS_CEILING);
    expect((await open('aaaaaaaaaaaaaaaaaaaaaaa6')).statusCode).toBe(429);
    // And where there are no plans there is no limit at all.
    process.env = { ...saved };
    const owner = await account();
    await share(owner, 'aaaaaaaaaaaaaaaaaaaaaaa4');
    await store().usage.aiAdd(owner.id, linkKey('views', new Date()), 1_000_000);
    expect((await open('aaaaaaaaaaaaaaaaaaaaaaa4')).statusCode).toBe(200);
    expect(await store().usage.aiUsed(owner.id, linkKey('views', new Date()))).toBe(1_000_000);
  });

  it('pools what links send over a shared plan, counted under the payer, and stops it only at the ceiling', async () => {
    on();
    const payer = await account('family');
    const member = await account();
    const i = (await app.inject({ method: 'POST', url: '/api/family/invites', headers: { cookie: payer.cookie } })).json() as { id: string; secret: string };
    expect((await app.inject({ method: 'POST', url: '/api/family/join', headers: { cookie: member.cookie }, payload: i })).statusCode).toBe(200);
    await share(member, 'aaaaaaaaaaaaaaaaaaaaaaa5');
    expect((await open('aaaaaaaaaaaaaaaaaaaaaaa5')).statusCode).toBe(200);
    expect(await store().usage.aiUsed(payer.id, linkKey('views', new Date(), true))).toBe(1);
    expect(await store().usage.aiUsed(member.id, linkKey('views', new Date()))).toBe(0);
    // The plan does not limit views, so a hundred more change nothing; the ceiling of a plan with seats is twice a single plan’s.
    await store().usage.aiAdd(payer.id, linkKey('views', new Date(), true), 100);
    expect((await open('aaaaaaaaaaaaaaaaaaaaaaa5')).statusCode).toBe(200);
    await store().usage.aiAdd(payer.id, linkKey('views', new Date(), true), 2 * LINK_VIEWS_CEILING);
    expect((await open('aaaaaaaaaaaaaaaaaaaaaaa5')).statusCode).toBe(429);
  });

  it('counts what the owner’s own devices read in the same bytes, and never refuses them', async () => {
    on();
    const owner = await account();
    await app.inject({ method: 'PUT', url: '/api/vault/keys', headers: { cookie: owner.cookie }, payload: { auth_value: fakeAuthValue(), keys: fakeVaultKeys() } });
    const put = await app.inject({ method: 'PUT', url: '/api/vault/objects/profile-aaaa-0001', headers: { cookie: owner.cookie, 'content-type': 'application/octet-stream', 'x-spine-kind': 'profile', 'x-spine-profile': 'profile-0001', 'x-spine-wrapped-key': 'k'.repeat(100), 'x-spine-base-seq': '0' }, payload: Buffer.from('sealed profile') });
    expect(put.statusCode).toBe(200);
    await store().usage.aiAdd(owner.id, linkKey('egress', new Date()), PLANS.free.linkBytes);
    const read = await app.inject({ method: 'GET', url: '/api/vault/objects/profile-aaaa-0001', headers: { cookie: owner.cookie } });
    expect(read.statusCode).toBe(200);
    await new Promise(r => setTimeout(r, 50));
    expect(await store().usage.aiUsed(owner.id, linkKey('egress', new Date()))).toBe(PLANS.free.linkBytes + 'sealed profile'.length);
    void month;
  });
});

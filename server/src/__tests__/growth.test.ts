import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getAccountsStore } from 'spine-core/store/index.js';
import { runCli, type CliIo } from '../cli.js';
import { buildTestApp, loginAs } from './helpers/app.js';
import { createTestUser } from './helpers/seed.js';

const day = () => new Date().toISOString().slice(0, 10);
const cli = (...args: string[]) => {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { out: l => out.push(l), err: l => err.push(l), readPassword: async () => '' };
  return runCli(args, io).then(code => ({ code, out, err }));
};
const totals = async () => Object.fromEntries((await getAccountsStore().metrics.totals(day())).map(t => [t.name, t.total]));

describe('the waitlist', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  beforeAll(async () => { app = await buildTestApp(); });
  afterAll(async () => { await app.close(); });
  const ask = (payload: unknown) => app.inject({ method: 'POST', url: '/api/waitlist', payload: payload as object });

  it('keeps an address once, whatever its case, and answers the same the second time', async () => {
    expect((await ask({ email: 'Hopeful@Example.com', source: 'hn' })).json()).toEqual({ ok: true });
    expect((await ask({ email: 'hopeful@example.com' })).json()).toEqual({ ok: true });
    expect(await getAccountsStore().waitlist.list()).toEqual([{ email: 'hopeful@example.com', created_at: expect.any(String), source: 'hn' }]);
  });

  it('refuses what is not an address, and a source that is not a plain word', async () => {
    expect((await ask({ email: 'not an address' })).statusCode).toBe(400);
    expect((await ask({})).statusCode).toBe(400);
    await ask({ email: 'other@example.com', source: '<script>' });
    expect((await getAccountsStore().waitlist.list()).find(w => w.email === 'other@example.com')?.source).toBeNull();
  });

  it('is limited per source', async () => {
    const strict = await buildTestApp({ keepStore: true, waitlist: { perSource: { max: 2, timeWindow: '1 minute' } } });
    const codes: number[] = [];
    for (let n = 0; n < 3; n++) codes.push((await strict.inject({ method: 'POST', url: '/api/waitlist', payload: { email: `n${n}@example.com` } })).statusCode);
    expect(codes).toEqual([200, 200, 429]);
    await strict.close();
  });

  it('is read and emptied from the command line', async () => {
    await ask({ email: 'first@example.com', source: 'reddit' });
    const listed = await cli('waitlist');
    expect(listed.out.some(l => l.startsWith('first@example.com\t') && l.endsWith('\treddit'))).toBe(true);
    expect((await cli('waitlist-remove', 'First@Example.com')).code).toBe(0);
    expect((await cli('waitlist-remove', 'first@example.com')).code).toBe(1);
  });
});

describe('where sign-ups come from', () => {
  it('counts a sign-up, and the loop it came from when it names one of the known', async () => {
    const app = await buildTestApp({ accounts: { registration: 'approval' } });
    const consent = { consent_health_data: true, accept_terms: true };
    const before = await totals();
    await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'viaShare@example.com', password: 'a-brand-new-password', ref: 'share', ...consent } });
    await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'viaNothing@example.com', password: 'a-brand-new-password', ref: 'made-up', ...consent } });
    const after = await totals();
    expect(after.signup).toBe((before.signup ?? 0) + 2);
    expect(after.signup_from_share).toBe((before.signup_from_share ?? 0) + 1);
    expect(after['signup_from_made-up']).toBeUndefined();
    await app.close();
  });

  it('does not count an address that already had an account', async () => {
    const app = await buildTestApp({ accounts: { registration: 'approval' } });
    const before = (await totals()).signup ?? 0;
    await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'owner@spine.test', password: 'a-brand-new-password', consent_health_data: true, accept_terms: true } });
    expect((await totals()).signup ?? 0).toBe(before);
    await app.close();
  });

  it('is told by the operator command', async () => {
    await getAccountsStore().metrics.bump('share_opened', day());
    const shown = await cli('metrics', '--days=7');
    expect(shown.out.some(l => /^share_opened\t\d+$/.test(l))).toBe(true);
    expect((await cli('metrics', '--days=0')).code).toBe(2);
  });
});

describe('a plan the operator grants', () => {
  it('is given for a time, shown as granted, and ended', async () => {
    const user = await createTestUser('guest@spine.test');
    const given = await cli('grant-plan', 'guest@spine.test', '--days=30');
    expect(given.code).toBe(0);
    const row = (await getAccountsStore().billing.get(user.id))!;
    expect(row).toMatchObject({ provider: 'operator', status: 'active', cancel_scheduled: true });
    expect(Date.parse(row.current_period_end!) - Date.now()).toBeGreaterThan(29 * 86_400_000);
    expect((await cli('revoke-plan', 'guest@spine.test')).code).toBe(0);
    expect((await getAccountsStore().billing.get(user.id))?.status).toBe('canceled');
    expect((await cli('revoke-plan', 'guest@spine.test')).code).toBe(1);
  });

  it('is refused for a nonsense length, an unknown address, and an account that pays', async () => {
    const user = await createTestUser('payer2@spine.test');
    expect((await cli('grant-plan', 'payer2@spine.test', '--days=0')).code).toBe(2);
    expect((await cli('grant-plan', 'nobody@spine.test')).code).toBe(1);
    await getAccountsStore().billing.put({ user_id: user.id, provider: 'paddle', customer_id: 'ctm', subscription_id: 'sub_p2', interval: 'year', status: 'active', founding: false, current_period_end: null, cancel_scheduled: false, updated_at: new Date().toISOString() });
    expect((await cli('grant-plan', 'payer2@spine.test')).code).toBe(1);
  });
});

describe('leaving with a subscription', () => {
  it('is not done until the subscription is cancelled, because the provider would go on charging', async () => {
    const app = await buildTestApp();
    const user = await createTestUser('leaving@spine.test');
    const cookie = await loginAs(app, user.email, user.password);
    await getAccountsStore().billing.put({ user_id: user.id, provider: 'paddle', customer_id: 'ctm_l', subscription_id: 'sub_l', interval: 'month', status: 'active', founding: false, current_period_end: new Date(Date.now() + 20 * 86_400_000).toISOString(), cancel_scheduled: false, updated_at: new Date().toISOString() });
    const refused = await app.inject({ method: 'POST', url: '/api/account/delete', headers: { cookie }, payload: { confirm: user.email } });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe('subscription_active');
    expect(await getAccountsStore().users.findById(user.id)).not.toBeNull();

    await getAccountsStore().billing.put({ ...(await getAccountsStore().billing.get(user.id))!, cancel_scheduled: true });
    expect((await app.inject({ method: 'POST', url: '/api/account/delete', headers: { cookie }, payload: { confirm: user.email } })).statusCode).toBe(200);
    await app.close();
  });
});

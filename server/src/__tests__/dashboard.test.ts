import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { getAccountsStore } from 'spine-core/store/index.js';
import { buildTestApp, loginAs } from './helpers/app.js';
import { createTestUser, TEST_PASSWORD } from './helpers/seed.js';
import { createRelayGate } from '../plans/gate.js';
import { watchBudget } from '../plans/budget.js';
import { dashboardOf, stateOf } from '../dashboard.js';
import { resetMailer, type Mailer, type MailMessage } from '../mail/index.js';
import { runJobs, JOBS } from '../jobs.js';
import { forgetOperatorSettings } from '../operator-settings.js';

const LONG_AGO = '2020-01-01T00:00:00.000Z';
const ADMIN = 'admin-dash@spine.test';
const MARKETING = 'marketing-dash@spine.test';
const CONSENT = { consent_health_data: true, accept_terms: true };

/** The numbers the marketing plan's dashboard shows, the monthly AI budget, and the counts of where people meet a limit: all counts, none a person. */
describe('the dashboard', () => {
  const saved = { ...process.env };
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  let sent: MailMessage[];
  const fakeMailer: Mailer = { get enabled() { return true; }, async send(m) { sent.push(m); } };
  beforeAll(async () => { app = await buildTestApp({ accounts: { registration: 'approval' }, admin: { admins: () => new Set([ADMIN]), readers: () => new Set([ADMIN, MARKETING]) } }); });
  beforeEach(() => { sent = []; resetMailer(fakeMailer); });
  afterEach(() => { process.env = { ...saved }; resetMailer(null); });
  const store = () => getAccountsStore();
  const gate = () => createRelayGate(() => store());

  it('is for an administrator only', async () => {
    const admin = await createTestUser(ADMIN);
    const other = await createTestUser('not-admin-dash@spine.test');
    expect((await app.inject({ method: 'GET', url: '/api/admin/dashboard' })).statusCode).toBe(401);
    const cookieOther = await loginAs(app, other.email, other.password);
    expect((await app.inject({ method: 'GET', url: '/api/admin/dashboard', headers: { cookie: cookieOther } })).statusCode).toBe(403);
    const cookieAdmin = await loginAs(app, admin.email, admin.password);
    const res = await app.inject({ method: 'GET', url: '/api/admin/dashboard', headers: { cookie: cookieAdmin } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ accounts: { founding: { limit: 500 } }, funnel: { signups: expect.any(Number) }, guardrails: expect.any(Array) });
  });

  it('is read by the marketing role too, which can change nothing', async () => {
    const marketing = await createTestUser(MARKETING);
    const cookie = await loginAs(app, marketing.email, marketing.password);
    expect((await app.inject({ method: 'GET', url: '/api/admin/dashboard', headers: { cookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/admin/accounts', headers: { cookie } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/admin/accounts/nobody/approve', headers: { cookie }, payload: {} })).statusCode).toBe(403);
  });

  it('lets an administrator change the targets, the budget and the reminders, the marketing role only read them, and keeps each within bounds', async () => {
    if (!(await store().users.findByEmail(ADMIN))) await createTestUser(ADMIN);
    if (!(await store().users.findByEmail(MARKETING))) await createTestUser(MARKETING);
    const asAdmin = await loginAs(app, ADMIN, TEST_PASSWORD);
    const asMarketing = await loginAs(app, MARKETING, TEST_PASSWORD);
    const put = (cookie: string, key: string, value: unknown) => app.inject({ method: 'PUT', url: '/api/admin/settings', headers: { cookie }, payload: { key, value } });
    const read = async (cookie: string) => (await app.inject({ method: 'GET', url: '/api/admin/settings', headers: { cookie } })).json().settings as Array<{ key: string; value: number | null; source: string }>;
    // The defaults, and where a value comes from.
    const first = await read(asMarketing);
    expect(first.find(s => s.key === 'target.accounts')).toMatchObject({ value: 300, source: 'default' });
    process.env.SPINE_AI_BUDGET_EUR = '250';
    forgetOperatorSettings();
    expect((await read(asAdmin)).find(s => s.key === 'ai.budget')).toMatchObject({ value: 250, source: 'environment' });
    // Only an administrator changes one, and only within its bounds.
    expect((await put(asMarketing, 'target.accounts', 500)).statusCode).toBe(403);
    expect((await put(asAdmin, 'target.imported', 140)).statusCode).toBe(400);
    expect((await put(asAdmin, 'target.accounts', 2.5)).statusCode).toBe(400);
    expect((await put(asAdmin, 'no.such', 1)).statusCode).toBe(400);
    expect((await put(asAdmin, 'mail.nudge_days', 3)).statusCode).toBe(400);
    expect((await put(asAdmin, 'target.accounts', 500)).statusCode).toBe(200);
    expect((await put(asAdmin, 'ai.budget', 80.5)).statusCode).toBe(200);
    expect((await read(asAdmin)).find(s => s.key === 'ai.budget')).toMatchObject({ value: 80.5, source: 'admin' });
    // The numbers follow at once.
    const d = (await app.inject({ method: 'GET', url: '/api/admin/dashboard', headers: { cookie: asAdmin } })).json();
    expect(d.guardrails.find((g: { key: string }) => g.key.startsWith('Sign-ups in the last 30 days'))).toMatchObject({ target: 500 });
    expect(d.costs.budget_euros).toBe(80.5);
    // Forgotten, the variable applies again.
    expect((await put(asAdmin, 'ai.budget', null)).statusCode).toBe(200);
    expect((await read(asAdmin)).find(s => s.key === 'ai.budget')).toMatchObject({ value: 250, source: 'environment' });
    await put(asAdmin, 'target.accounts', null);
  });

  it('lets an administrator, and no one else, change the hidden ceilings, which then bind the relay without a file and without a restart', async () => {
    if (!(await store().users.findByEmail(ADMIN))) await createTestUser(ADMIN);
    if (!(await store().users.findByEmail(MARKETING))) await createTestUser(MARKETING);
    const asAdmin = await loginAs(app, ADMIN, TEST_PASSWORD);
    const asMarketing = await loginAs(app, MARKETING, TEST_PASSWORD);
    const get = (cookie?: string) => app.inject({ method: 'GET', url: '/api/admin/fair-use', headers: cookie ? { cookie } : {} });
    const put = (cookie: string, path: unknown, value: unknown) => app.inject({ method: 'PUT', url: '/api/admin/fair-use', headers: { cookie }, payload: { path, value } });
    // Never shown to the marketing role or to anyone not signed in.
    expect((await get()).statusCode).toBe(401);
    expect((await get(asMarketing)).statusCode).toBe(403);
    expect((await put(asMarketing, 'premium.monthly.messages', 5)).statusCode).toBe(403);
    const row = (res: { json: () => { sections: Array<{ rows: Array<{ path: string; value: number; source: string }> }> } }, path: string) => res.json().sections.flatMap(s => s.rows).find(r => r.path === path)!;
    expect(row(await get(asAdmin), 'premium.monthly.messages')).toMatchObject({ value: 600, source: 'file or default' });
    // Bounds: a value that exists, a number, inside its range.
    for (const [path, value] of [['premium.monthly.nothing', 5], ['nobody.monthly.messages', 5], ['premium.monthly.messages', -1], ['premium.monthly.messages', 'many'], ['watch.fractionOfCeiling', 2], ['premium.monthly.readingMultiple', 1000], ['__proto__.x', 1], [42, 1]] as Array<[unknown, unknown]>) {
      expect((await put(asAdmin, path, value)).statusCode, String(path)).toBe(400);
    }
    // A change binds the relay at once on this instance, with no file.
    const user = await createTestUser('ceiling-sub@spine.test', { createdAt: '2020-01-01T00:00:00.000Z' });
    await store().billing.put({ user_id: user.id, provider: 'operator', customer_id: null, subscription_id: null, interval: 'year', plan: 'premium', status: 'active', founding: false, current_period_end: null, cancel_scheduled: false, updated_at: '2020-01-01T00:00:00.000Z' });
    const gate = createRelayGate(() => store());
    expect(await gate.admit(user.id, 'agent', { work: 'question-ceiling-0001' })).toBeNull();
    expect((await put(asAdmin, 'premium.yearly.messages', 1)).statusCode).toBe(200);
    expect(row(await get(asAdmin), 'premium.yearly.messages')).toMatchObject({ value: 1, source: 'admin' });
    await store().usage.aiAdd(user.id, `${new Date().toISOString().slice(0, 7)}:messages`, 1);
    expect(await gate.admit(user.id, 'agent', { work: 'question-ceiling-0002' })).toMatchObject({ code: 'fair_use' });
    // Reset gives the built-in one back, and an empty document is not left behind.
    expect((await put(asAdmin, 'premium.yearly.messages', null)).statusCode).toBe(200);
    expect(row(await get(asAdmin), 'premium.yearly.messages')).toMatchObject({ value: 2400, source: 'file or default' });
    expect((await store().settings.all()).find(r => r.key === 'fair_use')).toBeUndefined();
    expect(await gate.admit(user.id, 'agent', { work: 'question-ceiling-0003' })).toBeNull();
  });

  it('asks for the password again and refuses another origin before changing a setting or a ceiling', async () => {
    if (!(await store().users.findByEmail(ADMIN))) await createTestUser(ADMIN);
    const asAdmin = await loginAs(app, ADMIN, TEST_PASSWORD);
    const change = (url: string, payload: object, headers: Record<string, string> = {}) => app.inject({ method: 'PUT', url, headers: { cookie: asAdmin, ...headers }, payload });
    // From another site, with the cookie: refused before anything is looked at.
    expect((await change('/api/admin/settings', { key: 'target.accounts', value: 10 }, { 'sec-fetch-site': 'cross-site' })).statusCode).toBe(403);
    expect((await change('/api/admin/fair-use', { path: 'premium.monthly.messages', value: 1 }, { origin: 'https://evil.example', host: 'spine.example' })).statusCode).toBe(403);
    // A session whose password was typed more than ten minutes ago is asked for it again.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 11 * 60_000);
    try {
      await store().sessions.touch((await store().users.findByEmail(ADMIN))!.id, (await store().sessions.list((await store().users.findByEmail(ADMIN))!.id))[0]!.id, new Date().toISOString());
      for (const [url, payload] of [['/api/admin/settings', { key: 'target.accounts', value: 10 }], ['/api/admin/fair-use', { path: 'premium.monthly.messages', value: 1 }]] as const) {
        const res = await change(url, payload);
        expect(res.statusCode, url).toBe(403);
        expect(res.json(), url).toMatchObject({ code: 'reauth_required' });
      }
    } finally { vi.useRealTimers(); }
    expect((await store().settings.all()).find(r => r.key === 'fair_use' || r.key === 'target.accounts')).toBeUndefined();
  });

  it('counts sign-ups by where they came from, and never says who', async () => {
    for (const ref of ['reddit', 'reddit', 'hn', 'made-up']) {
      await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: `dash-${Math.random().toString(36).slice(2)}@example.com`, password: 'a-brand-new-password', ref, ...CONSENT } });
    }
    const d = await dashboardOf(store());
    expect(d.sources).toMatchObject({ reddit: 2, hn: 1 });
    expect(d.sources['made-up']).toBeUndefined();
    expect(d.windows.today.signup).toBeGreaterThanOrEqual(4);
    expect(JSON.stringify(d)).not.toMatch(/@/);
  });

  it('shows how far accounts got: read, imported, asked, translated, by plan and by week of sign-up', async () => {
    const before = await dashboardOf(store());
    const a = await createTestUser('dash-funnel-a@spine.test');
    const b = await createTestUser('dash-funnel-b@spine.test');
    await store().usage.aiAdd(a.id, 'total:pages', 12);
    await store().usage.aiAdd(a.id, 'total:messages', 3);
    await store().usage.aiAdd(b.id, 'total:pages', 2);
    await store().usage.aiAdd(b.id, 'total:translated', 1);
    const d = await dashboardOf(store());
    expect(d.funnel.signups - before.funnel.signups).toBe(2);
    expect(d.funnel.read - before.funnel.read).toBe(2);
    expect(d.funnel.imported - before.funnel.imported).toBe(1);
    expect(d.funnel.asked - before.funnel.asked).toBe(1);
    expect(d.funnel.translated - before.funnel.translated).toBe(1);
    expect(d.cohorts.at(-1)).toMatchObject({ signups: expect.any(Number) });
    expect(d.guardrails.find(g => g.key.startsWith('Imported'))).toMatchObject({ target: 40, unit: 'percent' });
  });

  it('counts where an account meets a limit and a ceiling, by kind and by day', async () => {
    const user = await createTestUser('dash-limit@spine.test', { createdAt: LONG_AGO });
    const month = new Date().toISOString().slice(0, 7);
    await store().usage.aiAdd(user.id, `${month}:pages`, 3);
    const before = (await dashboardOf(store())).windows.today;
    expect(await gate().admit(user.id, 'extraction')).toMatchObject({ code: 'allowance_used' });
    expect(await gate().admit(user.id, 'translation')).toMatchObject({ code: 'plan_required' });
    expect(await gate().admit(user.id, 'chat')).toMatchObject({ code: 'plan_required' });
    const after = (await dashboardOf(store())).windows.today;
    expect((after.limit_pages ?? 0) - (before.limit_pages ?? 0)).toBe(1);
    expect((after.limit_feature_translation ?? 0) - (before.limit_feature_translation ?? 0)).toBe(1);
    expect((after.limit_feature_chat ?? 0) - (before.limit_feature_chat ?? 0)).toBe(1);
  });

  it('tells the operator once at half, four fifths and all of the monthly AI budget, and nothing without one', async () => {
    const month = new Date().toISOString().slice(0, 7);
    const user = await createTestUser('dash-budget@spine.test');
    expect(await watchBudget(store())).toEqual([]);
    process.env.SPINE_ALERT_EMAIL = 'operator@spine.test';
    process.env.SPINE_AI_BUDGET_EUR = '100';
    // Forty euros of estimated cost is under half.
    await store().usage.aiAdd(user.id, `${month}:cost:reading`, 40_000_000);
    expect(await watchBudget(store())).toEqual([]);
    await store().usage.aiAdd(user.id, `${month}:cost:chat`, 15_000_000);
    expect(await watchBudget(store())).toEqual([50]);
    expect(await watchBudget(store())).toEqual([]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: 'operator@spine.test' });
    expect(sent[0]!.text).not.toMatch(/dash-budget/);
    // Four fifths and all of it, in one look, are two steps said at once and never again.
    await store().usage.aiAdd(user.id, `${month}:cost:translation`, 60_000_000);
    expect(await watchBudget(store())).toEqual([80, 100]);
    expect(await watchBudget(store())).toEqual([]);
    expect(sent).toHaveLength(3);
  });

  it('is one of the jobs that run on a clock, and a failing job does not stop it', async () => {
    expect(JOBS.map(j => j.name)).toContain('watching the AI budget');
    const ran: string[] = [];
    const failed = await runJobs(() => undefined, [{ name: 'a', run: async () => { throw new Error('x'); } }, { name: 'b', run: async () => { ran.push('b'); } }]);
    expect([failed, ran]).toEqual([1, ['b']]);
  });

});

/** A target for a month is not failed on the first day (T-10): neutral when too early, and pro-rated to the days that have passed. */
describe('where a guardrail stands', () => {
  it('is neutral with less than a week of data, however far from the target', () => {
    for (const day of [0, 1, 3, 6.9]) expect(stateOf(1, 300, true, day, true)).toBe('early');
    expect(stateOf(null, 300, true, 1, true)).toBe('ok');
  });

  it('measures a 30-day target against the days that have passed: one sign-up on day 8 of a target of 300 is far behind, 80 is on track', () => {
    expect(stateOf(1, 300, true, 8, true)).toBe('red');
    expect(stateOf(80, 300, true, 8, true)).toBe('ok');
    expect(stateOf(65, 300, true, 8, true)).toBe('amber');
  });

  it('is red on day 20 with a tenth of the target, and on track at two-thirds of it', () => {
    expect(stateOf(30, 300, true, 20, true)).toBe('red');
    expect(stateOf(200, 300, true, 20, true)).toBe('ok');
  });

  it('holds the whole target after the window, so day 45 is judged on 300 and not on more', () => {
    expect(stateOf(300, 300, true, 45, true)).toBe('ok');
    expect(stateOf(100, 300, true, 45, true)).toBe('red');
  });

  it('does not pro-rate a target that is not counted over the window, but is still neutral early on', () => {
    expect(stateOf(10, 40, true, 3)).toBe('early');
    expect(stateOf(10, 40, true, 20)).toBe('red');
  });
});

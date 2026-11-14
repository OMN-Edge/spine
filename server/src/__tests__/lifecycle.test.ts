import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getAccountsStore } from 'spine-core/store/index.js';
import { buildTestApp } from './helpers/app.js';
import { createTestUser } from './helpers/seed.js';
import { issueUserToken } from '../accounts.js';
import { resetMailer, type Mailer, type MailMessage } from '../mail/index.js';
import { nudgeMail, planThatFits, sendLifecycleMail, sendWelcome, trialEndsMail, unsubscribeToken, userOfUnsubscribeToken } from '../lifecycle.js';
import { JOBS } from '../jobs.js';
import { settingOf } from '../operator-settings.js';

const BILLING = { SPINE_BILLING: 'on', PADDLE_ENVIRONMENT: 'sandbox', PADDLE_API_KEY: 'pdl_test_key', PADDLE_WEBHOOK_SECRET: 'whsec_test', SPINE_CHECKOUT_URL: 'https://pay.spine.example/', SPINE_PADDLE_PRICE_YEAR: 'pri_year', SPINE_PADDLE_PRICE_MONTH: 'pri_month', SPINE_PADDLE_PRICE_FOUNDING: 'pri_founding' };
const DAY = 24 * 3600e3;

/** The mail about using Spine: a welcome, a reminder now and then, and two weeks before a trial ends what was done and the plan that fits. No medical content, ever. */
describe('the mail about using Spine', () => {
  const saved = { ...process.env };
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  let sent: MailMessage[];
  const fakeMailer: Mailer = { get enabled() { return true; }, async send(m) { sent.push(m); } };
  beforeAll(async () => { app = await buildTestApp(); });
  beforeEach(() => { sent = []; resetMailer(fakeMailer); });
  afterEach(() => { process.env = { ...saved }; resetMailer(null); });
  const store = () => getAccountsStore();
  const to = (email: string) => sent.filter(m => m.to === email);

  it('welcomes an account once, when its address is confirmed, with the first step and nothing of its records', async () => {
    const user = await createTestUser('life-welcome@spine.test', { verified: false, language: 'fr' });
    const token = await issueUserToken(user.id, 'verify', 60_000);
    expect((await app.inject({ method: 'POST', url: '/api/auth/verify', payload: { token } })).statusCode).toBe(200);
    expect(to(user.email)).toHaveLength(1);
    const mail = to(user.email)[0]!;
    expect(mail.subject).toBe('Bienvenue dans Spine');
    expect(mail.text).toContain('/upload');
    expect(await sendWelcome(store(), user.id)).toBe(false);
    expect(to(user.email)).toHaveLength(1);
  });

  it('sends no reminder unless the operator set an interval, and then one an interval, counted from the account’s day or the last one', async () => {
    const user = await createTestUser('life-nudge@spine.test', { createdAt: new Date(Date.now() - 100 * DAY).toISOString() });
    expect(await settingOf(store(), 'mail.nudge_days', {})).toBeNull();
    expect(await settingOf(store(), 'mail.nudge_days', { SPINE_NUDGE_DAYS: '3' })).toBeNull();
    expect(await settingOf(store(), 'mail.nudge_days', { SPINE_NUDGE_DAYS: '60' })).toBe(60);
    await sendLifecycleMail(store());
    expect(to(user.email)).toHaveLength(0);
    process.env.SPINE_NUDGE_DAYS = '60';
    await sendLifecycleMail(store());
    expect(to(user.email)).toHaveLength(1);
    expect(to(user.email)[0]!.subject).toBe('Had an appointment lately?');
    // The same day, and thirty days on, nothing; sixty days on, another.
    await sendLifecycleMail(store());
    await sendLifecycleMail(store(), new Date(Date.now() + 30 * DAY));
    expect(to(user.email)).toHaveLength(1);
    await sendLifecycleMail(store(), new Date(Date.now() + 61 * DAY));
    expect(to(user.email)).toHaveLength(2);
  });

  it('is not sent to an address that is not confirmed or an account not approved, nor with no mailer', async () => {
    process.env.SPINE_NUDGE_DAYS = '30';
    const old = new Date(Date.now() - 100 * DAY).toISOString();
    const unverified = await createTestUser('life-unverified@spine.test', { verified: false, createdAt: old });
    const unapproved = await createTestUser('life-unapproved@spine.test', { approved: false, createdAt: old });
    await sendLifecycleMail(store());
    expect([to(unverified.email), to(unapproved.email)]).toEqual([[], []]);
    resetMailer({ get enabled() { return false; }, async send() { throw new Error('no mailer'); } });
    expect(await sendLifecycleMail(store())).toBe(0);
  });

  it('stops the reminder and the trial mail for an account that used the link, and for no other', async () => {
    process.env.SPINE_NUDGE_DAYS = '30';
    const old = new Date(Date.now() - 100 * DAY).toISOString();
    const stops = await createTestUser('life-stops@spine.test', { createdAt: old });
    const stays = await createTestUser('life-stays@spine.test', { createdAt: old });
    const res = await app.inject({ method: 'POST', url: '/api/mail/unsubscribe', payload: { token: unsubscribeToken(stops.id) } });
    expect(res.statusCode).toBe(200);
    await sendLifecycleMail(store());
    expect(to(stops.email)).toHaveLength(0);
    expect(to(stays.email)).toHaveLength(1);
    // A token that is not ours, or is another account’s with a changed id, is answered the same and changes nothing.
    expect((await app.inject({ method: 'POST', url: '/api/mail/unsubscribe', payload: { token: `${stays.id}.${'0'.repeat(32)}` } })).json()).toEqual({ ok: true });
    expect(userOfUnsubscribeToken(`${stays.id}.${unsubscribeToken(stops.id).split('.')[1]}`)).toBeNull();
    expect(userOfUnsubscribeToken(unsubscribeToken(stays.id))).toBe(stays.id);
    expect(userOfUnsubscribeToken(42)).toBeNull();
    await sendLifecycleMail(store(), new Date(Date.now() + 40 * DAY));
    expect(to(stops.email)).toHaveLength(0);
    expect(to(stays.email)).toHaveLength(2);
  });

  it('tells a trial account two weeks before it ends what it did and the plan that fits, once, and an account past that nothing', async () => {
    Object.assign(process.env, BILLING);
    const day = (n: number) => new Date(Date.now() - n * DAY).toISOString();
    // A trial lasts six months (183 days or so): 175 days in is under two weeks from the end; 100 days in is not.
    const near = await createTestUser('life-trial-near@spine.test', { createdAt: day(172) });
    const far = await createTestUser('life-trial-far@spine.test', { createdAt: day(100) });
    await store().usage.aiAdd(near.id, 'total:pages', 37);
    await store().usage.aiAdd(near.id, 'total:messages', 5);
    await sendLifecycleMail(store());
    expect(to(far.email)).toHaveLength(0);
    expect(to(near.email)).toHaveLength(1);
    const mail = to(near.email)[0]!;
    expect(mail.subject).toBe('Your Spine trial ends in two weeks');
    expect(mail.text).toMatch(/37/);
    expect(mail.text).toContain('Essential');
    expect(mail.text).toContain('/unsubscribe#');
    await sendLifecycleMail(store());
    expect(to(near.email)).toHaveLength(1);
  });

  it('runs in a job that has plans on and none of the payment provider’s settings, as the hourly job and the relay are deployed', async () => {
    Object.assign(process.env, { SPINE_BILLING: 'on', SPINE_NUDGE_DAYS: '30' });
    for (const k of ['PADDLE_ENVIRONMENT', 'PADDLE_API_KEY', 'PADDLE_WEBHOOK_SECRET', 'SPINE_CHECKOUT_URL', 'SPINE_PADDLE_PRICE_YEAR', 'SPINE_PADDLE_PRICE_MONTH', 'SPINE_PADDLE_PRICE_FOUNDING']) delete process.env[k];
    const old = await createTestUser('life-job@spine.test', { createdAt: new Date(Date.now() - 100 * DAY).toISOString() });
    await expect(sendLifecycleMail(store())).resolves.toBeGreaterThanOrEqual(1);
    expect(to(old.email)).toHaveLength(1);
  });

  it('chooses the plan from what was done: translation is Premium’s, questions are Essential’s, the rest the free plan’s', () => {
    expect([planThatFits({ questions: 0, translated: 0 }), planThatFits({ questions: 4, translated: 0 }), planThatFits({ questions: 0, translated: 2 }), planThatFits({ questions: 9, translated: 1 })]).toEqual(['free', 'essential', 'premium', 'premium']);
  });

  it('says nothing of what an account holds, whatever the account', () => {
    const everything = [
      nudgeMail({ email: 'a@example.org', language: 'de' }, 'u-1'),
      trialEndsMail({ email: 'a@example.org', language: 'ro' }, 'u-1', { endsOn: '2027-01-15', pages: 3, questions: 2, translated: 1, fits: 'premium' }),
    ].map(m => m.text).join('\n');
    expect(everything).not.toMatch(/diagnos|analiz|blood|sânge|Blut|result|rezultat|medic/i);
  });

  it('is one of the jobs that run on a clock', () => {
    expect(JOBS.map(j => j.name)).toContain('mailing the reminders and the trial summaries');
  });
});

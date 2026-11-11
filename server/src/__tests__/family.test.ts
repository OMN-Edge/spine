import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { getAccountsStore } from 'spine-core/store/index.js';
import { PAGE, PLANS, SEAT_COOLDOWN_DAYS } from 'spine-core/billing/plans.js';
import { buildTestApp, loginAs } from './helpers/app.js';
import { createTestUser } from './helpers/seed.js';
import { createRelayGate } from '../billing/gate.js';
import { accountEntitlements } from '../billing/entitlements.js';
import { fakeAuthValue, fakeVaultKeys } from 'spine-core/testing/vault.js';

const LONG_AGO = '2020-01-01T00:00:00.000Z';
const BILLING = {
  SPINE_BILLING: 'on', PADDLE_ENVIRONMENT: 'sandbox', PADDLE_API_KEY: 'pdl_test_key', PADDLE_WEBHOOK_SECRET: 'whsec_test', SPINE_CHECKOUT_URL: 'https://pay.spine.example/',
  SPINE_PADDLE_PRICE_YEAR: 'pri_year', SPINE_PADDLE_PRICE_MONTH: 'pri_month', SPINE_PADDLE_PRICE_FOUNDING: 'pri_founding',
};
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const profileHeaders = { 'content-type': 'application/octet-stream', 'x-spine-kind': 'profile', 'x-spine-profile': 'profile-0001', 'x-spine-wrapped-key': 'k'.repeat(100), 'x-spine-base-seq': '0' };

/** Seats are accounts that share one subscription: SECURITY.md M-52, docs/scenarios.md. */
describe('seats in a shared plan', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  const saved = { ...process.env };
  const store = () => getAccountsStore();
  let n = 0;

  beforeAll(async () => { app = await buildTestApp(); });
  afterEach(() => { process.env = { ...saved }; });
  const on = () => Object.assign(process.env, BILLING);

  const account = async (plan: 'family' | 'premium' | null = null) => {
    const user = await createTestUser(`seat-${++n}@spine.test`, { createdAt: LONG_AGO });
    if (plan) await store().billing.put({ user_id: user.id, provider: 'operator', customer_id: null, subscription_id: null, interval: 'year', plan, status: 'active', founding: false, current_period_end: null, cancel_scheduled: false, updated_at: LONG_AGO });
    const cookie = await loginAs(app, user.email, user.password);
    return { ...user, cookie };
  };
  const call = (who: { cookie: string }, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) => app.inject({ method, url, headers: { cookie: who.cookie }, payload: payload as never });
  const invite = async (organizer: { cookie: string }) => (await call(organizer, 'POST', '/api/family/invites')).json() as { id: string; secret: string; expires_at: string };
  const join = async (organizer: { cookie: string }, member: { cookie: string }) => { const i = await invite(organizer); return call(member, 'POST', '/api/family/join', { id: i.id, secret: i.secret }); };
  const keys = (who: { cookie: string }) => app.inject({ method: 'PUT', url: '/api/vault/keys', headers: { cookie: who.cookie }, payload: { auth_value: fakeAuthValue(), keys: fakeVaultKeys() } });
  const person = (who: { cookie: string }, id: string, base = 0) => app.inject({ method: 'PUT', url: `/api/vault/objects/${id}`, headers: { cookie: who.cookie, ...profileHeaders, 'x-spine-base-seq': String(base) }, payload: Buffer.from('sealed profile') });

  it('is a plan with six seats, and the plans that are not shared have one', () => {
    expect(PLANS.family.seats).toBe(6);
    for (const plan of ['trial', 'free', 'premium'] as const) expect(PLANS[plan].seats).toBe(1);
  });

  it('is nothing on an instance with no plans', async () => {
    const who = await account();
    expect((await call(who, 'GET', '/api/family')).json()).toEqual({ enabled: false });
    expect((await call(who, 'POST', '/api/family/invites')).statusCode).toBe(404);
    expect((await call(who, 'POST', '/api/family/join', { id: 'a'.repeat(22), secret: 'b'.repeat(43) })).statusCode).toBe(404);
  });

  describe('inviting', () => {
    it('is for the account that pays for a plan with seats, and for no other', async () => {
      on();
      for (const plan of [null, 'premium'] as const) {
        const who = await account(plan);
        const res = await call(who, 'POST', '/api/family/invites');
        expect(res.statusCode, String(plan)).toBe(402);
        expect(res.json().code).toBe('plan_required');
      }
      const payer = await account('family');
      const made = await call(payer, 'POST', '/api/family/invites');
      expect(made.statusCode).toBe(201);
      expect(made.json().secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });

    it('keeps only a hash of the secret: the list shows an invitation, never what opens it', async () => {
      on();
      const payer = await account('family');
      const made = await invite(payer);
      const listed = (await call(payer, 'GET', '/api/family')).json();
      expect(listed.invites).toHaveLength(1);
      expect(JSON.stringify(listed)).not.toContain(made.secret);
      expect(JSON.stringify(listed.invites[0])).not.toContain('hash');
    });

    it('can be taken back, and is limited in how many wait', async () => {
      on();
      const payer = await account('family');
      const first = await invite(payer);
      expect((await call(payer, 'DELETE', `/api/family/invites/${first.id}`)).statusCode).toBe(200);
      expect((await call(payer, 'DELETE', `/api/family/invites/${first.id}`)).statusCode).toBe(404);
      for (let i = 0; i < 10; i++) expect((await call(payer, 'POST', '/api/family/invites')).statusCode).toBe(201);
      const eleventh = await call(payer, 'POST', '/api/family/invites');
      expect(eleventh.statusCode).toBe(409);
      expect(eleventh.json().code).toBe('too_many');
    });
  });

  describe('taking a seat', () => {
    it('gives the plan: its features here, and the plan’s one allowance, counted under the account that pays', async () => {
      on();
      const payer = await account('family');
      const member = await account();
      const gate = createRelayGate(() => store());
      // Without a seat this account is on the free plan, which has no translation.
      expect(await gate.admit(member.id, 'translation')).toMatchObject({ code: 'plan_required' });
      expect((await join(payer, member)).statusCode).toBe(200);
      expect(await gate.admit(member.id, 'translation')).toBeNull();
      expect(await accountEntitlements(member.id)).toMatchObject({ plan: 'family', profiles: 6 });
      await gate.settle(member.id, 'extraction', 10 * 1024);
      const month = new Date().toISOString().slice(0, 7);
      expect(await store().usage.aiUsed(payer.id, month)).toBe(100 + 125 * 10);
      expect(await store().usage.aiUsed(member.id, month)).toBe(0);
      // The allowance is the plan's, so what the payer used leaves less for the member.
      await store().usage.aiAdd(payer.id, month, PLANS.family.aiAllowance);
      expect(await gate.admit(member.id, 'extraction')).toMatchObject({ code: 'allowance_used' });
      expect(await gate.admit(payer.id, 'extraction')).toMatchObject({ code: 'allowance_used' });
    });

    it('tells each side what it is, and the account page what the plan holds', async () => {
      on();
      const payer = await account('family');
      const member = await account();
      await join(payer, member);
      const mine = (await call(member, 'GET', '/api/family')).json();
      expect(mine).toMatchObject({ role: 'member', organizer_email: payer.email, profiles: { limit: 6 } });
      expect(mine).not.toHaveProperty('members');
      const theirs = (await call(payer, 'GET', '/api/family')).json();
      expect(theirs).toMatchObject({ role: 'organizer', seats: { used: 2, limit: 6 }, members: [{ id: member.id, email: member.email }], invites: [] });
      expect((await call(member, 'GET', '/api/billing')).json()).toMatchObject({ plan: 'family', seat: 'member' });
      expect((await call(payer, 'GET', '/api/billing')).json()).toMatchObject({ plan: 'family', seat: 'organizer', seats: { limit: 6 } });
    });

    it('shows who an invitation is from before anything is taken, and changes nothing by looking', async () => {
      on();
      const payer = await account('family');
      const member = await account();
      const i = await invite(payer);
      expect((await call(member, 'POST', '/api/family/preview', { id: i.id, secret: i.secret })).json()).toMatchObject({ organizer_email: payer.email, cooldown_days: SEAT_COOLDOWN_DAYS });
      expect(await store().family.membership(member.id)).toBeNull();
      expect((await call(member, 'POST', '/api/family/preview', { id: i.id, secret: 'x'.repeat(43) })).statusCode).toBe(404);
      expect((await call(member, 'POST', '/api/family/preview', { id: 'short', secret: 'x' })).statusCode).toBe(400);
    });

    it('works once, only with its secret, and not for the account that made it', async () => {
      on();
      const payer = await account('family');
      const first = await account();
      const second = await account();
      const i = await invite(payer);
      expect((await call(first, 'POST', '/api/family/join', { id: i.id, secret: 'x'.repeat(43) })).statusCode).toBe(404);
      expect((await call(payer, 'POST', '/api/family/join', { id: i.id, secret: i.secret })).statusCode).toBe(404);
      expect((await call(first, 'POST', '/api/family/join', { id: i.id, secret: i.secret })).statusCode).toBe(200);
      const again = await call(second, 'POST', '/api/family/join', { id: i.id, secret: i.secret });
      expect(again.statusCode).toBe(404);
      expect(again.json().code).toBe('invalid_code');
    });

    it('does not work after its week', async () => {
      on();
      const payer = await account('family');
      const member = await account();
      await store().family.invite(payer.id, { id: 'e'.repeat(22), secretHash: sha256('s'.repeat(43)), now: LONG_AGO, expiresAt: '2020-01-08T00:00:00.000Z' });
      expect((await call(member, 'POST', '/api/family/join', { id: 'e'.repeat(22), secret: 's'.repeat(43) })).statusCode).toBe(404);
    });

    it('holds six accounts at most, the payer included, and says so to the payer and the invited', async () => {
      on();
      const payer = await account('family');
      for (let k = 0; k < 5; k++) expect((await join(payer, await account())).statusCode).toBe(200);
      const full = await call(payer, 'POST', '/api/family/invites');
      expect(full.statusCode).toBe(409);
      expect(full.json().code).toBe('full');
      // An invitation made before the last seat went is refused too.
      const late = await account();
      await store().family.invite(payer.id, { id: 'f'.repeat(22), secretHash: sha256('t'.repeat(43)), now: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600e3).toISOString() });
      const refused = await call(late, 'POST', '/api/family/join', { id: 'f'.repeat(22), secret: 't'.repeat(43) });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().code).toBe('full');
      // Refused, the invitation is not spent.
      expect(await store().family.peek(late.id, 'f'.repeat(22), sha256('t'.repeat(43)), new Date().toISOString())).not.toBeNull();
    });

    it('is one seat to an account, and not for an account whose own plan others share', async () => {
      on();
      const payer = await account('family');
      const other = await account('family');
      const member = await account();
      await join(payer, member);
      const twice = await join(other, member);
      expect(twice.statusCode).toBe(409);
      expect(twice.json().code).toBe('already_member');
      await join(other, await account());
      const shared = await join(payer, other);
      expect(shared.statusCode).toBe(409);
      expect(shared.json().code).toBe('is_organizer');
    });

    it('is refused when the plan it was offered on has ended', async () => {
      on();
      const payer = await account('family');
      const member = await account();
      const i = await invite(payer);
      await store().billing.put({ user_id: payer.id, provider: 'operator', customer_id: null, subscription_id: null, interval: 'year', plan: 'family', status: 'canceled', founding: false, current_period_end: LONG_AGO, cancel_scheduled: false, updated_at: LONG_AGO });
      const res = await call(member, 'POST', '/api/family/join', { id: i.id, secret: i.secret });
      expect(res.statusCode).toBe(402);
      expect(res.json().code).toBe('plan_ended');
    });
  });

  describe('the people a plan holds', () => {
    it('are six across every account, each account’s own included, and a rewritten one is not a new one', async () => {
      on();
      const payer = await account('family');
      const member = await account();
      await join(payer, member);
      await keys(payer);
      await keys(member);
      expect((await person(payer, 'profile-aaaa-0001')).statusCode).toBe(200);
      expect((await person(member, 'profile-bbbb-0002')).statusCode).toBe(200);
      for (const id of ['profile-cccc-0003', 'profile-dddd-0004']) expect((await person(payer, id)).statusCode).toBe(200);
      for (const id of ['profile-eeee-0005', 'profile-ffff-0006']) expect((await person(member, id)).statusCode).toBe(200);
      const own = await person(member, 'profile-hhhh-0008');
      expect(own.statusCode).toBe(402);
      expect((await call(payer, 'GET', '/api/family')).json().profiles).toEqual({ used: 6, limit: 6 });
      // Seven: refused for whoever asks.
      for (const who of [payer, member]) {
        const res = await person(who, 'profile-gggg-0007');
        expect(res.statusCode).toBe(402);
        expect(res.json().code).toBe('plan_required');
      }
      // Replacing one that is there (it names the sequence it last saw) is not another person.
      const seq = ((await person(member, 'profile-bbbb-0002', 1)).json() as { seq?: number }).seq;
      expect(seq).toBeDefined();
    });

    it('free a place when one is deleted, for any account that shares the plan', async () => {
      on();
      const payer = await account('family');
      const member = await account();
      await join(payer, member);
      await keys(payer);
      await keys(member);
      for (const id of ['profile-aaaa-0001', 'profile-bbbb-0002', 'profile-cccc-0003']) await person(payer, id);
      const seqs: number[] = [];
      for (const id of ['profile-dddd-0004', 'profile-eeee-0005', 'profile-ffff-0006']) seqs.push(((await person(member, id)).json() as { seq: number }).seq);
      expect((await person(payer, 'profile-gggg-0007')).statusCode).toBe(402);
      expect((await app.inject({ method: 'DELETE', url: `/api/vault/objects/profile-dddd-0004?base=${seqs[0]}`, headers: { cookie: member.cookie } })).statusCode).toBe(200);
      expect((await person(payer, 'profile-gggg-0007')).statusCode).toBe(200);
    });
  });

  describe('giving a seat up', () => {
    it('leaves the account its own plan and everything it kept, and keeps others’ records out of reach', async () => {
      on();
      const payer = await account('family');
      const member = await account();
      await join(payer, member);
      await keys(member);
      for (const id of ['profile-aaaa-0001', 'profile-bbbb-0002']) await person(member, id);
      expect((await call(member, 'POST', '/api/family/leave')).statusCode).toBe(200);
      expect((await call(member, 'POST', '/api/family/leave')).statusCode).toBe(404);
      expect(await accountEntitlements(member.id)).toMatchObject({ plan: 'free', profiles: 1 });
      // Two people are kept, though the free plan allows one: nothing is deleted, only adding is held back.
      expect((await person(member, 'profile-cccc-0003')).statusCode).toBe(402);
      expect((await call(payer, 'GET', '/api/family')).json()).toMatchObject({ seats: { used: 1 }, members: [] });
    });

    it('is held to a wait before another plan’s seat, and not before the same plan’s', async () => {
      on();
      const payer = await account('family');
      const elsewhere = await account('family');
      const member = await account();
      await join(payer, member);
      await call(member, 'POST', '/api/family/leave');
      const refused = await join(elsewhere, member);
      expect(refused.statusCode).toBe(409);
      expect(refused.json().code).toBe('cooldown');
      expect((await join(payer, member)).statusCode).toBe(200);
      // After the wait it is allowed.
      await call(member, 'POST', '/api/family/leave');
      const later = new Date(Date.now() + (SEAT_COOLDOWN_DAYS + 1) * 24 * 3600e3).toISOString();
      await store().family.invite(elsewhere.id, { id: 'g'.repeat(22), secretHash: sha256('u'.repeat(43)), now: later, expiresAt: new Date(Date.parse(later) + 3600e3).toISOString() });
      expect(await store().family.join(member.id, 'g'.repeat(22), sha256('u'.repeat(43)), later, { seats: 6, cooldownDays: SEAT_COOLDOWN_DAYS })).toEqual({ organizer_id: elsewhere.id });
    });

    it('is the payer’s to end for a member, and only for their own members', async () => {
      on();
      const payer = await account('family');
      const stranger = await account('family');
      const member = await account();
      await join(payer, member);
      expect((await call(stranger, 'DELETE', `/api/family/members/${member.id}`)).statusCode).toBe(404);
      expect((await call(member, 'DELETE', `/api/family/members/${member.id}`)).statusCode).toBe(404);
      expect(await accountEntitlements(member.id)).toMatchObject({ plan: 'family' });
      expect((await call(payer, 'DELETE', `/api/family/members/${member.id}`)).statusCode).toBe(200);
      expect(await accountEntitlements(member.id)).toMatchObject({ plan: 'free' });
    });
  });

  describe('when the plan ends', () => {
    it('leaves a member their own plan, keeps the seat for if it comes back, and deletes nothing', async () => {
      on();
      const payer = await account('family');
      const member = await account();
      await join(payer, member);
      const sub = (await store().billing.get(payer.id))!;
      await store().billing.put({ ...sub, status: 'canceled', current_period_end: LONG_AGO });
      expect(await accountEntitlements(member.id)).toMatchObject({ plan: 'free' });
      expect(await store().family.membership(member.id)).not.toBeNull();
      await store().billing.put({ ...sub });
      expect(await accountEntitlements(member.id)).toMatchObject({ plan: 'family' });
    });

    it('is not shared by a premium plan, which has one seat', async () => {
      on();
      const payer = await account('premium');
      const member = await account();
      await store().family.invite(payer.id, { id: 'h'.repeat(22), secretHash: sha256('v'.repeat(43)), now: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600e3).toISOString() });
      const res = await call(member, 'POST', '/api/family/join', { id: 'h'.repeat(22), secret: 'v'.repeat(43) });
      expect(res.statusCode).toBe(402);
      expect(await accountEntitlements(member.id)).toMatchObject({ plan: 'free' });
    });
  });

  describe('deleting an account', () => {
    it('frees the seat of a member, and ends the seats of everyone when the payer goes', async () => {
      on();
      const payer = await account('family');
      const first = await account();
      const second = await account();
      await join(payer, first);
      await join(payer, second);
      await store().users.delete(first.id);
      expect(await store().family.members(payer.id)).toMatchObject([{ id: second.id }]);
      await store().users.delete(payer.id);
      expect(await store().family.membership(second.id)).toBeNull();
    });
  });
});

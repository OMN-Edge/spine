import { beforeAll, describe, expect, it } from 'vitest';
import { getAccountsStore } from 'spine-core/store/index.js';
import { buildTestApp } from './helpers/app.js';
import { createTestUser } from './helpers/seed.js';
import { BONUS_PAGES, LINK_DAYS, MAX_REWARDED, REWARD_PAGES, grantInvitation, inviteToken, inviterOf, keptBonus, rewardInviter } from '../plans/invitations.js';
import { topupLeft } from '../plans/addons.js';

const CONSENT = { consent_health_data: true, accept_terms: true };

/** The invitation bonus: 10 pages for an invited person when they make an account, once; 50 for whoever invited them when they first buy a plan, for at most five; who invited whom kept only until then. */
describe('the invitation bonus', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  beforeAll(async () => { app = await buildTestApp({ accounts: { registration: 'approval' } }); });
  const store = () => getAccountsStore();
  let n = 0;
  const register = (by: unknown, ip = '10.8.0.1') => {
    const email = `invited-${++n}-${Math.random().toString(36).slice(2)}@example.com`;
    return app.inject({ method: 'POST', url: '/api/auth/register', remoteAddress: ip, payload: { email, password: 'a-brand-new-password', ref: 'invite', by, ...CONSENT } }).then(async r => ({ r, user: await store().users.findByEmail(email) }));
  };

  it('gives the invited account 10 pages when it is made with the link, and the inviter nothing yet', async () => {
    const inviter = await createTestUser('inviter-a@spine.test');
    const { r, user } = await register(inviteToken(inviter.id));
    expect(r.statusCode).toBe(200);
    expect(await topupLeft(store(), user!.id)).toBe(BONUS_PAGES);
    expect(await topupLeft(store(), inviter.id)).toBe(0);
    const plain = await register(undefined);
    expect(await topupLeft(store(), plain.user!.id)).toBe(0);
  });

  it('rewards the inviter with 50 pages when the invited account first buys, once', async () => {
    const inviter = await createTestUser('inviter-b@spine.test');
    const { user } = await register(inviteToken(inviter.id), '10.8.1.1');
    expect(await rewardInviter(store(), user!.id)).toBe(true);
    expect(await topupLeft(store(), inviter.id)).toBe(REWARD_PAGES);
    // A second purchase, a renewal or a message told twice rewards nothing more.
    expect(await rewardInviter(store(), user!.id)).toBe(false);
    expect(await topupLeft(store(), inviter.id)).toBe(REWARD_PAGES);
    // An account nobody invited rewards nobody.
    const plain = await createTestUser('buyer-b@spine.test');
    expect(await rewardInviter(store(), plain.id)).toBe(false);
  });

  it('rewards an account for five purchases and no more, and invites each account once', async () => {
    const inviter = await createTestUser('inviter-c@spine.test');
    const token = inviteToken(inviter.id);
    const invited = [];
    for (let i = 0; i < MAX_REWARDED + 2; i++) invited.push((await register(token, `10.8.2.${i}`)).user!);
    expect(await Promise.all(invited.map(u => rewardInviter(store(), u.id)))).toEqual([true, true, true, true, true, false, false]);
    expect(await topupLeft(store(), inviter.id)).toBe(MAX_REWARDED * REWARD_PAGES);
    expect(await grantInvitation(store(), token, invited[0]!.id)).toBe(false);
    expect(await topupLeft(store(), invited[0]!.id)).toBe(BONUS_PAGES);
  });

  it('forgets who invited an account after ninety days, and rewards nobody then', async () => {
    const inviter = await createTestUser('inviter-d@spine.test');
    const invitee = await createTestUser('invitee-d@spine.test');
    const long = new Date(Date.now() - (LINK_DAYS + 1) * 86_400_000);
    await store().invitations.record(invitee.id, inviter.id, long.toISOString());
    expect(await rewardInviter(store(), invitee.id)).toBe(false);
    expect(await topupLeft(store(), inviter.id)).toBe(0);
    // The sweep forgets what nobody bought for.
    await store().invitations.record(invitee.id, inviter.id, long.toISOString());
    expect(await store().invitations.sweep(new Date(Date.now() - LINK_DAYS * 86_400_000).toISOString())).toBeGreaterThanOrEqual(1);
    expect(await store().invitations.take(invitee.id, '1970-01-01T00:00:00.000Z')).toBeNull();
  });

  it('is gone with either account', async () => {
    const inviter = await createTestUser('inviter-e@spine.test');
    const invitee = await createTestUser('invitee-e@spine.test');
    const other = await createTestUser('invitee-e2@spine.test');
    const now = new Date().toISOString();
    await store().invitations.record(invitee.id, inviter.id, now);
    await store().invitations.record(other.id, inviter.id, now);
    await store().users.delete(invitee.id);
    expect(await store().invitations.take(invitee.id, '1970-01-01T00:00:00.000Z')).toBeNull();
    await store().users.delete(inviter.id);
    expect(await store().invitations.take(other.id, '1970-01-01T00:00:00.000Z')).toBeNull();
  });

  it('adds the pages to what the free plan keeps, for both sides, and nothing for a top-up', async () => {
    const inviter = await createTestUser('inviter-f@spine.test');
    const { user } = await register(inviteToken(inviter.id), '10.8.3.1');
    expect(await keptBonus(store(), user!.id)).toBe(BONUS_PAGES);
    await rewardInviter(store(), user!.id);
    expect(await keptBonus(store(), inviter.id)).toBe(REWARD_PAGES);
    expect(await keptBonus(store(), (await createTestUser('nobody-f@spine.test')).id)).toBe(0);
  });

  it('refuses a link that is not ours, one of the account itself, and one of an account that is gone', async () => {
    const inviter = await createTestUser('inviter-g@spine.test');
    const other = await createTestUser('invitee-g@spine.test');
    expect(inviterOf(`${inviter.id}.${'0'.repeat(24)}`)).toBeNull();
    expect(inviterOf(inviteToken(inviter.id))).toBe(inviter.id);
    expect(inviterOf(undefined)).toBeNull();
    expect(await grantInvitation(store(), `${inviter.id}.${'0'.repeat(24)}`, other.id)).toBe(false);
    expect(await grantInvitation(store(), inviteToken(inviter.id), inviter.id)).toBe(false);
    expect(await grantInvitation(store(), inviteToken('no-such-account'), other.id)).toBe(false);
    expect(await topupLeft(store(), inviter.id) + await topupLeft(store(), other.id)).toBe(0);
    // A link that is bad does not stop an account from being made.
    expect((await register('garbage', '10.8.4.1')).r.statusCode).toBe(200);
  });
});

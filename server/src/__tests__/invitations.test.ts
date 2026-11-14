import { beforeAll, describe, expect, it } from 'vitest';
import { getAccountsStore } from 'spine-core/store/index.js';
import { buildTestApp } from './helpers/app.js';
import { createTestUser } from './helpers/seed.js';
import { BONUS_PAGES, MAX_REWARDED, grantInvitation, inviteToken, inviterOf } from '../billing/invitations.js';
import { topupLeft } from '../billing/addons.js';

const CONSENT = { consent_health_data: true, accept_terms: true };

/** The invitation bonus: 10 pages each when an invited person makes an account, once for them, for at most five of an inviter's, with nothing kept of who invited whom. */
describe('the invitation bonus', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  beforeAll(async () => { app = await buildTestApp({ accounts: { registration: 'approval' } }); });
  const store = () => getAccountsStore();
  let n = 0;
  const register = (by: unknown, ip = '10.8.0.1') => {
    const email = `invited-${++n}-${Math.random().toString(36).slice(2)}@example.com`;
    return app.inject({ method: 'POST', url: '/api/auth/register', remoteAddress: ip, payload: { email, password: 'a-brand-new-password', ref: 'invite', by, ...CONSENT } }).then(async r => ({ r, user: await store().users.findByEmail(email) }));
  };

  it('gives both sides 10 pages when an account is made with the link, and nobody else anything', async () => {
    const inviter = await createTestUser('inviter-a@spine.test');
    const { r, user } = await register(inviteToken(inviter.id));
    expect(r.statusCode).toBe(200);
    expect(await topupLeft(store(), inviter.id)).toBe(BONUS_PAGES);
    expect(await topupLeft(store(), user!.id)).toBe(BONUS_PAGES);
    const plain = await register(undefined);
    expect(await topupLeft(store(), plain.user!.id)).toBe(0);
    expect(await topupLeft(store(), inviter.id)).toBe(BONUS_PAGES);
  });

  it('rewards an account for five invitations and no more, and each invited account once', async () => {
    const inviter = await createTestUser('inviter-b@spine.test');
    const token = inviteToken(inviter.id);
    const invited = [];
    for (let i = 0; i < MAX_REWARDED + 2; i++) invited.push((await register(token, `10.8.1.${i}`)).user!);
    expect(await topupLeft(store(), inviter.id)).toBe(MAX_REWARDED * BONUS_PAGES);
    expect(await Promise.all(invited.map(u => topupLeft(store(), u.id)))).toEqual([10, 10, 10, 10, 10, 0, 0]);
    // The same account cannot be invited twice.
    expect(await grantInvitation(store(), token, invited[0]!.id)).toBe(false);
    expect(await topupLeft(store(), invited[0]!.id)).toBe(10);
  });

  it('refuses a link that is not ours, one of the account itself, and one of an account that is gone', async () => {
    const inviter = await createTestUser('inviter-c@spine.test');
    const other = await createTestUser('invitee-c@spine.test');
    expect(inviterOf(`${inviter.id}.${'0'.repeat(24)}`)).toBeNull();
    expect(inviterOf(inviteToken(inviter.id))).toBe(inviter.id);
    expect(inviterOf(undefined)).toBeNull();
    expect(await grantInvitation(store(), `${inviter.id}.${'0'.repeat(24)}`, other.id)).toBe(false);
    expect(await grantInvitation(store(), inviteToken(inviter.id), inviter.id)).toBe(false);
    expect(await grantInvitation(store(), inviteToken('no-such-account'), other.id)).toBe(false);
    expect(await topupLeft(store(), inviter.id) + await topupLeft(store(), other.id)).toBe(0);
    // A link that is bad does not stop an account from being made.
    expect((await register('garbage', '10.8.2.1')).r.statusCode).toBe(200);
  });

  it('keeps no record of who invited whom, only that it happened', async () => {
    const inviter = await createTestUser('inviter-d@spine.test');
    const { user } = await register(inviteToken(inviter.id), '10.8.3.1');
    expect(await store().usage.aiUsed(user!.id, 'bonus:received')).toBe(1);
    expect(await store().usage.aiUsed(inviter.id, 'bonus:rewarded')).toBe(1);
    expect(await store().usage.aiUsed(user!.id, `invitedby:${inviter.id}`)).toBe(0);
  });
});

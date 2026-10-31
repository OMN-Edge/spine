import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { fakeAuthValue, fakeVaultKeys } from 'spine-core/testing/vault.js';
import { getAccountsStore } from 'spine-core/store/index.js';
import { buildTestApp, loginAs, loginSession } from './helpers/app.js';
import { createTestUser, OWNER_ID } from './helpers/seed.js';
import { resetMailer, type MailMessage } from '../mail/index.js';

const K = (c: string) => c.repeat(100).slice(0, 100);
const WRAPPED = K('w');
const hex = (v: string) => createHash('sha256').update(v).digest('hex');
const INVITE_ID = 'i'.repeat(43);
const PROOF = 'p'.repeat(43);
const PROFILE = 'profile-aaaa-0001';
const OTHER_PROFILE = 'profile-bbbb-0002';

describe('letting another account into a profile', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  let owner: string;
  let guest: string;
  let guestId: string;
  let mails: MailMessage[];
  const saved = { ...process.env };

  beforeAll(async () => {
    mails = [];
    resetMailer({ enabled: true, send: async m => { mails.push(m); } });
    app = await buildTestApp();
    owner = await loginSession(app);
    await app.inject({ method: 'PUT', url: '/api/vault/keys', headers: { cookie: owner }, payload: { auth_value: fakeAuthValue(), keys: fakeVaultKeys() } });
    const u = await createTestUser('guest@spine.test');
    guestId = u.id;
    guest = await loginAs(app, u.email, u.password);
    await app.inject({ method: 'PUT', url: '/api/vault/keys', headers: { cookie: guest }, payload: { auth_value: fakeAuthValue(), keys: fakeVaultKeys() } });
    await put(owner, PROFILE, 'profile', PROFILE, 'record of the profile');
    await put(owner, 'object-a-0001', 'bundle', PROFILE, 'a record of the profile');
    await put(owner, OTHER_PROFILE, 'profile', OTHER_PROFILE, 'another profile');
    await put(owner, 'object-b-0001', 'bundle', OTHER_PROFILE, 'a record of another');
  });
  afterEach(() => { process.env = { ...saved }; });

  const put = (who: string, id: string, kind: string, profile: string, text: string, base = 0, url = '/api/vault/objects') =>
    app.inject({ method: 'PUT', url: `${url}/${id}`, headers: { cookie: who, 'content-type': 'application/octet-stream', 'x-spine-kind': kind, 'x-spine-profile': profile, 'x-spine-wrapped-key': K('k'), 'x-spine-base-seq': String(base) }, payload: Buffer.from(text) });
  const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, who: string, payload?: unknown) => app.inject({ method, url, headers: { cookie: who }, payload: payload as object | undefined });
  const invite = (role = 'guardian', id = INVITE_ID, proof = PROOF, who = owner) => call('POST', '/api/delegations/invites', who, { id, profile_id: PROFILE, role, wrapped: WRAPPED, proof_hash: hex(proof) });
  let grantId = '';

  it('is made by the owner, for a profile that is theirs, and shows to no one else', async () => {
    expect((await call('POST', '/api/delegations/invites', owner, { id: INVITE_ID, profile_id: 'profile-nope-0000', role: 'guardian', wrapped: WRAPPED, proof_hash: hex(PROOF) })).statusCode).toBe(404);
    expect((await call('POST', '/api/delegations/invites', owner, { id: 'short', profile_id: PROFILE, role: 'guardian', wrapped: WRAPPED, proof_hash: hex(PROOF) })).statusCode).toBe(400);
    expect((await call('POST', '/api/delegations/invites', owner, { id: INVITE_ID, profile_id: PROFILE, role: 'owner', wrapped: WRAPPED, proof_hash: hex(PROOF) })).statusCode).toBe(400);
    expect((await invite()).statusCode).toBe(201);
    expect((await call('GET', '/api/delegations', owner)).json().invites).toHaveLength(1);
    expect((await call('GET', '/api/delegations', guest)).json().invites).toEqual([]);
    // Someone who is not the owner cannot make an invitation for the owner's profile.
    expect((await invite('guardian', 'j'.repeat(43), PROOF, guest)).statusCode).toBe(404);
  });

  it('is spent once, by someone who shows the proof, and not by the owner', async () => {
    expect((await call('POST', '/api/delegations/claim', guest, { id: INVITE_ID, proof: 'q'.repeat(43) })).statusCode).toBe(404);
    expect((await call('POST', '/api/delegations/claim', owner, { id: INVITE_ID, proof: PROOF })).statusCode).toBe(404);
    const claimed = await call('POST', '/api/delegations/claim', guest, { id: INVITE_ID, proof: PROOF });
    expect(claimed.statusCode).toBe(200);
    expect(claimed.json()).toMatchObject({ wrapped: WRAPPED, grant: { profile_id: PROFILE, role: 'guardian', owner_email: 'owner@spine.test' } });
    grantId = claimed.json().grant.id;
    expect((await call('POST', '/api/delegations/claim', guest, { id: INVITE_ID, proof: PROOF })).statusCode).toBe(404);
    await new Promise(r => setTimeout(r, 20));
    expect(mails.some(m => m.to === 'owner@spine.test' && /accepted your invitation/.test(m.text))).toBe(true);
  });

  it('opens nothing until the one let in has sealed the key to their own', async () => {
    expect((await call('GET', `/api/delegated/${grantId}/objects`, guest)).statusCode).toBe(404);
    expect((await call('PUT', `/api/delegations/${grantId}/key`, owner, { wrapped_key: K('d') })).statusCode).toBe(404); // not the owner's to complete
    expect((await call('PUT', `/api/delegations/${grantId}/key`, guest, { wrapped_key: 'short' })).statusCode).toBe(400);
    expect((await call('PUT', `/api/delegations/${grantId}/key`, guest, { wrapped_key: K('d') })).statusCode).toBe(200);
    const seen = (await call('GET', '/api/delegations', guest)).json();
    expect(seen.received).toEqual([{ id: grantId, owner_email: 'owner@spine.test', profile_id: PROFILE, role: 'guardian', state: 'active', wrapped_key: K('d'), others: [] }]);
    expect((await call('GET', '/api/delegations', owner)).json().owned).toMatchObject([{ id: grantId, delegate_email: 'guest@spine.test', role: 'guardian', state: 'active' }]);
  });

  it('shows the delegate the one profile’s objects and nothing of the rest of the vault', async () => {
    const listed = (await call('GET', `/api/delegated/${grantId}/objects`, guest)).json();
    expect(listed.objects.map((o: { id: string }) => o.id).sort()).toEqual(['object-a-0001', PROFILE]);
    expect(listed.usage).toEqual({ objects: 0, bytes: 0 });
    expect((await call('GET', `/api/delegated/${grantId}/objects/object-a-0001`, guest)).rawPayload.toString()).toBe('a record of the profile');
    expect((await call('GET', `/api/delegated/${grantId}/objects/object-b-0001`, guest)).statusCode).toBe(404);
    expect((await call('GET', `/api/delegated/${grantId}/objects/${OTHER_PROFILE}`, guest)).statusCode).toBe(404);
    // Someone else's grant id opens nothing.
    expect((await call('GET', `/api/delegated/${grantId}/objects`, owner)).statusCode).toBe(404);
  });

  it('lets a guardian write into the profile, into the owner’s vault, and not elsewhere', async () => {
    const written = await put(guest, 'object-g-0001', 'bundle', PROFILE, 'written by the guardian', 0, `/api/delegated/${grantId}/objects`);
    expect(written.statusCode).toBe(200);
    expect((await call('GET', '/api/vault/objects/object-g-0001', owner)).rawPayload.toString()).toBe('written by the guardian');
    expect((await put(guest, 'object-g-0002', 'bundle', OTHER_PROFILE, 'into another profile', 0, `/api/delegated/${grantId}/objects`)).statusCode).toBe(403);
    expect((await put(guest, 'object-g-0003', 'profile', PROFILE, 'the profile record', 0, `/api/delegated/${grantId}/objects`)).statusCode).toBe(403);
    expect((await put(guest, 'object-b-0001', 'bundle', PROFILE, 'over another profile’s object', 1, `/api/delegated/${grantId}/objects`)).statusCode).toBe(404);
    const gone = await call('DELETE', `/api/delegated/${grantId}/objects/object-g-0001?base=${written.json().seq}`, guest);
    expect(gone.statusCode).toBe(200);
    expect((await call('DELETE', `/api/delegated/${grantId}/objects/object-b-0001?base=1`, guest)).statusCode).toBe(404);
    expect((await call('DELETE', `/api/delegated/${grantId}/objects/${PROFILE}?base=1`, guest)).statusCode).toBe(404);
  });

  it('is paused and resumed by the owner, and a paused grant opens nothing', async () => {
    expect((await call('POST', `/api/delegations/${grantId}/state`, guest, { state: 'paused' })).statusCode).toBe(404);
    expect((await call('POST', `/api/delegations/${grantId}/state`, owner, { state: 'paused' })).statusCode).toBe(200);
    expect((await call('GET', `/api/delegated/${grantId}/objects`, guest)).statusCode).toBe(404);
    expect((await call('POST', `/api/delegations/${grantId}/state`, owner, { state: 'active' })).statusCode).toBe(200);
    expect((await call('GET', `/api/delegated/${grantId}/objects`, guest)).statusCode).toBe(200);
  });

  it('is read-only for a viewer', async () => {
    await invite('viewer', 'v'.repeat(43), 'r'.repeat(43));
    const viewer = await createTestUser('viewer@spine.test');
    const cookie = await loginAs(app, viewer.email, viewer.password);
    const claimed = (await call('POST', '/api/delegations/claim', cookie, { id: 'v'.repeat(43), proof: 'r'.repeat(43) })).json();
    await call('PUT', `/api/delegations/${claimed.grant.id}/key`, cookie, { wrapped_key: K('e') });
    expect((await call('GET', `/api/delegated/${claimed.grant.id}/objects/object-a-0001`, cookie)).statusCode).toBe(200);
    const refused = await put(cookie, 'object-v-0001', 'bundle', PROFILE, 'no', 0, `/api/delegated/${claimed.grant.id}/objects`);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().code).toBe('read_only');
    expect((await call('DELETE', `/api/delegated/${claimed.grant.id}/objects/object-a-0001?base=2`, cookie)).statusCode).toBe(403);
    await call('DELETE', `/api/delegations/${claimed.grant.id}`, cookie); // and may leave
    expect((await call('GET', `/api/delegated/${claimed.grant.id}/objects`, cookie)).statusCode).toBe(404);
  });

  it('lets the person themselves in as one account, who writes as a guardian does, and no second one', async () => {
    expect((await invite('self', 's'.repeat(43), 'o'.repeat(43))).statusCode).toBe(201);
    const second = await invite('self', 't'.repeat(43), 'o'.repeat(43));
    expect(second.statusCode).toBe(409);
    expect(second.json().code).toBe('self_exists');
    const teen = await createTestUser('teen@spine.test');
    const cookie = await loginAs(app, teen.email, teen.password);
    const claimed = (await call('POST', '/api/delegations/claim', cookie, { id: 's'.repeat(43), proof: 'o'.repeat(43) })).json();
    expect(claimed.grant.role).toBe('self');
    await call('PUT', `/api/delegations/${claimed.grant.id}/key`, cookie, { wrapped_key: K('s') });
    expect((await put(cookie, 'object-t-0001', 'bundle', PROFILE, 'the person’s own note', 0, `/api/delegated/${claimed.grant.id}/objects`)).statusCode).toBe(200);
    expect((await put(cookie, 'object-t-0002', 'profile', PROFILE, 'their own record', 0, `/api/delegated/${claimed.grant.id}/objects`)).statusCode).toBe(403);
    // The person can give the access up themselves.
    expect((await call('DELETE', `/api/delegations/${claimed.grant.id}`, cookie)).statusCode).toBe(200);
    expect((await call('GET', `/api/delegated/${claimed.grant.id}/objects`, cookie)).statusCode).toBe(404);
  });

  describe('promotion at eighteen', () => {
    const promoteBody = (objects: string[], grants: Array<{ id: string }>) => ({ profile_wrapped: K('p'), profile_body: Buffer.from('the profile record, taken over').toString('base64url'), objects: objects.map(id => ({ id, wrapped_key: K('q') })), grants: grants.map(g => ({ id: g.id, wrapped_key: K('r') })) });
    const makeVault = async (email: string) => {
      const u = await createTestUser(email);
      const cookie = await loginAs(app, u.email, u.password);
      await app.inject({ method: 'PUT', url: '/api/vault/keys', headers: { cookie }, payload: { auth_value: fakeAuthValue(), keys: fakeVaultKeys() } });
      return { ...u, cookie };
    };

    it('is the person’s own call, as themselves only, and needs every key named', async () => {
      const child = 'profile-cccc-0003';
      await put(owner, child, 'profile', child, 'a child’s record');
      await put(owner, 'object-c-0001', 'bundle', child, 'a child’s note');
      const guardian = await makeVault('promo-guardian@spine.test');
      const teen = await makeVault('promo-teen@spine.test');
      const invite2 = (role: string, id: string, proof: string) => call('POST', '/api/delegations/invites', owner, { id, profile_id: child, role, wrapped: WRAPPED, proof_hash: hex(proof) });
      const accept = async (who: { cookie: string }, id: string, proof: string) => {
        const g = (await call('POST', '/api/delegations/claim', who.cookie, { id, proof })).json().grant.id as string;
        await call('PUT', `/api/delegations/${g}/key`, who.cookie, { wrapped_key: K('d') });
        return g;
      };
      await invite2('guardian', 'a1'.repeat(21) + 'a', 'a'.repeat(43));
      await invite2('self', 'b1'.repeat(21) + 'b', 'b'.repeat(43));
      const asGuardian = await accept(guardian, 'a1'.repeat(21) + 'a', 'a'.repeat(43));
      const asSelf = await accept(teen, 'b1'.repeat(21) + 'b', 'b'.repeat(43));

      // A guardian cannot take the records, however they ask; and the call needs the whole of what moves.
      expect((await call('POST', `/api/delegations/${asGuardian}/promote`, guardian.cookie, promoteBody(['object-c-0001'], []))).statusCode).toBe(409);
      expect((await call('POST', `/api/delegations/${asSelf}/promote`, guardian.cookie, promoteBody(['object-c-0001'], [{ id: asGuardian }]))).statusCode).toBe(404);
      expect((await call('POST', `/api/delegations/${asSelf}/promote`, teen.cookie, promoteBody([], [{ id: asGuardian }]))).statusCode).toBe(409); // an object left out
      expect((await call('POST', `/api/delegations/${asSelf}/promote`, teen.cookie, promoteBody(['object-c-0001'], []))).statusCode).toBe(409); // a grant left out
      expect((await call('GET', '/api/vault/objects/object-c-0001', owner)).statusCode).toBe(200); // nothing moved

      const moved = await call('POST', `/api/delegations/${asSelf}/promote`, teen.cookie, promoteBody(['object-c-0001'], [{ id: asGuardian }]));
      expect(moved.statusCode).toBe(200);
      // It is the teenager's now, and the old owner's copies are gone.
      expect((await call('GET', '/api/vault/objects/object-c-0001', teen.cookie)).rawPayload.toString()).toBe('a child’s note');
      expect((await call('GET', '/api/vault/objects/object-c-0001', teen.cookie)).headers['x-spine-wrapped-key']).toBe(K('q'));
      expect((await call('GET', `/api/vault/objects/${child}`, teen.cookie)).rawPayload.toString()).toBe('the profile record, taken over');
      expect((await call('GET', '/api/vault/objects/object-c-0001', owner)).statusCode).toBe(404);
      expect((await call('GET', `/api/vault/objects/${child}`, owner)).statusCode).toBe(404);
      // The guardian's grant is the teenager's to resume, paused with the new key; theirs as a self grant is over.
      expect((await call('GET', `/api/delegated/${asGuardian}/objects`, guardian.cookie)).statusCode).toBe(404);
      const held = (await call('GET', '/api/delegations', teen.cookie)).json();
      expect(held.owned).toMatchObject([{ id: asGuardian, delegate_email: 'promo-guardian@spine.test', state: 'paused' }]);
      expect(held.received).toEqual([]);
      expect((await call('GET', '/api/delegations', guardian.cookie)).json().received[0]).toMatchObject({ id: asGuardian, state: 'paused', wrapped_key: K('r') });
      expect((await call('POST', `/api/delegations/${asGuardian}/state`, teen.cookie, { state: 'active' })).statusCode).toBe(200);
      expect((await call('GET', `/api/delegated/${asGuardian}/objects/object-c-0001`, guardian.cookie)).rawPayload.toString()).toBe('a child’s note');
      // The old owner cannot pause or end what is no longer theirs.
      expect((await call('POST', `/api/delegations/${asGuardian}/state`, owner, { state: 'paused' })).statusCode).toBe(404);
      // And it cannot be done twice.
      expect((await call('POST', `/api/delegations/${asSelf}/promote`, teen.cookie, promoteBody(['object-c-0001'], [{ id: asGuardian }]))).statusCode).toBe(409);
    });

    it('is not refused for what a plan holds: a free account takes in a second person, and more than it could store', async () => {
      Object.assign(process.env, { SPINE_BILLING: 'on', PADDLE_ENVIRONMENT: 'sandbox', PADDLE_API_KEY: 'k', PADDLE_WEBHOOK_SECRET: 's', SPINE_CHECKOUT_URL: 'https://pay.example/', SPINE_PADDLE_PRICE_YEAR: 'a', SPINE_PADDLE_PRICE_MONTH: 'b', SPINE_PADDLE_PRICE_FOUNDING: 'c' });
      const family = await makeVault('promo-family@spine.test');
      const free = await createTestUser('promo-free@spine.test', { createdAt: '2020-01-01T00:00:00.000Z' });
      const freeCookie = await loginAs(app, free.email, free.password);
      await app.inject({ method: 'PUT', url: '/api/vault/keys', headers: { cookie: freeCookie }, payload: { auth_value: fakeAuthValue(), keys: fakeVaultKeys() } });
      await put(freeCookie, 'profile-own-0001', 'profile', 'profile-own-0001', 'my own'); // the one person a free plan keeps
      const profile = 'profile-dddd-0004';
      await put(family.cookie, profile, 'profile', profile, 'a teenager’s record');
      await call('POST', '/api/delegations/invites', family.cookie, { id: 'c1'.repeat(21) + 'c', profile_id: profile, role: 'self', wrapped: WRAPPED, proof_hash: hex('c'.repeat(43)) }); // the trial may
      const g = (await call('POST', '/api/delegations/claim', freeCookie, { id: 'c1'.repeat(21) + 'c', proof: 'c'.repeat(43) })).json().grant.id as string;
      await call('PUT', `/api/delegations/${g}/key`, freeCookie, { wrapped_key: K('d') });
      expect((await call('POST', `/api/delegations/${g}/promote`, freeCookie, promoteBody([], []))).statusCode).toBe(200);
      expect((await call('GET', `/api/vault/objects/${profile}`, freeCookie)).statusCode).toBe(200);
    });
  });

  it('ends with a new key for the profile, and the former delegate can reach nothing', async () => {
    const live = (await call('GET', '/api/vault/objects', owner)).json().objects.filter((o: { profile_id: string; kind: string; deleted: boolean }) => o.profile_id === PROFILE && o.kind !== 'profile' && !o.deleted).map((o: { id: string }) => o.id);
    const rotateBody = (objects: string[], grants: string[]) => ({ profile_wrapped: K('n'), profile_body: Buffer.from('new profile record').toString('base64url'), objects: objects.map(id => ({ id, wrapped_key: K('m') })), grants: grants.map(id => ({ id, wrapped_key: K('g') })) });
    // The two grants still held (this one, paused or not) must come with a new key; one left out is refused.
    expect((await call('POST', `/api/vault/profiles/${PROFILE}/rotate`, owner, rotateBody(live, []))).statusCode).toBe(409);

    expect((await call('POST', `/api/delegations/${grantId}/revoke`, guest)).statusCode).toBe(404);
    const ended = await call('POST', `/api/delegations/${grantId}/revoke`, owner);
    expect(ended.json().profile_id).toBe(PROFILE);
    expect((await call('GET', `/api/delegated/${grantId}/objects`, guest)).statusCode).toBe(404);
    expect((await call('GET', '/api/delegations', guest)).json().received).toEqual([]);

    // A key missing for an object of the profile is refused, and changes nothing.
    expect((await call('POST', `/api/vault/profiles/${PROFILE}/rotate`, owner, rotateBody([], []))).statusCode).toBe(409);
    expect((await call('GET', `/api/vault/objects/${PROFILE}`, owner)).rawPayload.toString()).toBe('record of the profile');

    const rotated = await call('POST', `/api/vault/profiles/${PROFILE}/rotate`, owner, rotateBody(live, []));
    expect(rotated.statusCode).toBe(200);
    const profileObject = await call('GET', `/api/vault/objects/${PROFILE}`, owner);
    expect(profileObject.rawPayload.toString()).toBe('new profile record');
    expect(profileObject.headers['x-spine-wrapped-key']).toBe(K('n'));
    for (const id of live) expect((await call('GET', `/api/vault/objects/${id}`, owner)).headers['x-spine-wrapped-key']).toBe(K('m'));
    // The other profile is untouched.
    expect((await call('GET', '/api/vault/objects/object-b-0001', owner)).headers['x-spine-wrapped-key']).toBe(K('k'));
  });

  it('keeps the remaining grants working after a rotation, with the new key each holds', async () => {
    await invite('guardian', 'k'.repeat(43), 'z'.repeat(43));
    const second = await createTestUser('second@spine.test');
    const cookie = await loginAs(app, second.email, second.password);
    const g = (await call('POST', '/api/delegations/claim', cookie, { id: 'k'.repeat(43), proof: 'z'.repeat(43) })).json().grant.id;
    await call('PUT', `/api/delegations/${g}/key`, cookie, { wrapped_key: K('1') });
    const live = (await call('GET', '/api/vault/objects', owner)).json().objects.filter((o: { profile_id: string; kind: string; deleted: boolean }) => o.profile_id === PROFILE && o.kind !== 'profile' && !o.deleted).map((o: { id: string }) => o.id);
    const ok = await call('POST', `/api/vault/profiles/${PROFILE}/rotate`, owner, { profile_wrapped: K('n'), profile_body: Buffer.from('the profile record, again').toString('base64url'), objects: live.map((id: string) => ({ id, wrapped_key: K('m') })), grants: [{ id: g, wrapped_key: K('2') }] });
    expect(ok.statusCode).toBe(200);
    expect((await call('GET', '/api/delegations', cookie)).json().received[0].wrapped_key).toBe(K('2'));
    expect((await call('GET', `/api/delegated/${g}/objects/${PROFILE}`, cookie)).rawPayload.toString()).toBe('the profile record, again');
  });

  it('ends the owner’s other sign-ins when the key is replaced, so no device goes on writing under the old one', async () => {
    const elsewhere = await loginSession(app);
    const live = (await call('GET', '/api/vault/objects', owner)).json().objects.filter((o: { profile_id: string; kind: string; deleted: boolean }) => o.profile_id === PROFILE && o.kind !== 'profile' && !o.deleted).map((o: { id: string }) => o.id);
    const grants = (await call('GET', '/api/delegations', owner)).json().owned.filter((x: { profile_id: string }) => x.profile_id === PROFILE).map((x: { id: string }) => ({ id: x.id, wrapped_key: K('3') }));
    expect((await call('POST', `/api/vault/profiles/${PROFILE}/rotate`, owner, { profile_wrapped: K('n'), profile_body: Buffer.from('the profile record, once more').toString('base64url'), objects: live.map((id: string) => ({ id, wrapped_key: K('m') })), grants })).statusCode).toBe(200);
    expect((await call('GET', '/api/delegations', elsewhere)).statusCode).toBe(401);
    expect((await call('GET', '/api/delegations', owner)).statusCode).toBe(200);
  });

  it('is part of the plan, where there are plans', async () => {
    Object.assign(process.env, { SPINE_BILLING: 'on', PADDLE_ENVIRONMENT: 'sandbox', PADDLE_API_KEY: 'k', PADDLE_WEBHOOK_SECRET: 's', SPINE_CHECKOUT_URL: 'https://pay.example/', SPINE_PADDLE_PRICE_YEAR: 'a', SPINE_PADDLE_PRICE_MONTH: 'b', SPINE_PADDLE_PRICE_FOUNDING: 'c' });
    const free = await createTestUser('free-owner@spine.test', { createdAt: '2020-01-01T00:00:00.000Z' });
    const cookie = await loginAs(app, free.email, free.password);
    await app.inject({ method: 'PUT', url: '/api/vault/keys', headers: { cookie }, payload: { auth_value: fakeAuthValue(), keys: fakeVaultKeys() } });
    await put(cookie, 'profile-free-0001', 'profile', 'profile-free-0001', 'mine');
    const refused = await call('POST', '/api/delegations/invites', cookie, { id: 'f'.repeat(43), profile_id: 'profile-free-0001', role: 'guardian', wrapped: WRAPPED, proof_hash: hex(PROOF) });
    expect(refused.statusCode).toBe(402);
    expect(refused.json().code).toBe('plan_required');
  });

  it('goes with the account: grants and invitations of a deleted account are gone', async () => {
    const store = getAccountsStore();
    await invite('viewer', 'x'.repeat(43), 'y'.repeat(43));
    expect((await store.delegations.invites(OWNER_ID, new Date().toISOString())).length).toBeGreaterThan(0);
    await store.users.delete(guestId);
    expect((await store.delegations.ownedBy(OWNER_ID)).find(g => g.delegate_user_id === guestId)).toBeUndefined();
  });
});

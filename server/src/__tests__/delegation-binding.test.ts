import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { fakeAuthValue, fakeVaultKeys } from 'spine-core/testing/vault.js';
import { buildTestApp, loginAs } from './helpers/app.js';
import { createTestUser } from './helpers/seed.js';

/**
 * SECURITY.md S-39 and S-41. A key the server lists for a person is the server's word, and a key sealed to someone with no sender is anyone's.
 * Each side's key is bound to the other's through the invitation code, which never reaches the server: the delegate's key under the code's key,
 * and the owner's key in what the code opens. The server keeps those sealed and hands them back; it cannot make them.
 */
const K = (c: string, n = 100) => c.repeat(n).slice(0, n);
const hex = (v: string) => createHash('sha256').update(v).digest('hex');
const PROFILE = 'profile-bind-0001';

describe('binding each side’s key through the invitation code', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  const people: Record<string, { id: string; cookie: string }> = {};

  const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, who: string, payload?: unknown) => app.inject({ method, url, headers: { cookie: people[who].cookie }, payload: payload as object | undefined });
  const put = (who: string, id: string, kind: string, text: string) => app.inject({ method: 'PUT', url: `/api/vault/objects/${id}`, headers: { cookie: people[who].cookie, 'content-type': 'application/octet-stream', 'x-spine-kind': kind, 'x-spine-profile': PROFILE, 'x-spine-wrapped-key': K('k'), 'x-spine-base-seq': '0' }, payload: Buffer.from(text) });

  beforeAll(async () => {
    app = await buildTestApp();
    for (const name of ['bind-owner', 'bind-guardian', 'bind-self', 'bind-stranger']) {
      const u = await createTestUser(`${name}@spine.test`, { id: `user-${name}` });
      const cookie = await loginAs(app, u.email, u.password);
      await app.inject({ method: 'PUT', url: '/api/vault/keys', headers: { cookie }, payload: { auth_value: fakeAuthValue(), keys: fakeVaultKeys() } });
      people[name.replace('bind-', '')] = { id: u.id, cookie };
    }
    await put('owner', PROFILE, 'profile', 'the profile record');
    await put('owner', 'object-bind-0001', 'bundle', 'a note');
  });
  afterAll(async () => { await app.close(); });

  const code = (c: string) => c.repeat(43);
  const invite = (c: string, role: string, extra: Record<string, unknown> = {}) => call('POST', '/api/delegations/invites', 'owner', { id: code(c), profile_id: PROFILE, role, wrapped: K('w'), proof_hash: hex(code(c)), ...extra });
  const claim = async (who: string, c: string) => (await call('POST', '/api/delegations/claim', who, { id: code(c), proof: code(c) })).json().grant.id as string;

  it('keeps what a device seals for each side, hands it back to the one it is for, and nothing of it is made here', async () => {
    expect((await invite('a', 'guardian', { owner_blob: K('o', 120) })).statusCode).toBe(201);
    const grant = await claim('guardian', 'a');
    // before the delegate completes, nothing is bound
    expect((await call('GET', '/api/delegations', 'owner')).json().owned.find((g: { id: string }) => g.id === grant)).toMatchObject({ state: 'pending', delegate_hello: null, bound: false });
    expect((await call('PUT', `/api/delegations/${grant}/key`, 'guardian', { wrapped_key: K('d'), hello: K('h', 110), owner_pin: K('p', 110) })).statusCode).toBe(200);

    const owned = (await call('GET', '/api/delegations', 'owner')).json().owned.find((g: { id: string }) => g.id === grant);
    expect(owned).toMatchObject({ delegate_hello: K('h', 110), owner_blob: K('o', 120), delegate_pin: null, bound: true });
    const received = (await call('GET', '/api/delegations', 'guardian')).json().received.find((g: { id: string }) => g.id === grant);
    expect(received).toMatchObject({ owner_pin: K('p', 110), delegate_pinned: false });

    // the owner's device pins the key it verified; only the owner can
    expect((await call('PUT', `/api/delegations/${grant}/pin`, 'owner', { pin: K('n', 110) })).statusCode).toBe(200);
    expect((await call('PUT', `/api/delegations/${grant}/pin`, 'guardian', { pin: K('x', 110) })).statusCode).toBe(404);
    expect((await call('PUT', `/api/delegations/${grant}/pin`, 'stranger', { pin: K('x', 110) })).statusCode).toBe(404);
    expect((await call('PUT', `/api/delegations/${grant}/pin`, 'owner', { pin: 'short' })).statusCode).toBe(400);
    expect((await call('GET', '/api/delegations', 'owner')).json().owned.find((g: { id: string }) => g.id === grant)).toMatchObject({ delegate_pin: K('n', 110) });
    expect((await call('GET', '/api/delegations', 'guardian')).json().received.find((g: { id: string }) => g.id === grant)).toMatchObject({ delegate_pinned: true });
    // nobody else sees any of it
    expect(JSON.stringify((await call('GET', '/api/delegations', 'stranger')).json())).not.toContain(K('h', 110));
  });

  it('takes the hello and the pin of the owner’s key together, in the shape a device seals, or not at all', async () => {
    await invite('b', 'viewer', { owner_blob: K('o', 120) });
    const grant = await claim('guardian', 'b');
    for (const body of [{ hello: K('h', 110) }, { owner_pin: K('p', 110) }, { hello: 'short', owner_pin: K('p', 110) }, { hello: K('h', 110), owner_pin: 'not sealed!' }]) {
      expect((await call('PUT', `/api/delegations/${grant}/key`, 'guardian', { wrapped_key: K('d'), ...body })).statusCode, JSON.stringify(body)).toBe(400);
    }
    expect((await call('PUT', `/api/delegations/${grant}/key`, 'guardian', { wrapped_key: K('d'), hello: K('h', 110), owner_pin: K('p', 110) })).statusCode).toBe(200);
    expect((await invite('c', 'viewer', { owner_blob: 'not sealed!' })).statusCode).toBe(400);
  });

  it('leaves a grant from a device that does not bind keys unbound, and says so', async () => {
    await invite('d', 'viewer');
    const grant = await claim('guardian', 'd');
    await call('PUT', `/api/delegations/${grant}/key`, 'guardian', { wrapped_key: K('d') });
    const owned = (await call('GET', '/api/delegations', 'owner')).json().owned.find((g: { id: string }) => g.id === grant);
    expect(owned).toMatchObject({ delegate_hello: null, owner_blob: null, delegate_pin: null, bound: false });
  });

  describe('promotion at eighteen', () => {
    const promote = (who: string, grantId: string, grants: Array<{ id: string; wrapped_key: string | null }>) => call('POST', `/api/delegations/${grantId}/promote`, who, {
      profile_wrapped: K('p', 100), profile_body: Buffer.from('the profile record, taken over').toString('base64url'),
      objects: [{ id: 'object-bind-0001', wrapped_key: K('q') }], grants, former_wrapped_key: K('f'),
    });

    it('ends the grants of the others, whose keys the new owner has no way to know, and hands each side the pin of the other', async () => {
      await invite('e', 'guardian', { owner_blob: K('o', 120) });
      await invite('f', 'self', { owner_blob: K('o', 120) });
      const other = await claim('guardian', 'e');
      await call('PUT', `/api/delegations/${other}/key`, 'guardian', { wrapped_key: K('d'), hello: K('h', 110), owner_pin: K('p', 110) });
      const asSelf = await claim('self', 'f');
      await call('PUT', `/api/delegations/${asSelf}/key`, 'self', { wrapped_key: K('s'), hello: K('i', 110), owner_pin: K('m', 110) });
      // the old owner pinned the person's key
      await call('PUT', `/api/delegations/${asSelf}/pin`, 'owner', { pin: K('n', 110) });

      // every other grant of the profile must be named; a key is given for none, so each ends
      const others = (await call('GET', '/api/delegations', 'self')).json().received.find((g: { id: string }) => g.id === asSelf).others as Array<{ id: string }>;
      expect(others.length).toBeGreaterThan(0);
      const done = await promote('self', asSelf, others.map(o => ({ id: o.id, wrapped_key: null })));
      expect(done.statusCode).toBe(200);

      // the others' access is over, and they are the new owner's to see no more than as ended
      for (const o of others) {
        const owned = (await call('GET', '/api/delegations', 'self')).json().owned as Array<{ id: string }>;
        expect(owned.map(g => g.id), o.id).not.toContain(o.id);
      }
      expect((await call('GET', `/api/delegated/${other}/objects`, 'guardian')).statusCode).toBe(404);
      expect((await call('GET', '/api/delegations', 'guardian')).json().received.find((g: { id: string }) => g.id === other)).toBeUndefined();

      // the former owner's new grant holds the pins of the old one with each side's swapped
      const former = (await call('GET', '/api/delegations', 'owner')).json().received.find((g: { profile_id: string }) => g.profile_id === PROFILE);
      expect(former).toMatchObject({ role: 'guardian', state: 'paused', owner_pin: K('n', 110), delegate_pinned: true });
      const theirs = (await call('GET', '/api/delegations', 'self')).json().owned.find((g: { id: string }) => g.id === former.id);
      expect(theirs).toMatchObject({ delegate_pin: K('m', 110), bound: true });
    });
  });
});

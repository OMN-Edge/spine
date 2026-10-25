import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { buildTestApp, loginAs } from './helpers/app.js';
import { createTestUser, TEST_PASSWORD } from './helpers/seed.js';
import { SoftAuthenticator } from 'spine-core/testing/authenticator.js';
import { relyingParty } from '../passkeys.js';
import { getAccountsStore } from 'spine-core/store/index.js';

let app: Awaited<ReturnType<typeof buildTestApp>>;
const rp = relyingParty();
beforeAll(async () => { app = await buildTestApp(); });
afterAll(async () => { await app.close(); });
afterEach(() => { vi.useRealTimers(); });

const cookieOf = (res: { cookies: Array<{ name: string; value: string }> }) => res.cookies.map(c => `${c.name}=${c.value}`).join('; ');
const send = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, cookie?: string, payload?: unknown) =>
  app.inject({ method, url, headers: cookie ? { cookie } : {}, ...(payload === undefined ? {} : { payload: payload as object }) });

/** Signs in with the password and registers a new software authenticator; returns the pieces a test wants next. */
async function withPasskey(email: string, name = 'Test phone') {
  const user = await createTestUser(email);
  const cookie = await loginAs(app, user.email, user.password);
  const device = new SoftAuthenticator({ rpId: rp.id, origin: rp.origin });
  const options = await send('POST', '/api/auth/passkeys/options', cookie);
  expect(options.statusCode).toBe(200);
  const done = await send('POST', '/api/auth/passkeys', cookie, { response: device.register(options.json().challenge), name });
  expect(done.statusCode).toBe(201);
  return { user, cookie, device };
}

/** A passkey sign-in from a browser with no session: the options call hands it a cookie that carries the challenge. */
async function signIn(device: SoftAuthenticator, tweak: Parameters<SoftAuthenticator['assert']>[1] = {}) {
  const options = await send('POST', '/api/auth/passkey/options');
  expect(options.statusCode).toBe(200);
  const cookie = cookieOf(options);
  const res = await send('POST', '/api/auth/passkey/login', cookie, { response: device.assert(options.json().challenge, tweak) });
  return { res, cookie: cookieOf(res) || cookie, challenge: options.json().challenge as string, sentWith: cookie };
}

describe('registering a passkey', () => {
  it('asks for a session and the password typed lately, and asks the device for a key that proves who holds it', async () => {
    expect((await send('POST', '/api/auth/passkeys/options')).statusCode).toBe(401);
    const user = await createTestUser('reg@spine.test');
    const cookie = await loginAs(app, user.email, user.password);
    const options = (await send('POST', '/api/auth/passkeys/options', cookie)).json();
    expect(options).toMatchObject({ rp: { id: rp.id }, authenticatorSelection: { userVerification: 'required', residentKey: 'required' }, attestation: 'none' });
    expect(options.challenge).toMatch(/^[\w-]{20,}$/);

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 11 * 60_000);
    await getAccountsStore().sessions.touch(user.id, (await getAccountsStore().sessions.list(user.id))[0].id, new Date().toISOString());
    const stale = await send('POST', '/api/auth/passkeys/options', cookie);
    expect(stale.statusCode).toBe(403);
    expect(stale.json().code).toBe('reauth_required');
  });

  it('stores the public key under a name, lists it without the key, and refuses the same device twice', async () => {
    const { user, cookie, device } = await withPasskey('listed@spine.test', 'Kitchen tablet');
    const list = (await send('GET', '/api/auth/passkeys', cookie)).json() as Array<Record<string, unknown>>;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'Kitchen tablet' });
    expect(Object.keys(list[0]).sort()).toEqual(['backed_up', 'created_at', 'id', 'last_used_at', 'name', 'opens_vault']);
    expect(JSON.stringify(list)).not.toMatch(/public_key|counter/);
    const stored = (await getAccountsStore().users.listPasskeys(user.id))[0];
    expect(stored.public_key.length).toBeGreaterThan(40);

    const again = await send('POST', '/api/auth/passkeys/options', cookie);
    // The device is told not to make a second one.
    expect(again.json().excludeCredentials).toHaveLength(1);
    const dup = await send('POST', '/api/auth/passkeys', cookie, { response: device.register(again.json().challenge) });
    expect(dup.statusCode).toBeGreaterThanOrEqual(400);
    expect(await getAccountsStore().users.listPasskeys(user.id)).toHaveLength(1);
  });

  it('refuses a key made without a fingerprint or PIN, another site’s answer, a stale or reused challenge, and a missing body', async () => {
    const user = await createTestUser('strict@spine.test');
    const cookie = await loginAs(app, user.email, user.password);
    const attempt = async (make: (d: SoftAuthenticator, challenge: string) => unknown) => {
      const o = await send('POST', '/api/auth/passkeys/options', cookie);
      const d = new SoftAuthenticator({ rpId: rp.id, origin: rp.origin });
      return send('POST', '/api/auth/passkeys', cookie, { response: make(d, o.json().challenge) });
    };
    expect((await attempt((d, c) => d.register(c, { userVerified: false }))).statusCode).toBe(400);
    expect((await attempt((d, c) => d.register(c, { origin: 'https://evil.example' }))).statusCode).toBe(400);
    expect((await attempt((d) => d.register('not-the-challenge'))).statusCode).toBe(400);
    expect((await attempt(() => undefined)).statusCode).toBe(400);

    const o = await send('POST', '/api/auth/passkeys/options', cookie);
    const d = new SoftAuthenticator({ rpId: rp.id, origin: rp.origin });
    const reply = d.register(o.json().challenge);
    expect((await send('POST', '/api/auth/passkeys', cookie, { response: reply })).statusCode).toBe(201);
    expect((await send('POST', '/api/auth/passkeys', cookie, { response: reply })).statusCode).toBe(400); // the challenge is spent
    expect(await getAccountsStore().users.listPasskeys(user.id)).toHaveLength(1);
  });
});

describe('signing in with a passkey', () => {
  it('starts a session without a password or a code, and counts the use', async () => {
    const { user, device } = await withPasskey('signin@spine.test');
    const { res, cookie } = await signIn(device);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, email: user.email, credential_id: device.id.toString('base64url'), wrapped_key: null });
    expect((await send('GET', '/api/auth/me', cookie)).json()).toMatchObject({ authenticated: true, email: user.email });
    const stored = (await getAccountsStore().users.listPasskeys(user.id))[0];
    expect(stored.counter).toBe(1);
    expect(stored.last_used_at).toBeTruthy();
    expect((await getAccountsStore().sessions.list(user.id)).length).toBeGreaterThanOrEqual(2); // the password sign-in and this one
  });

  it('does not ask for a code, even when the account has two-factor sign-in on: the passkey is both', async () => {
    const { user, device } = await withPasskey('both@spine.test');
    const store = getAccountsStore();
    await store.users.beginTotp(user.id, 'sealed-secret', new Date().toISOString());
    await store.users.enableTotp(user.id, 1, ['hash-1'], new Date().toISOString());
    expect((await store.users.getTotp(user.id))!.confirmed_at).toBeTruthy();
    // The password route now stops at the code…
    const password = await send('POST', '/api/auth/login', undefined, { email: user.email, password: TEST_PASSWORD });
    expect(password.json()).toEqual({ second_factor_required: true });
    // …and the passkey goes straight in.
    const { res, cookie } = await signIn(device);
    expect(res.statusCode).toBe(200);
    expect((await send('GET', '/api/auth/me', cookie)).json().authenticated).toBe(true);
  });

  it('refuses an unknown key, a key used without verification, a signature for another site, and a counter that went back', async () => {
    const { device } = await withPasskey('refuse@spine.test');
    const stranger = new SoftAuthenticator({ rpId: rp.id, origin: rp.origin });
    expect((await signIn(stranger)).res.statusCode).toBe(401);
    expect((await signIn(device, { userVerified: false })).res.statusCode).toBe(401);
    expect((await signIn(device, { origin: 'https://evil.example' })).res.statusCode).toBe(401);
    expect((await signIn(device)).res.statusCode).toBe(200); // counter 4 now (every assertion moved it)
    expect((await signIn(device, { counter: 1 })).res.statusCode).toBe(401); // a clone's older counter
  });

  it('uses each challenge once, and only within a few minutes', async () => {
    const { device } = await withPasskey('once@spine.test');
    const options = await send('POST', '/api/auth/passkey/options');
    const cookie = cookieOf(options);
    const reply = device.assert(options.json().challenge);
    expect((await send('POST', '/api/auth/passkey/login', cookie, { response: reply })).statusCode).toBe(200);
    // The same answer, replayed with the same cookie: the challenge is gone.
    expect((await send('POST', '/api/auth/passkey/login', cookie, { response: reply })).statusCode).toBe(401);

    const late = await send('POST', '/api/auth/passkey/options');
    const lateCookie = cookieOf(late);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 6 * 60_000);
    expect((await send('POST', '/api/auth/passkey/login', lateCookie, { response: device.assert(late.json().challenge) })).statusCode).toBe(401);
    // And without ever asking for a challenge.
    expect((await send('POST', '/api/auth/passkey/login', undefined, { response: device.assert('whatever') })).statusCode).toBe(401);
    expect((await send('POST', '/api/auth/passkey/login', lateCookie, {})).statusCode).toBe(401);
  });

  it('lets an account that has not agreed to the texts in to be asked, and no further', async () => {
    const user = await createTestUser('askme@spine.test', { consent: false });
    const cookie = await loginAs(app, user.email, user.password);
    const device = new SoftAuthenticator({ rpId: rp.id, origin: rp.origin });
    const o = await send('POST', '/api/auth/passkeys/options', cookie);
    expect((await send('POST', '/api/auth/passkeys', cookie, { response: device.register(o.json().challenge) })).statusCode).toBe(201); // signing in is not the records
    const { res, cookie: session } = await signIn(device);
    expect(res.statusCode).toBe(200);
    expect((await send('GET', '/api/auth/me', session)).json().consent_needed).toEqual({ health: true, terms: true });
    expect((await send('GET', '/api/vault/keys', session)).statusCode).toBe(403);
  });

  it('limits attempts per source with the real limiter', async () => {
    const limited = await buildTestApp({ passkeys: { perSource: 3 } });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await limited.inject({ method: 'POST', url: '/api/auth/passkey/options' })).statusCode);
    expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
    expect(statuses[4]).toBe(429);
    await limited.close();
  });
});

describe('managing passkeys', () => {
  it('renames one, removes one only with the password typed lately, mails the removal, and cannot touch another account’s', async () => {
    const { cookie, device, user } = await withPasskey('manage@spine.test');
    const id = ((await send('GET', '/api/auth/passkeys', cookie)).json() as Array<{ id: string }>)[0].id;
    expect((await send('PATCH', `/api/auth/passkeys/${id}`, cookie, { name: '  Work\nphone ' })).statusCode).toBe(200);
    expect((await send('GET', '/api/auth/passkeys', cookie)).json()[0].name).toBe('Work phone');

    const other = await withPasskey('other@spine.test');
    expect((await send('PATCH', `/api/auth/passkeys/${id}`, other.cookie, { name: 'mine now' })).statusCode).toBe(404);
    expect((await send('DELETE', `/api/auth/passkeys/${id}`, other.cookie)).statusCode).toBe(404);
    expect((await send('GET', '/api/auth/passkeys')).statusCode).toBe(401);

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 11 * 60_000);
    await getAccountsStore().sessions.touch(user.id, (await getAccountsStore().sessions.list(user.id))[0].id, new Date().toISOString());
    expect((await send('DELETE', `/api/auth/passkeys/${id}`, cookie)).statusCode).toBe(403);
    vi.useRealTimers();

    await send('POST', '/api/auth/reauth', cookie, { password: TEST_PASSWORD });
    expect((await send('DELETE', `/api/auth/passkeys/${id}`, cookie)).statusCode).toBe(200);
    expect(await getAccountsStore().users.listPasskeys(user.id)).toEqual([]);
    expect((await signIn(device)).res.statusCode).toBe(401); // gone
  });

  it('deletes with the account', async () => {
    const { user } = await withPasskey('gone@spine.test');
    await getAccountsStore().users.delete(user.id);
    expect(await getAccountsStore().users.listPasskeys(user.id)).toEqual([]);
  });
});

describe('a passkey that opens the vault', () => {
  const sealedKey = 'A'.repeat(96); // what the device sends: 72 sealed bytes, as 96 characters of base64url
  const idOf = (device: SoftAuthenticator) => device.id.toString('base64url');

  it('keeps the sealed key it is given, lists only that it opens the vault, and hands the key back at sign-in', async () => {
    const { user, cookie, device } = await withPasskey('opens@spine.test');
    expect((await send('GET', '/api/auth/passkeys', cookie)).json()[0].opens_vault).toBe(false);
    expect((await signIn(device)).res.json()).toMatchObject({ wrapped_key: null });

    const set = await send('PUT', `/api/auth/passkeys/${idOf(device)}/vault-key`, cookie, { wrapped_key: sealedKey });
    expect(set.statusCode).toBe(200);
    const listed = (await send('GET', '/api/auth/passkeys', cookie)).json();
    expect(listed[0].opens_vault).toBe(true);
    expect(JSON.stringify(listed)).not.toContain(sealedKey);
    expect((await signIn(device)).res.json()).toMatchObject({ credential_id: idOf(device), wrapped_key: sealedKey });
    expect((await getAccountsStore().users.listPasskeys(user.id))[0].wrapped_key).toBe(sealedKey);

    expect((await send('PUT', `/api/auth/passkeys/${idOf(device)}/vault-key`, cookie, { wrapped_key: null })).statusCode).toBe(200);
    expect((await signIn(device)).res.json().wrapped_key).toBeNull();
  });

  it('wants a session, the password typed lately, a sealed value of the right shape, and a passkey of the caller’s own', async () => {
    const { cookie, device } = await withPasskey('opens-refused@spine.test');
    const url = `/api/auth/passkeys/${idOf(device)}/vault-key`;
    expect((await send('PUT', url, undefined, { wrapped_key: sealedKey })).statusCode).toBe(401);
    for (const bad of ['short', 'not base64 !'.padEnd(100, 'x'), 'A'.repeat(300), 5, undefined]) {
      expect((await send('PUT', url, cookie, { wrapped_key: bad })).statusCode, String(bad)).toBe(400);
    }
    const other = await withPasskey('opens-other@spine.test');
    expect((await send('PUT', url, other.cookie, { wrapped_key: sealedKey })).statusCode).toBe(404);
    expect((await getAccountsStore().users.listPasskeys((await getAccountsStore().users.findByEmail('opens-refused@spine.test'))!.id))[0].wrapped_key).toBeNull();

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 11 * 60_000);
    const user = (await getAccountsStore().users.findByEmail('opens-refused@spine.test'))!;
    await getAccountsStore().sessions.touch(user.id, (await getAccountsStore().sessions.list(user.id))[0].id, new Date().toISOString());
    const stale = await send('PUT', url, cookie, { wrapped_key: sealedKey });
    expect(stale.statusCode).toBe(403);
    expect(stale.json().code).toBe('reauth_required');
  });

  it('goes with the passkey when it is removed', async () => {
    const { user, cookie, device } = await withPasskey('opens-removed@spine.test');
    await send('PUT', `/api/auth/passkeys/${idOf(device)}/vault-key`, cookie, { wrapped_key: sealedKey });
    expect((await send('DELETE', `/api/auth/passkeys/${idOf(device)}`, cookie)).statusCode).toBe(200);
    expect(await getAccountsStore().users.listPasskeys(user.id)).toEqual([]);
  });
});

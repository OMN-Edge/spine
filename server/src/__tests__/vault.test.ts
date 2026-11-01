import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { buildTestApp, loginAs } from './helpers/app.js';
import { OWNER_EMAIL, OWNER_ID, createTestUser } from './helpers/seed.js';
import { fakeAuthValue, fakeVaultKeys } from 'spine-core/testing/vault.js';
import { getAccountsStore } from 'spine-core/store/index.js';
import { issueUserToken } from '../accounts.js';
import { resolveDataDir } from 'spine-core/config.js';

/** Where the object store, being files here, puts an account's objects. */
const vaultDirOf = (userId: string) => `${resolveDataDir()}/vault/${userId}`;
import { deleteAccount } from '../accounts.js';
import { resetMailer, type Mailer } from '../mail/index.js';
import { resolveBackupDir } from 'spine-core/config.js';

/**
 * SECURITY.md M-34: the vault. The server keeps keys it cannot open and objects it cannot read; it checks shapes, owners and sequence
 * numbers. Nothing here sends a password, and no test inspects a plaintext.
 */
let app: Awaited<ReturnType<typeof buildTestApp>>;
let cookie: string;

const fakeMailer: Mailer = { enabled: true, async send() {} };

beforeEach(async () => {
  resetMailer(fakeMailer);
  process.env.SPINE_VAULT_MAX_MB = '1';
  app = await buildTestApp({ accounts: { registration: 'open' } });
  cookie = await loginAs(app);
});
afterEach(async () => {
  delete process.env.SPINE_VAULT_MAX_MB;
  await app.close();
  resetMailer(null);
});

const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown, headers: Record<string, string> = {}, who = cookie) =>
  app.inject({ method, url, payload: payload as object, headers: { cookie: who, ...headers } });

const setUp = () => call('PUT', '/api/vault/keys', { auth_value: fakeAuthValue(), keys: fakeVaultKeys() });
const KEY = fakeVaultKeys().wrapped_by_master; // any 96 characters of base64url
const PROFILE = 'profile-0001';
const objectHeaders = (kind = 'bundle', base = 0) => ({
  'content-type': 'application/octet-stream',
  'x-spine-kind': kind,
  'x-spine-profile': PROFILE,
  'x-spine-wrapped-key': KEY,
  'x-spine-base-seq': String(base),
});
const put = (id: string, bytes: Buffer, base = 0, kind = 'bundle', who = cookie) => app.inject({ method: 'PUT', url: `/api/vault/objects/${id}`, payload: bytes, headers: { cookie: who, ...objectHeaders(kind, base) } });

describe('POST /api/auth/kdf', () => {
  it('gives the same pretend salt for an unknown address every time, shaped like a real one', async () => {
    const ask = (email: string) => app.inject({ method: 'POST', url: '/api/auth/kdf', payload: { email } });
    const a = (await ask('nobody@example.com')).json();
    const b = (await ask('NOBODY@example.com')).json();
    expect(a).toEqual(b);
    expect(a).toMatchObject({ vault: true, params: { alg: 'argon2id13' } });
    expect(a.salt).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect((await ask('someone-else@example.com')).json().salt).not.toBe(a.salt);
  });

  it('says an account without a vault has none, and gives the real salt once it has one', async () => {
    const ask = () => app.inject({ method: 'POST', url: '/api/auth/kdf', payload: { email: OWNER_EMAIL } });
    expect((await ask()).json()).toEqual({ vault: false });
    const keys = fakeVaultKeys();
    expect((await call('PUT', '/api/vault/keys', { auth_value: fakeAuthValue(), keys })).statusCode).toBe(200);
    expect((await ask()).json()).toEqual({ vault: true, salt: keys.kdf_salt, params: keys.kdf_params });
  });

  it('needs an address', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/auth/kdf', payload: {} })).statusCode).toBe(400);
  });
});

describe('signing up with a vault', () => {
  const consent = { consent_health_data: true, accept_terms: true };

  it('keeps the keys and takes the derived value as the credential, with no password policy on it', async () => {
    const auth_value = fakeAuthValue();
    const keys = fakeVaultKeys();
    const res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'new@example.com', auth_value, keys, ...consent } });
    expect(res.statusCode).toBe(200);
    const user = await getAccountsStore().users.findByEmail('new@example.com');
    expect(user).not.toBeNull();
    expect((await getAccountsStore().vault.getKeys(user!.id))?.wrapped_by_recovery).toBe(keys.wrapped_by_recovery);
    // The value stands in for the password at sign-in once the address is confirmed.
    await getAccountsStore().users.markVerified(user!.id, new Date().toISOString());
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'new@example.com', password: auth_value } });
    expect(login.statusCode).toBe(200);
  });

  it('refuses keys that are not in the expected form, and a weak Argon2id cost', async () => {
    const bad = [
      { ...fakeVaultKeys(), kdf_salt: 'short' },
      { ...fakeVaultKeys(), wrapped_by_master: 'not base64url!' },
      { ...fakeVaultKeys(), kdf_params: { alg: 'argon2id13', ops: 1, memKiB: 65536 } },
      { ...fakeVaultKeys(), kdf_params: { alg: 'argon2id13', ops: 3, memKiB: 1024 } },
      { ...fakeVaultKeys(), kdf_params: { alg: 'md5', ops: 3, memKiB: 65536 } },
    ];
    for (const keys of bad) {
      const res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'x@example.com', auth_value: fakeAuthValue(), keys, ...consent } });
      expect(res.statusCode).toBe(400);
    }
    const shortValue = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'x@example.com', auth_value: 'abc', keys: fakeVaultKeys(), ...consent } });
    expect(shortValue.statusCode).toBe(400);
    expect(await getAccountsStore().users.findByEmail('x@example.com')).toBeNull();
  });
});

describe('the keys', () => {
  it('404s before a vault exists, then stores and returns them', async () => {
    expect((await call('GET', '/api/vault/keys')).json()).toMatchObject({ code: 'no_vault' });
    const keys = fakeVaultKeys();
    const auth_value = fakeAuthValue();
    expect((await call('PUT', '/api/vault/keys', { auth_value, keys })).statusCode).toBe(200);
    expect((await call('GET', '/api/vault/keys')).json()).toMatchObject({ wrapped_by_master: keys.wrapped_by_master, public_key: keys.public_key, seq: 0 });
  });

  it('makes the derived value the account credential, keeps this sign-in and ends the others', async () => {
    const other = await loginAs(app);
    const auth_value = fakeAuthValue();
    expect((await call('PUT', '/api/vault/keys', { auth_value, keys: fakeVaultKeys() })).statusCode).toBe(200);
    expect((await call('GET', '/api/vault/keys')).statusCode).toBe(200);
    expect((await call('GET', '/api/vault/keys', undefined, {}, other)).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: OWNER_EMAIL, password: auth_value } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: OWNER_EMAIL, password: 'a-long-test-password' } })).statusCode).toBe(401);
  });

  it('is made once; changing it is a rewrap', async () => {
    expect((await setUp()).statusCode).toBe(200);
    expect((await setUp()).statusCode).toBe(409);
    const next = fakeVaultKeys();
    expect((await call('POST', '/api/vault/keys/rewrap', { keys: next })).statusCode).toBe(200);
    expect((await call('GET', '/api/vault/keys')).json()).toMatchObject({ wrapped_by_recovery: next.wrapped_by_recovery });
  });

  it('rewrap is refused for an account with no vault, and bad keys', async () => {
    expect((await call('POST', '/api/vault/keys/rewrap', { keys: fakeVaultKeys() })).statusCode).toBe(404);
    await setUp();
    expect((await call('POST', '/api/vault/keys/rewrap', { keys: { ...fakeVaultKeys(), public_key: 'x' } })).statusCode).toBe(400);
  });
});

describe('objects', () => {
  beforeEach(async () => { await setUp(); });

  it('stores bytes as they come and gives them back with their headers', async () => {
    const bytes = Buffer.from([1, 2, 3, 4, 250, 251]);
    const saved = await put('object-0001', bytes);
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({ seq: 1 });
    const got = await call('GET', '/api/vault/objects/object-0001');
    expect(Buffer.from(got.rawPayload)).toEqual(bytes);
    expect(got.headers).toMatchObject({ 'x-spine-seq': '1', 'x-spine-kind': 'bundle', 'x-spine-profile': PROFILE, 'x-spine-wrapped-key': KEY, 'cache-control': 'no-store' });
  });

  it('numbers changes per account and lists what changed since', async () => {
    await put('object-0001', Buffer.from('a'));
    await put('object-0002', Buffer.from('bb'), 0, 'blob');
    const all = (await call('GET', '/api/vault/objects')).json();
    expect(all.seq).toBe(2);
    expect(all.usage).toEqual({ objects: 2, bytes: 3 });
    expect(all.objects.map((o: { id: string; seq: number }) => [o.id, o.seq])).toEqual([['object-0001', 1], ['object-0002', 2]]);
    expect((await call('GET', '/api/vault/objects?since=1')).json().objects.map((o: { id: string }) => o.id)).toEqual(['object-0002']);
    expect((await call('GET', '/api/vault/objects?since=x')).statusCode).toBe(400);
  });

  it('refuses a write made on an old copy, and a new object that claims to have a history', async () => {
    await put('object-0001', Buffer.from('a'));
    expect((await put('object-0001', Buffer.from('b'), 0)).statusCode).toBe(409);
    expect((await put('object-0001', Buffer.from('b'), 1)).json()).toEqual({ seq: 2 });
    expect((await put('object-0009', Buffer.from('c'), 5)).statusCode).toBe(409);
  });

  it('leaves a tombstone, removes the bytes, and lets another device learn of it', async () => {
    await put('object-0001', Buffer.from('a'));
    expect((await call('DELETE', '/api/vault/objects/object-0001?base=9')).statusCode).toBe(409);
    expect((await call('DELETE', '/api/vault/objects/object-0001?base=1')).json()).toEqual({ seq: 2 });
    expect((await call('GET', '/api/vault/objects/object-0001')).statusCode).toBe(404);
    expect(fs.existsSync(`${vaultDirOf(OWNER_ID)}/object-0001`)).toBe(false);
    const listed = (await call('GET', '/api/vault/objects?since=1')).json();
    expect(listed.objects).toMatchObject([{ id: 'object-0001', deleted: true }]);
    expect(listed.usage.bytes).toBe(0);
    expect((await call('DELETE', '/api/vault/objects/object-0001?base=2')).statusCode).toBe(409);
  });

  it('holds an account to its allowance and counts a replaced object at its new size only', async () => {
    const big = Buffer.alloc(700 * 1024, 7);
    expect((await put('object-0001', big)).statusCode).toBe(200);
    expect((await put('object-0002', big)).statusCode).toBe(413);
    expect((await put('object-0001', big, 1)).statusCode).toBe(200);
  });

  it('checks what it is sent', async () => {
    const bytes = Buffer.from('x');
    expect((await put('../../etc/passwd', bytes)).statusCode).toBe(404);
    expect((await put('short', bytes)).statusCode).toBe(400);
    expect((await put('object-0001', bytes, 0, 'secrets')).statusCode).toBe(400);
    expect((await put('object-0001', Buffer.alloc(0))).statusCode).toBe(400);
    const noKey = await app.inject({ method: 'PUT', url: '/api/vault/objects/object-0001', payload: bytes, headers: { cookie, ...objectHeaders(), 'x-spine-wrapped-key': 'short' } });
    expect(noKey.statusCode).toBe(400);
    expect((await call('GET', '/api/vault/objects/..%2F..%2Fx')).statusCode).toBe(404);
  });

  it('is the owner\'s alone', async () => {
    await put('object-0001', Buffer.from('mine'));
    const other = await createTestUser('other@spine.test');
    const theirs = await loginAs(app, other.email, other.password);
    expect((await call('GET', '/api/vault/objects/object-0001', undefined, {}, theirs)).statusCode).toBe(404);
    expect((await call('GET', '/api/vault/objects', undefined, {}, theirs)).json().objects).toEqual([]);
    expect((await call('DELETE', '/api/vault/objects/object-0001?base=1', undefined, {}, theirs)).statusCode).toBe(409);
    expect((await put('object-0001', Buffer.from('theirs'), 0, 'bundle', theirs)).statusCode).toBe(404); // they have no vault
    expect(Buffer.from((await call('GET', '/api/vault/objects/object-0001')).rawPayload).toString()).toBe('mine');
  });

  it('is not served without a sign-in', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/vault/objects' });
    expect(res.statusCode).toBe(401);
  });

  it('is removed with the account', async () => {
    await put('object-0001', Buffer.from('a'));
    expect(fs.existsSync(vaultDirOf(OWNER_ID))).toBe(true);
    await deleteAccount(OWNER_ID);
    expect(fs.existsSync(vaultDirOf(OWNER_ID))).toBe(false);
    expect(await getAccountsStore().vault.getKeys(OWNER_ID)).toBeNull();
  });

  it('is removed from the backup mirror too, so deleting the account destroys every copy of its ciphertext', async () => {
    const mirrored = path.join(resolveBackupDir(), 'vault', OWNER_ID);
    fs.mkdirSync(mirrored, { recursive: true });
    fs.writeFileSync(path.join(mirrored, 'object-0001'), 'sealed');
    await deleteAccount(OWNER_ID);
    expect(fs.existsSync(mirrored)).toBe(false);
  });
});

describe('a reset with a vault', () => {
  const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, payload: payload as object });

  it('hands the recovery-wrapped key to a link holder without spending the link', async () => {
    const keys = fakeVaultKeys();
    await call('PUT', '/api/vault/keys', { auth_value: fakeAuthValue(), keys });
    const token = await issueUserToken(OWNER_ID, 'reset', 60_000);
    const first = (await post('/api/auth/reset/keys', { token })).json();
    expect(first).toMatchObject({ vault: true, wrapped_by_recovery: keys.wrapped_by_recovery, public_key: keys.public_key });
    expect(first).not.toHaveProperty('wrapped_by_master');
    expect((await post('/api/auth/reset/keys', { token })).statusCode).toBe(200);
    expect((await post('/api/auth/reset/keys', { token: 'x'.repeat(43) })).statusCode).toBe(400);
  });

  it('re-wraps the same account key under a new master key and keeps the objects', async () => {
    await setUp();
    await put('object-0001', Buffer.from('a'));
    const token = await issueUserToken(OWNER_ID, 'reset', 60_000);
    const auth_value = fakeAuthValue();
    const keys = fakeVaultKeys();
    expect((await post('/api/auth/reset', { token, auth_value, keys })).statusCode).toBe(200);
    expect((await getAccountsStore().vault.getKeys(OWNER_ID))?.wrapped_by_master).toBe(keys.wrapped_by_master);
    expect((await getAccountsStore().vault.list(OWNER_ID, 0)).map(o => o.id)).toEqual(['object-0001']);
    expect((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: OWNER_EMAIL, password: auth_value } })).statusCode).toBe(200);
  });

  it('erases the records when the person goes on without the kit', async () => {
    await setUp();
    await put('object-0001', Buffer.from('a'));
    const token = await issueUserToken(OWNER_ID, 'reset', 60_000);
    const keys = fakeVaultKeys();
    expect((await post('/api/auth/reset', { token, auth_value: fakeAuthValue(), keys, erase: true })).statusCode).toBe(200);
    expect(await getAccountsStore().vault.list(OWNER_ID, 0)).toEqual([]);
    expect(fs.existsSync(`${vaultDirOf(OWNER_ID)}/object-0001`)).toBe(false);
    expect((await getAccountsStore().vault.getKeys(OWNER_ID))?.public_key).toBe(keys.public_key);
  });

  it('does not let a password this server would know be set beside keys it cannot open', async () => {
    await setUp();
    const token = await issueUserToken(OWNER_ID, 'reset', 60_000);
    const res = await post('/api/auth/reset', { token, password: 'a-brand-new-password' });
    expect(res.statusCode).toBe(400);
    // The link is still good.
    expect((await post('/api/auth/reset/keys', { token })).statusCode).toBe(200);
  });
});

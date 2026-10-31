import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import type { AddressInfo } from 'net';
import { createAccountKeys, resetWithRecovery, type KdfParams } from '../crypto/keys.js';
import { readRecoveryKey, writeRecoveryKey } from '../crypto/recovery-kit.js';
import { ConflictError, VaultSession, fetchKeys, prepareSignIn } from '../crypto/vault-client.js';
import { newInviteCode } from '../crypto/delegation.js';
import { openObject } from '../crypto/keys.js';
import { OpenError } from '../crypto/seal.js';
import type { SealedCache, SealedObject } from '../crypto/sealed-cache.js';

/**
 * The device's code against the real server code, over HTTP, in one process: nothing is faked on the server's side. It is what proves
 * that what the browser seals is what the server stores, that the server's checks accept what the browser makes, and that a second
 * device can open what the first sealed. It needs the server's dependencies (Fastify is the one it looks for), so it is skipped where only the web's are installed.
 */
const haveServer = ['../../../node_modules', '../../../server/node_modules'].some(dir => fs.existsSync(path.resolve(__dirname, dir, 'fastify')));
const FAST: KdfParams = { alg: 'argon2id13', ops: 2, memKiB: 19456 };
const EMAIL = 'person@example.com';
const PASSWORD = 'a long and private master password';

// Skipped where only the web's dependencies are installed; in CI that would hide the one test of the device against the real server.
if (!haveServer && process.env.CI) throw new Error('the server is not installed, so the device-and-server test would be skipped and still look green');

describe.skipIf(!haveServer)('the device and the server together', () => {
  let close: () => Promise<void>;
  let base = '';
  let dataDir = '';
  let server: typeof import('../../../server/src/__tests__/helpers/app.js');
  let store: typeof import('spine-core/store/index.js');
  let accounts: typeof import('../../../server/src/accounts.js');
  let mail: typeof import('../../../server/src/mail/index.js');
  let userId = '';

  /** A browser: remembers the cookies the server sets. */
  const browser = () => {
    const jar = new Map<string, string>();
    const f = (async (url: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      if (jar.size) headers.set('cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '));
      const res = await fetch(base + url, { ...init, headers });
      for (const c of res.headers.getSetCookie()) {
        const [pair] = c.split(';');
        const [k, v] = pair.split('=');
        jar.set(k, v);
      }
      return res;
    }) as typeof fetch;
    return f;
  };

  const post = (f: typeof fetch, url: string, body: unknown) => f(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  const signIn = async (f: typeof fetch, password = PASSWORD) => {
    const { credential, masterKey } = await prepareSignIn(EMAIL, password, f);
    const res = await post(f, '/api/auth/login', { email: EMAIL, password: credential });
    return { res, masterKey };
  };

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(fs.realpathSync(require('os').tmpdir()), 'spine-e2e-'));
    process.env.DATA_DIR = dataDir;
    server = await import('../../../server/src/__tests__/helpers/app.js');
    store = await import('spine-core/store/index.js');
    accounts = await import('../../../server/src/accounts.js');
    mail = await import('../../../server/src/mail/index.js');
    mail.resetMailer({ enabled: true, async send() {} });
    // The server's entry points say where the sealed bytes go (S3); this test is one, over files in the directory above.
    const objects = await import('../../../server/src/objects/index.js');
    objects.useObjects(() => objects.createObjects());
    const app = await server.buildTestApp({ accounts: { registration: 'open' } });
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    close = () => app.close();
  });

  afterAll(async () => {
    await close?.();
    mail?.resetMailer(null);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  let recoveryKit = '';

  it('signs up with keys made on the device, and the server learns neither the password nor a key', async () => {
    const account = await createAccountKeys(PASSWORD, FAST);
    recoveryKit = await writeRecoveryKey(account.recoveryKey);
    const f = browser();
    const res = await post(f, '/api/auth/register', { email: EMAIL, auth_value: account.authValue, keys: account.keys, consent_health_data: true, accept_terms: true });
    expect(res.status).toBe(200);
    const user = (await store.getStore().users.findByEmail(EMAIL))!;
    userId = user.id;
    await store.getStore().users.markVerified(user.id, new Date().toISOString());

    // Everything the server holds about the account, as text.
    const kept = JSON.stringify([user, await store.getStore().vault.getKeys(user.id)]);
    expect(kept).not.toContain(PASSWORD);
    expect(kept).not.toContain(account.authValue); // only its argon2id hash is kept
  });

  it('signs in with the derived credential and opens the vault; a wrong password gets nowhere', async () => {
    const f = browser();
    const wrong = await signIn(f, 'not the master password');
    expect(wrong.res.status).toBe(401);
    const { res, masterKey } = await signIn(f);
    expect(res.status).toBe(200);
    const session = await VaultSession.open(masterKey!, f);
    expect(await session.loadProfiles()).toEqual([]);
    await session.close();
  });

  it('seals a record on one device, stores only ciphertext, and opens it on another', async () => {
    const first = browser();
    const { masterKey } = await signIn(first);
    const one = await VaultSession.open(masterKey!, first);
    const profile = await one.createProfile('Me');
    const secret = 'haemoglobin 13.2 g/dL, taken 2026-03-02';
    const seq = await one.put(profile, 'bundle', 'bundle-00000001', new TextEncoder().encode(secret));
    expect(seq).toBeGreaterThan(0);

    // On disk: bytes the server cannot read.
    const stored = fs.readFileSync(path.join(dataDir, 'vault', userId, 'bundle-00000001'));
    expect(stored.includes(Buffer.from('haemoglobin'))).toBe(false);
    expect(stored.includes(Buffer.from('Me'))).toBe(false);

    // A second browser knowing only the password.
    const second = browser();
    const again = await signIn(second);
    const two = await VaultSession.open(again.masterKey!, second);
    expect(await two.loadProfiles()).toEqual([{ id: profile, name: 'Me' }]);
    const got = await two.get('bundle-00000001', 'bundle');
    expect(new TextDecoder().decode(got.plaintext)).toBe(secret);

    // Both change it; the one holding an old copy is told.
    await two.put(profile, 'bundle', 'bundle-00000001', new TextEncoder().encode('v2'), got.seq);
    await expect(one.put(profile, 'bundle', 'bundle-00000001', new TextEncoder().encode('v3'), got.seq)).rejects.toBeInstanceOf(ConflictError);
    await one.close();
    await two.close();
  });

  it('keeps a copy of what it fetched on the device and reads from it; a copy that does not open is not trusted', async () => {
    const f = browser();
    const requests: string[] = [];
    const counting = ((url: string, init?: RequestInit) => { requests.push(`${init?.method ?? 'GET'} ${String(url)}`); return f(url, init); }) as typeof fetch;
    const { masterKey } = await signIn(f);
    const session = await VaultSession.open(masterKey!, counting);
    const [profile] = await session.loadProfiles();
    await session.put(profile.id, 'bundle', 'bundle-00000099', new TextEncoder().encode('haemoglobin 13.2, written before a copy existed'));
    const kept = new Map<string, SealedObject>();
    const cache: SealedCache = {
      async get(id) { return kept.get(id) ?? null; },
      async put(id, object) { kept.set(id, object); },
      async forget(id) { kept.delete(id); },
      async keepOnly(ids) { for (const id of [...kept.keys()]) if (!ids.has(id)) kept.delete(id); },
    };
    session.useCache(cache);
    const text = (b: Uint8Array) => new TextDecoder().decode(b);
    const asked = (id: string) => requests.filter(u => u.startsWith(`GET /api/vault/objects/${id}`)).length;

    expect(text((await session.get('bundle-00000099', 'bundle')).plaintext)).toContain('haemoglobin');
    expect(asked('bundle-00000099')).toBe(1);
    expect(kept.has('bundle-00000099')).toBe(true);
    expect(text((await session.get('bundle-00000099', 'bundle')).plaintext)).toContain('haemoglobin');
    expect(asked('bundle-00000099')).toBe(1); // from the copy: the server was not asked again

    // What this device writes is kept too, and the index never is (it is the one object that changes).
    await session.put(profile.id, 'log', 'log-00000001', new TextEncoder().encode('a segment'));
    expect(kept.has('log-00000001')).toBe(true);
    await session.put(profile.id, 'library', 'ix-test-00000001', new TextEncoder().encode('{}'));
    expect(kept.has('ix-test-00000001')).toBe(false);
    await session.get('ix-test-00000001', 'library');
    await session.get('ix-test-00000001', 'library');
    expect(asked('ix-test-00000001')).toBe(2); // read twice: each read goes to the server

    // A copy that was damaged does not open: it is dropped, the server is asked, and the fresh one is kept.
    kept.get('bundle-00000099')!.body[10] ^= 1;
    expect(text((await session.get('bundle-00000099', 'bundle')).plaintext)).toContain('haemoglobin');
    expect(asked('bundle-00000099')).toBe(2);
    expect(text((await session.get('bundle-00000099', 'bundle')).plaintext)).toContain('haemoglobin');
    expect(asked('bundle-00000099')).toBe(2);

    // A listing of everything says what the vault holds, and the copy follows it; removing an object drops its copy.
    kept.set('gone-00000001', { body: new Uint8Array([1]), wrappedKey: '', seq: 1, profileId: profile.id });
    await session.list(0);
    expect(kept.has('gone-00000001')).toBe(false);
    expect(kept.has('bundle-00000099')).toBe(true);
    const { seq } = await session.get('log-00000001', 'log');
    await session.remove('log-00000001', seq);
    expect(kept.has('log-00000001')).toBe(false);
    await session.close();
  });

  it('opens with keys fetched ahead, asks for the listing once, and fetches what will be read as soon as it is named', async () => {
    const f = browser();
    const requests: string[] = [];
    const counting = ((url: string, init?: RequestInit) => { requests.push(`${init?.method ?? 'GET'} ${String(url)}`); return f(url, init); }) as typeof fetch;
    const { masterKey } = await signIn(f);
    const keys = await fetchKeys(counting); // what the unlock screen does while the password is typed
    const before = requests.length;
    const session = await VaultSession.open(masterKey!, counting, keys);
    expect(requests.slice(before)).toEqual([]); // opened without asking the server for the keys again

    const listed = await session.list(0);
    const named = listed.objects.find(o => o.kind === 'profile' && !o.deleted)!;
    const marker = requests.length;
    session.prefetch('bundle-00000099'); // started before the keys to open it are ready
    expect(requests.slice(marker)).toEqual(['GET /api/vault/objects/bundle-00000099']);
    const profiles = await session.loadProfiles(listed);
    expect(profiles.map(p => p.id)).toEqual([named.id]);
    expect(requests.filter(u => u.startsWith('GET /api/vault/objects?')).length).toBe(1); // the listing handed over was not asked for again
    const read = await session.get('bundle-00000099', 'bundle');
    expect(new TextDecoder().decode(read.plaintext)).toContain('haemoglobin');
    expect(requests.filter(u => u === 'GET /api/vault/objects/bundle-00000099')).toHaveLength(1); // the read took what was started
    await session.get('bundle-00000099', 'bundle');
    expect(requests.filter(u => u === 'GET /api/vault/objects/bundle-00000099')).toHaveLength(2); // and only once: the next read is a read
    await session.close();
  });

  it('resets a forgotten password with the recovery kit and keeps the records', async () => {
    const token = await accounts.issueUserToken(userId, 'reset', 60_000);
    const f = browser();
    const stored = await (await post(f, '/api/auth/reset/keys', { token })).json();
    const read = await readRecoveryKey(recoveryKit);
    if (!read.ok) throw new Error('the kit did not read back');
    const reset = await resetWithRecovery(read.key, stored, 'a new and different master password', FAST);
    expect((await post(f, '/api/auth/reset', { token, auth_value: reset.authValue, keys: reset.keys })).status).toBe(200);

    const g = browser();
    expect((await signIn(g, PASSWORD)).res.status).toBe(401);
    const { res, masterKey } = await signIn(g, 'a new and different master password');
    expect(res.status).toBe(200);
    const session = await VaultSession.open(masterKey!, g);
    const [profile] = await session.loadProfiles();
    expect(profile.name).toBe('Me');
    expect(new TextDecoder().decode((await session.get('bundle-00000001', 'bundle')).plaintext)).toBe('v2');
    await session.close();
  });

  it('without the kit the old records are removed, and the account starts empty', async () => {
    const token = await accounts.issueUserToken(userId, 'reset', 60_000);
    const fresh = await createAccountKeys('yet another master password', FAST);
    const f = browser();
    expect((await post(f, '/api/auth/reset', { token, auth_value: fresh.authValue, keys: fresh.keys, erase: true })).status).toBe(200);
    expect(fs.existsSync(path.join(dataDir, 'vault', userId, 'bundle-00000001'))).toBe(false);

    const g = browser();
    const { masterKey } = await signIn(g, 'yet another master password');
    const session = await VaultSession.open(masterKey!, g);
    expect(await session.loadProfiles()).toEqual([]);
    await session.close();
  });

  it('lets another account into a profile with a code, and what it held stops opening anything once access is ended', async () => {
    const OWNER_PASSWORD = 'yet another master password';
    const GUEST = 'guest@example.com';
    const GUEST_PASSWORD = 'the guest’s own master password';

    // The owner, with a profile and a record in it.
    const ownerBrowser = browser();
    const { masterKey } = await signIn(ownerBrowser, OWNER_PASSWORD);
    const owner = await VaultSession.open(masterKey!, ownerBrowser);
    const profile = await owner.createProfile('Grandmother');
    await owner.put(profile, 'bundle', 'bundle-shared-001', new TextEncoder().encode('her blood pressure, 120 over 80'));

    // Another person, with an account of their own made on their own device.
    const made = await createAccountKeys(GUEST_PASSWORD, FAST);
    const guestBrowser = browser();
    expect((await post(guestBrowser, '/api/auth/register', { email: GUEST, auth_value: made.authValue, keys: made.keys, consent_health_data: true, accept_terms: true })).status).toBe(200);
    await store.getStore().users.markVerified((await store.getStore().users.findByEmail(GUEST))!.id, new Date().toISOString());
    const prepared = await prepareSignIn(GUEST, GUEST_PASSWORD, guestBrowser);
    expect((await post(guestBrowser, '/api/auth/login', { email: GUEST, password: prepared.credential })).status).toBe(200);
    const guest = await VaultSession.open(prepared.masterKey!, guestBrowser);

    // The invitation: the code is told to the guest and never sent; a code nobody made opens nothing.
    const { code } = await owner.invite(profile, 'guardian');
    await expect(guest.accept(await newInviteCode())).rejects.toMatchObject({ status: 404 });
    const accepted = await guest.accept(code);
    expect(accepted).toMatchObject({ ownerEmail: 'person@example.com', role: 'guardian' });
    await expect(guest.accept(code)).rejects.toMatchObject({ status: 404 }); // spent

    // The guest opens the profile with a key sealed to their own key pair, reads what is in it, and writes into it.
    const received = (await guest.delegations()).received;
    const [{ grant, profileKey }] = await guest.openReceived(received);
    const held = profileKey.slice(); // what a former delegate would keep
    const view = VaultSession.delegated(guest, grant.id, grant.profile_id, profileKey);
    expect((await view.profileRecord(profile)).name).toBe('Grandmother');
    expect(new TextDecoder().decode((await view.get('bundle-shared-001', 'bundle')).plaintext)).toBe('her blood pressure, 120 over 80');
    await view.put(profile, 'bundle', 'bundle-by-guest-1', new TextEncoder().encode('a note by the guardian'));
    expect(new TextDecoder().decode((await owner.get('bundle-by-guest-1', 'bundle')).plaintext)).toBe('a note by the guardian');

    // Ending it replaces the key: the guest can reach nothing, what they held opens no stored object, and the owner still reads everything.
    await owner.revoke(grant.id);
    await expect(view.get('bundle-shared-001', 'bundle')).rejects.toMatchObject({ status: 404 });
    expect((await guest.delegations()).received).toEqual([]);
    const after = (await owner.list(0)).objects.filter(o => o.profile_id === profile && !o.deleted);
    for (const meta of after.filter(o => o.kind !== 'profile')) {
      const body = new Uint8Array(await (await ownerBrowser(`/api/vault/objects/${meta.id}`)).arrayBuffer());
      await expect(openObject(held, meta.kind === 'bundle' ? 'bundle' : meta.kind, meta.id, body, meta.wrapped_key)).rejects.toBeInstanceOf(OpenError);
    }
    expect(new TextDecoder().decode((await owner.get('bundle-shared-001', 'bundle')).plaintext)).toBe('her blood pressure, 120 over 80');
    expect(await owner.loadProfiles()).toEqual([{ id: profile, name: 'Grandmother' }]);
    await owner.close();
    await guest.close();
  });

  it('hands a profile to the person it is of at eighteen: it moves to their vault under a new key, and the guardians wait to be let back in', async () => {
    const signedIn = async (email: string, password: string) => {
      const f = browser();
      const prepared = await prepareSignIn(email, password, f);
      expect((await post(f, '/api/auth/login', { email, password: prepared.credential })).status).toBe(200);
      return { f, session: await VaultSession.open(prepared.masterKey!, f) };
    };
    const makeAccount = async (email: string, password: string) => {
      const made = await createAccountKeys(password, FAST);
      const f = browser();
      expect((await post(f, '/api/auth/register', { email, auth_value: made.authValue, keys: made.keys, consent_health_data: true, accept_terms: true })).status).toBe(200);
      await store.getStore().users.markVerified((await store.getStore().users.findByEmail(email))!.id, new Date().toISOString());
    };
    const PARENT = { email: 'parent@example.com', password: 'the parent’s master password' };
    const TEEN = { email: 'teen@example.com', password: 'the teenager’s master password' };
    const OTHER = { email: 'coparent@example.com', password: 'the other parent’s master password' };
    for (const a of [PARENT, TEEN, OTHER]) await makeAccount(a.email, a.password);

    const parent = (await signedIn(PARENT.email, PARENT.password)).session;
    const child = await parent.createProfile('Alex', { kind: 'child', born: '2008-01-05' });
    await parent.put(child, 'bundle', 'bundle-child-0001', new TextEncoder().encode('vaccinations, 2012 to 2020'));

    // The teenager and the other parent are let in.
    const teen = (await signedIn(TEEN.email, TEEN.password)).session;
    const coparent = (await signedIn(OTHER.email, OTHER.password)).session;
    await teen.accept((await parent.invite(child, 'self')).code);
    await coparent.accept((await parent.invite(child, 'guardian')).code);

    // The teenager takes the records over.
    const [entry] = await teen.openReceived((await teen.delegations()).received);
    expect(entry.grant.role).toBe('self');
    expect(entry.grant.others.map(o => o.delegate_email)).toEqual(['coparent@example.com']);
    const held = entry.profileKey.slice();
    await teen.promote(entry);

    // They are theirs now, in the teenager's own vault, under a key of the teenager's account.
    expect(await teen.loadProfiles()).toContainEqual({ id: child, name: 'Alex', kind: 'child', born: '2008-01-05' });
    expect(new TextDecoder().decode((await teen.get('bundle-child-0001', 'bundle')).plaintext)).toBe('vaccinations, 2012 to 2020');
    expect((await teen.delegations()).received).toEqual([]);

    // The old owner has nothing of them: the rows are gone and so is what an old key opened.
    expect((await parent.list(0)).objects.filter(o => o.profile_id === child && !o.deleted)).toEqual([]);
    await expect(parent.get('bundle-child-0001', 'bundle')).rejects.toMatchObject({ status: 404 });
    const mine = (await teen.list(0)).objects.find(o => o.id === 'bundle-child-0001')!;
    const sealedBody = new Uint8Array(await (await (await signedIn(TEEN.email, TEEN.password)).f('/api/vault/objects/bundle-child-0001')).arrayBuffer());
    await expect(openObject(held, 'bundle', 'bundle-child-0001', sealedBody, mine.wrapped_key)).rejects.toBeInstanceOf(OpenError);

    // The other parent waits: paused, and let back in only if the teenager chooses, with the new key sealed to them already.
    const waiting = (await coparent.delegations()).received;
    expect(waiting.map(g => g.state)).toEqual(['paused']);
    expect(await coparent.openReceived(waiting)).toEqual([]); // paused opens nothing
    const owned = (await teen.delegations()).owned;
    expect(owned).toMatchObject([{ delegate_email: 'coparent@example.com', role: 'guardian', state: 'paused' }]);
    await teen.setGrantState(owned[0].id, 'active');
    const [back] = await coparent.openReceived((await coparent.delegations()).received);
    const view = VaultSession.delegated(coparent, back.grant.id, child, back.profileKey);
    expect(new TextDecoder().decode((await view.get('bundle-child-0001', 'bundle')).plaintext)).toBe('vaccinations, 2012 to 2020');
    for (const s of [parent, teen, coparent]) await s.close();
  });
});

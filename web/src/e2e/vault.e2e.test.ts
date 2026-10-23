import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import type { AddressInfo } from 'net';
import { createAccountKeys, resetWithRecovery, type KdfParams } from '../crypto/keys.js';
import { readRecoveryKey, writeRecoveryKey } from '../crypto/recovery-kit.js';
import { ConflictError, VaultSession, prepareSignIn } from '../crypto/vault-client.js';

/**
 * The device's code against the real server code, over HTTP, in one process: nothing is faked on the server's side. It is what proves
 * that what the browser seals is what the server stores, that the server's checks accept what the browser makes, and that a second
 * device can open what the first sealed. It needs the server's dependencies, so it is skipped where only the web's are installed.
 */
const serverDir = path.resolve(__dirname, '../../../server');
const haveServer = fs.existsSync(path.join(serverDir, 'node_modules'));
const FAST: KdfParams = { alg: 'argon2id13', ops: 2, memKiB: 19456 };
const EMAIL = 'person@example.com';
const PASSWORD = 'a long and private master password';

describe.skipIf(!haveServer)('the device and the server together', () => {
  let close: () => Promise<void>;
  let base = '';
  let dataDir = '';
  let server: typeof import('../../../server/src/__tests__/helpers/app.js');
  let store: typeof import('../../../server/src/store/index.js');
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
    store = await import('../../../server/src/store/index.js');
    accounts = await import('../../../server/src/accounts.js');
    mail = await import('../../../server/src/mail/index.js');
    mail.resetMailer({ enabled: true, async send() {} });
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
});

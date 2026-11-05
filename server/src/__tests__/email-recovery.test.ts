import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { generateKeyPairSync, sign, type KeyObject } from 'crypto';
import { buildTestApp, loginAs } from './helpers/app.js';
import { createTestUser } from './helpers/seed.js';
import { fakeAuthValue, fakeVaultKeys } from 'spine-core/testing/vault.js';
import { getAccountsStore } from 'spine-core/store/index.js';
import { issueUserToken } from '../accounts.js';
import { resetMessage } from '../reset-proof.js';
import { resetMailer, type MailMessage } from '../mail/index.js';

/**
 * SECURITY.md S-38. Recovery by email is on for an account unless its owner turns it off. Off, no recovery mail is sent and a link cannot
 * start the records over or replace the keys without the recovery kit's signature; the owner has chosen that nothing but the kit and the
 * password can get them back.
 */
const ID = 'user-email-recovery';
const EMAIL = 'recovery@spine.test';

let app: Awaited<ReturnType<typeof buildTestApp>>;
let sent: MailMessage[];
beforeEach(async () => {
  sent = [];
  resetMailer({ enabled: true, async send(m) { sent.push(m); } });
  app = await buildTestApp({ accounts: { registration: 'open' } });
  await createTestUser(EMAIL, { id: ID });
});
afterEach(async () => { await app.close(); resetMailer(null); });

const store = () => getAccountsStore();
const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, payload: payload as object });
const asRecord = (keys: ReturnType<typeof fakeVaultKeys>) => ({ ...keys, kdf_params: JSON.stringify(keys.kdf_params) });
const setting = (cookie: string, enabled: unknown) => app.inject({ method: 'PUT', url: '/api/account/email-recovery', payload: { enabled } as object, headers: { cookie } });

function signer() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { privateKey, verifier: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url') };
}
const proofFor = (key: KeyObject, token: string, authValue: string, keys: ReturnType<typeof fakeVaultKeys>) =>
  sign(null, Buffer.from(resetMessage(token, authValue, keys, keys.kdf_params as never)), key).toString('base64url');

async function vault(verifier: string | null) {
  const keys = fakeVaultKeys();
  await store().vault.putKeys(ID, { ...asRecord(keys), reset_verifier: verifier }, new Date().toISOString());
  return keys;
}

describe('the setting', () => {
  it('is on for an account, and /api/auth/me says so', async () => {
    const cookie = await loginAs(app, EMAIL);
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).json()).toMatchObject({ email_recovery: true });
  });

  it('needs a session', async () => {
    expect((await app.inject({ method: 'PUT', url: '/api/account/email-recovery', payload: { enabled: false } })).statusCode).toBe(401);
  });

  it('refuses a value that is not a boolean', async () => {
    const cookie = await loginAs(app, EMAIL);
    expect((await setting(cookie, 'no')).statusCode).toBe(400);
  });

  it('cannot be turned off until the vault has its verifier: the kit could not then reset it, and the person would be locked out', async () => {
    const cookie = await loginAs(app, EMAIL);
    await vault(null);
    const res = await setting(cookie, false);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'verifier_missing' });
    expect((await store().users.findById(ID))?.email_recovery).toBe(1);
  });

  it('cannot be turned off for an account with no vault', async () => {
    const cookie = await loginAs(app, EMAIL);
    expect((await setting(cookie, false)).statusCode).toBe(409);
  });

  it('turns off with a verifier, and the owner is told by mail', async () => {
    const cookie = await loginAs(app, EMAIL);
    await vault(signer().verifier);
    expect((await setting(cookie, false)).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).json()).toMatchObject({ email_recovery: false });
    await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0));
    expect(sent[0].to).toBe(EMAIL);
    expect(sent[0].text).toContain('email');
  });

  it('turns back on without a verifier', async () => {
    const cookie = await loginAs(app, EMAIL);
    await vault(signer().verifier);
    await setting(cookie, false);
    expect((await setting(cookie, true)).statusCode).toBe(200);
    expect((await store().users.findById(ID))?.email_recovery).toBe(1);
  });
});

describe('with recovery by email off', () => {
  const turnedOff = async () => {
    const mine = signer();
    const keys = await vault(mine.verifier);
    await store().users.setEmailRecovery(ID, false);
    return { mine, keys };
  };

  it('sends no recovery mail, and answers as it does for any address', async () => {
    await turnedOff();
    const asked = await post('/api/auth/forgot', { email: EMAIL });
    const unknown = await post('/api/auth/forgot', { email: 'nobody@spine.test' });
    expect(asked.statusCode).toBe(unknown.statusCode);
    expect(asked.json()).toEqual(unknown.json());
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(sent).toHaveLength(0);
  });

  it('on, a recovery mail is sent', async () => {
    await vault(signer().verifier);
    await post('/api/auth/forgot', { email: EMAIL });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
  });

  it('refuses a link that would start the records over, and does not spend it', async () => {
    const { keys } = await turnedOff();
    const token = await issueUserToken(ID, 'reset', 60_000);
    const res = await post('/api/auth/reset', { token, auth_value: fakeAuthValue(), keys: fakeVaultKeys(), erase: true });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'email_recovery_off' });
    expect((await store().vault.getKeys(ID))?.wrapped_by_master).toBe(keys.wrapped_by_master);
    expect((await post('/api/auth/reset/keys', { token })).json()).toMatchObject({ vault: true, email_recovery: false });
  });

  it('refuses a link with no signature', async () => {
    await turnedOff();
    const token = await issueUserToken(ID, 'reset', 60_000);
    expect((await post('/api/auth/reset', { token, auth_value: fakeAuthValue(), keys: fakeVaultKeys() })).statusCode).toBe(401);
  });

  it('still resets with the recovery kit: the signature is the authority', async () => {
    const { mine } = await turnedOff();
    const token = await issueUserToken(ID, 'reset', 60_000);
    const next = fakeVaultKeys();
    const auth_value = fakeAuthValue();
    const res = await post('/api/auth/reset', { token, auth_value, keys: next, proof: proofFor(mine.privateKey, token, auth_value, next) });
    expect(res.statusCode).toBe(200);
    expect((await store().vault.getKeys(ID))?.wrapped_by_master).toBe(next.wrapped_by_master);
  });
});

describe('with recovery by email on', () => {
  it('starting over still works, as it did', async () => {
    await vault(signer().verifier);
    const token = await issueUserToken(ID, 'reset', 60_000);
    expect((await post('/api/auth/reset', { token, auth_value: fakeAuthValue(), keys: fakeVaultKeys(), erase: true })).statusCode).toBe(200);
  });
});

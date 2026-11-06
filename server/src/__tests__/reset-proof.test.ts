import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { generateKeyPairSync, sign, type KeyObject } from 'crypto';
import { buildTestApp, loginAs } from './helpers/app.js';
import { createTestUser } from './helpers/seed.js';

/** Its own account: the files the tests put in the shared data directory are not another test file's (`user-owner`'s are). */
const OWNER_ID = 'user-reset-proof';
const OWNER_EMAIL = 'proof@spine.test';
import { fakeAuthValue, fakeVaultKeys } from 'spine-core/testing/vault.js';
import { getAccountsStore } from 'spine-core/store/index.js';
import { issueUserToken } from '../accounts.js';
import { resetMessage } from '../reset-proof.js';
import { resetMailer } from '../mail/index.js';

/**
 * SECURITY.md S-38. The email link proves the mailbox, not the recovery kit, and the server cannot open anything the kit opens. So a vault
 * keeps a verifier, the public half of a key the device makes from the account key, and a reset that replaces the keys must be signed for it.
 */
let app: Awaited<ReturnType<typeof buildTestApp>>;
beforeEach(async () => {
  resetMailer({ enabled: true, async send() {} });
  app = await buildTestApp({ accounts: { registration: 'open' } });
  await createTestUser(OWNER_EMAIL, { id: OWNER_ID });
});
afterEach(async () => { await app.close(); resetMailer(null); });

const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, payload: payload as object });
const store = () => getAccountsStore();

/** A signing key like the device's, and the verifier the server keeps for it. */
function signer() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { privateKey, verifier: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url') };
}
const asRecord = (keys: ReturnType<typeof fakeVaultKeys>) => ({ ...keys, kdf_params: JSON.stringify(keys.kdf_params) });
const proofFor = (key: KeyObject, token: string, authValue: string, keys: ReturnType<typeof fakeVaultKeys>) =>
  sign(null, Buffer.from(resetMessage(token, authValue, keys, keys.kdf_params as never)), key).toString('base64url');

async function vaultWithVerifier() {
  const mine = signer();
  const keys = fakeVaultKeys();
  await store().vault.putKeys(OWNER_ID, { ...asRecord(keys), reset_verifier: mine.verifier }, new Date().toISOString());
  return { mine, keys };
}

describe('a reset that replaces the keys, on a vault with a verifier', () => {
  it('is refused with the link alone, and the link is not spent', async () => {
    const { keys } = await vaultWithVerifier();
    const token = await issueUserToken(OWNER_ID, 'reset', 60_000);
    const res = await post('/api/auth/reset', { token, auth_value: fakeAuthValue(), keys: fakeVaultKeys() });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'recovery_proof_required' });
    expect((await store().vault.getKeys(OWNER_ID))?.wrapped_by_master).toBe(keys.wrapped_by_master);
    expect((await post('/api/auth/reset/keys', { token })).statusCode).toBe(200);
  });

  it('is refused when signed by another key', async () => {
    const { keys } = await vaultWithVerifier();
    const token = await issueUserToken(OWNER_ID, 'reset', 60_000);
    const next = fakeVaultKeys();
    const auth_value = fakeAuthValue();
    const res = await post('/api/auth/reset', { token, auth_value, keys: next, proof: proofFor(signer().privateKey, token, auth_value, next) });
    expect(res.statusCode).toBe(401);
    expect((await store().vault.getKeys(OWNER_ID))?.wrapped_by_master).toBe(keys.wrapped_by_master);
  });

  it('is refused when the keys sent are not the keys that were signed', async () => {
    const { mine } = await vaultWithVerifier();
    const token = await issueUserToken(OWNER_ID, 'reset', 60_000);
    const signed = fakeVaultKeys();
    const auth_value = fakeAuthValue();
    const proof = proofFor(mine.privateKey, token, auth_value, signed);
    expect((await post('/api/auth/reset', { token, auth_value, keys: fakeVaultKeys(), proof })).statusCode).toBe(401);
    expect((await post('/api/auth/reset', { token, auth_value: fakeAuthValue(), keys: signed, proof })).statusCode).toBe(401);
  });

  it('is refused when the signature was made for another link', async () => {
    const { mine } = await vaultWithVerifier();
    const token = await issueUserToken(OWNER_ID, 'reset', 60_000);
    const next = fakeVaultKeys();
    const auth_value = fakeAuthValue();
    const proof = proofFor(mine.privateKey, 'x'.repeat(43), auth_value, next);
    expect((await post('/api/auth/reset', { token, auth_value, keys: next, proof })).statusCode).toBe(401);
  });

  it('goes through with the signature, and the keys are replaced', async () => {
    const { mine } = await vaultWithVerifier();
    const token = await issueUserToken(OWNER_ID, 'reset', 60_000);
    const next = fakeVaultKeys();
    const auth_value = fakeAuthValue();
    const res = await post('/api/auth/reset', { token, auth_value, keys: next, proof: proofFor(mine.privateKey, token, auth_value, next) });
    expect(res.statusCode).toBe(200);
    const stored = await store().vault.getKeys(OWNER_ID);
    expect(stored?.wrapped_by_master).toBe(next.wrapped_by_master);
    expect(stored?.reset_verifier).toBe(mine.verifier);
  });

  it('cannot be turned into a verifier change by sending one with the keys', async () => {
    const { mine } = await vaultWithVerifier();
    const token = await issueUserToken(OWNER_ID, 'reset', 60_000);
    const next = { ...fakeVaultKeys(), reset_verifier: signer().verifier };
    const auth_value = fakeAuthValue();
    await post('/api/auth/reset', { token, auth_value, keys: next, proof: proofFor(mine.privateKey, token, auth_value, next) });
    expect((await store().vault.getKeys(OWNER_ID))?.reset_verifier).toBe(mine.verifier);
  });
});

describe('a reset on a vault that has no verifier, or that starts over', () => {
  it('is refused with the link alone, for a vault with no verifier: it has no key to prove the kit against', async () => {
    await store().vault.putKeys(OWNER_ID, asRecord(fakeVaultKeys()), new Date().toISOString());
    const token = await issueUserToken(OWNER_ID, 'reset', 60_000);
    const res = await post('/api/auth/reset', { token, auth_value: fakeAuthValue(), keys: fakeVaultKeys() });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'recovery_proof_required' });
  });

  it('starting over without the kit needs no signature, and the new vault takes the new verifier', async () => {
    await vaultWithVerifier();
    const token = await issueUserToken(OWNER_ID, 'reset', 60_000);
    const fresh = { ...fakeVaultKeys(), reset_verifier: signer().verifier };
    const res = await post('/api/auth/reset', { token, auth_value: fakeAuthValue(), keys: fresh, erase: true });
    expect(res.statusCode).toBe(200);
    expect((await store().vault.getKeys(OWNER_ID))?.reset_verifier).toBe(fresh.reset_verifier);
  });
});

describe('the verifier', () => {
  const call = (cookie: string, method: 'GET' | 'PUT', url: string, payload?: unknown) => app.inject({ method, url, payload: payload as object, headers: { cookie } });

  it('is stored with a new vault', async () => {
    const cookie = await loginAs(app, OWNER_EMAIL);
    const verifier = signer().verifier;
    expect((await call(cookie, 'PUT', '/api/vault/keys', { auth_value: fakeAuthValue(), keys: { ...fakeVaultKeys(), reset_verifier: verifier } })).statusCode).toBe(200);
    expect((await call(cookie, 'GET', '/api/vault/keys')).json()).toMatchObject({ reset_verifier: verifier });
  });
});

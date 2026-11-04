import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildTestApp, loginAs } from './helpers/app.js';
import { OWNER_EMAIL, OWNER_ID, TEST_PASSWORD } from './helpers/seed.js';
import { fakeAuthValue, fakeVaultKeys } from 'spine-core/testing/vault.js';
import { getAccountsStore } from 'spine-core/store/index.js';
import { issueUserToken } from '../accounts.js';
import { resetMailer, type MailMessage, type Mailer } from '../mail/index.js';
import { base32Decode, hotp, stepAt } from '../totp.js';

/**
 * SECURITY.md S-38. A reset link is the mailbox's word, and a reset replaces the vault's keys, so an account with a second factor asks
 * for it here too, a wrong guess is limited per link, and the owner is told by mail whenever one is made.
 */
let app: Awaited<ReturnType<typeof buildTestApp>>;
let sent: MailMessage[];
const fakeMailer: Mailer = { enabled: true, async send(message) { sent.push(message); } };

const START = new Date('2026-03-01T12:00:00Z').getTime();
const STEP_MS = 30_000;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(START);
  sent = [];
  resetMailer(fakeMailer);
  app = await buildTestApp({ accounts: { registration: 'open' } });
});
afterEach(async () => {
  vi.useRealTimers();
  await app.close();
  resetMailer(null);
});

const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, payload: payload as object });
const codeFor = (secret: string, stepsAhead = 0) => hotp(base32Decode(secret), stepAt(Date.now()) + stepsAhead);
const owner = () => getAccountsStore();

/** Turns the second factor on for the owner and returns what an authenticator holds. */
async function withSecondFactor() {
  const cookie = await loginAs(app, OWNER_EMAIL);
  const setup = await app.inject({ method: 'POST', url: '/api/auth/totp/setup', payload: { password: TEST_PASSWORD }, headers: { cookie } });
  const { secret } = setup.json() as { secret: string };
  const enable = await app.inject({ method: 'POST', url: '/api/auth/totp/enable', payload: { code: codeFor(secret) }, headers: { cookie } });
  expect(enable.statusCode).toBe(200);
  // Turning it on told the owner, as it should; what the tests count is the mail about the reset.
  await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0));
  sent.length = 0;
  vi.setSystemTime(Date.now() + 2 * STEP_MS); // the code that enabled it is spent
  return { secret, recovery: (enable.json() as { recovery_codes: string[] }).recovery_codes };
}

const withVault = async () => {
  const keys = fakeVaultKeys();
  await owner().vault.putKeys(OWNER_ID, { ...keys, kdf_params: JSON.stringify(keys.kdf_params) }, new Date().toISOString());
  return keys;
};

describe('a reset link on an account with a second factor', () => {
  it('says that a code is needed, to whoever holds the link', async () => {
    await withSecondFactor();
    await withVault();
    const token = await issueUserToken(OWNER_ID, 'reset', 60_000);
    expect(await (await post('/api/auth/reset/keys', { token })).json()).toMatchObject({ vault: true, second_factor: true });
  });

  it('does not replace the vault keys without a code, and does not spend the link', async () => {
    await withSecondFactor();
    const before = await withVault();
    const token = await issueUserToken(OWNER_ID, 'reset', 60_000);
    const mine = fakeVaultKeys();
    const res = await post('/api/auth/reset', { token, auth_value: fakeAuthValue(), keys: mine });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'second_factor_required' });
    expect((await owner().vault.getKeys(OWNER_ID))?.wrapped_by_master).toBe(before.wrapped_by_master);
    expect((await post('/api/auth/reset/keys', { token })).statusCode).toBe(200);
    expect(sent).toHaveLength(0);
  });

  it('does not erase the vault without a code either', async () => {
    await withSecondFactor();
    const before = await withVault();
    const token = await issueUserToken(OWNER_ID, 'reset', 60_000);
    const res = await post('/api/auth/reset', { token, auth_value: fakeAuthValue(), keys: fakeVaultKeys(), erase: true });
    expect(res.statusCode).toBe(401);
    expect((await owner().vault.getKeys(OWNER_ID))?.public_key).toBe(before.public_key);
  });

  it('refuses a wrong code and changes nothing', async () => {
    await withSecondFactor();
    const before = await withVault();
    const token = await issueUserToken(OWNER_ID, 'reset', 60_000);
    const res = await post('/api/auth/reset', { token, auth_value: fakeAuthValue(), keys: fakeVaultKeys(), code: '000000' });
    expect(res.statusCode).toBe(401);
    expect((await owner().vault.getKeys(OWNER_ID))?.wrapped_by_master).toBe(before.wrapped_by_master);
  });

  it('asks for the code when the reset is of a password alone, as it does for keys', async () => {
    await withSecondFactor();
    const token = await issueUserToken(OWNER_ID, 'reset', 60_000);
    const res = await post('/api/auth/reset', { token, password: 'a-brand-new-password' });
    expect(res.statusCode).toBe(401);
    expect(await (await post('/api/auth/reset/keys', { token })).json()).toMatchObject({ vault: false, second_factor: true });
  });

  it('replaces the keys with a right code, and tells the owner by mail', async () => {
    const { secret } = await withSecondFactor();
    await withVault();
    const token = await issueUserToken(OWNER_ID, 'reset', 60_000);
    const mine = fakeVaultKeys();
    const res = await post('/api/auth/reset', { token, auth_value: fakeAuthValue(), keys: mine, code: codeFor(secret) });
    expect(res.statusCode).toBe(200);
    expect((await owner().vault.getKeys(OWNER_ID))?.wrapped_by_master).toBe(mine.wrapped_by_master);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].to).toBe(OWNER_EMAIL);
    expect(sent[0].text).toContain('reset');
  });

  it('accepts a recovery code in place of an authenticator code', async () => {
    const { recovery } = await withSecondFactor();
    await withVault();
    const token = await issueUserToken(OWNER_ID, 'reset', 60_000);
    const res = await post('/api/auth/reset', { token, auth_value: fakeAuthValue(), keys: fakeVaultKeys(), code: recovery[0] });
    expect(res.statusCode).toBe(200);
  });

  it('limits wrong codes per link: after five, a right one is refused too', async () => {
    const { secret } = await withSecondFactor();
    const before = await withVault();
    const token = await issueUserToken(OWNER_ID, 'reset', 60_000);
    for (let i = 0; i < 5; i++) {
      expect((await post('/api/auth/reset', { token, auth_value: fakeAuthValue(), keys: fakeVaultKeys(), code: '000000' })).statusCode).toBe(401);
    }
    const res = await post('/api/auth/reset', { token, auth_value: fakeAuthValue(), keys: fakeVaultKeys(), code: codeFor(secret) });
    expect(res.statusCode).toBe(429);
    expect((await owner().vault.getKeys(OWNER_ID))?.wrapped_by_master).toBe(before.wrapped_by_master);
  });
});

describe('a reset link on an account without a second factor', () => {
  it('still resets, as before, and the owner is told by mail', async () => {
    await withVault();
    const token = await issueUserToken(OWNER_ID, 'reset', 60_000);
    const mine = fakeVaultKeys();
    const res = await post('/api/auth/reset', { token, auth_value: fakeAuthValue(), keys: mine });
    expect(res.statusCode).toBe(200);
    expect((await owner().vault.getKeys(OWNER_ID))?.wrapped_by_master).toBe(mine.wrapped_by_master);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].to).toBe(OWNER_EMAIL);
  });

  it('says in the notice when the records were erased', async () => {
    await withVault();
    const token = await issueUserToken(OWNER_ID, 'reset', 60_000);
    await post('/api/auth/reset', { token, auth_value: fakeAuthValue(), keys: fakeVaultKeys(), erase: true });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].text).toContain('erased');
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildTestApp, loginAs } from './helpers/app.js';
import { createTestUser } from './helpers/seed.js';
import { getAccountsStore } from 'spine-core/store/index.js';
import { resetMailer, type MailMessage } from '../mail/index.js';

/** The account's language: set at sign-up or chosen later, reported by /api/auth/me, and the language its mail is written in. */

let app: Awaited<ReturnType<typeof buildTestApp>>;
let sent: MailMessage[];
const EMAIL = 'lang@spine.test';
const CONSENT = { consent_health_data: true, accept_terms: true };

beforeEach(async () => {
  sent = [];
  resetMailer({ enabled: true, async send(m) { sent.push(m); } });
  app = await buildTestApp({ accounts: { registration: 'open' } });
});
afterEach(async () => { await app.close(); resetMailer(null); });

const me = async (cookie: string) => (await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).json();
const setLanguage = (cookie: string | undefined, language: unknown) => app.inject({ method: 'PUT', url: '/api/account/language', payload: { language } as object, headers: cookie ? { cookie } : {} });

describe('the setting', () => {
  it('is unset for an account, and /api/auth/me says so', async () => {
    await createTestUser(EMAIL);
    expect((await me(await loginAs(app, EMAIL))).language).toBeNull();
  });

  it('is chosen, kept and cleared', async () => {
    const { id } = await createTestUser(EMAIL);
    const cookie = await loginAs(app, EMAIL);
    expect((await setLanguage(cookie, 'ro')).statusCode).toBe(200);
    expect((await me(cookie)).language).toBe('ro');
    expect((await getAccountsStore().users.findById(id))?.language).toBe('ro');
    // A language the documents are translated into but the screens are not written in is a fine choice.
    expect((await setLanguage(cookie, 'it')).statusCode).toBe(200);
    expect((await setLanguage(cookie, null)).statusCode).toBe(200);
    expect((await me(cookie)).language).toBeNull();
  });

  it('needs a session and refuses what is not a language', async () => {
    await createTestUser(EMAIL);
    expect((await setLanguage(undefined, 'ro')).statusCode).toBe(401);
    const cookie = await loginAs(app, EMAIL);
    for (const bad of ['xx', 'RO', 5, {}, undefined, 'ro; drop table users']) expect((await setLanguage(cookie, bad)).statusCode).toBe(400);
    expect((await me(cookie)).language).toBeNull();
  });
});

describe('at sign-up', () => {
  it('is the page\'s language, and the mail that confirms the address is written in it', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: EMAIL, password: 'a-long-test-password-1', ...CONSENT, language: 'ro' } });
    expect(res.statusCode).toBe(200);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].subject).toBe('Confirmați adresa de e-mail');
    expect(sent[0].html).toContain('<html lang="ro">');
    expect((await getAccountsStore().users.findByEmail(EMAIL))?.language).toBe('ro');
  });

  it('leaves it unset, and the mail in English, when the page sent none or one that is not a language', async () => {
    await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: EMAIL, password: 'a-long-test-password-1', ...CONSENT, language: '<script>' } });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].subject).toBe('Confirm your email address');
    expect((await getAccountsStore().users.findByEmail(EMAIL))?.language).toBeNull();
  });
});

describe('mail to an account', () => {
  it('is in its language, a reset link for one', async () => {
    await createTestUser(EMAIL, { language: 'de' });
    await app.inject({ method: 'POST', url: '/api/auth/forgot', payload: { email: EMAIL } });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].subject).toBe('Setzen Sie Ihr Passwort zurück');
    expect(sent[0].text).toContain('Wählen Sie ein neues Passwort:');
  });

  it('is in English for an account with no language, or one the mail is not written in', async () => {
    await createTestUser(EMAIL, { language: 'it' });
    await app.inject({ method: 'POST', url: '/api/auth/forgot', payload: { email: EMAIL } });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].subject).toBe('Reset your password');
  });
});

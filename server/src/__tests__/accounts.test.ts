import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildTestApp, loginAs } from './helpers/app.js';
import { OWNER_EMAIL, TEST_PASSWORD, createTestUser } from './helpers/seed.js';
import { getStore } from '../store/index.js';
import { resetMailer, type Mailer, type MailMessage } from '../mail/index.js';
import { hashUserToken } from '../user-tokens.js';
import { issueUserToken } from '../accounts.js';
import { verifyPassword } from '../passwords.js';
import { v4 as uuidv4 } from 'uuid';

/**
 * SECURITY.md M-6 and M-11: signup, address verification and recovery.
 * Mail goes to a fake mailer; links are read back out of what it was given.
 */

let app: Awaited<ReturnType<typeof buildTestApp>>;
let sent: MailMessage[];
let mailerEnabled: boolean;
let failSending: boolean;

const fakeMailer: Mailer = {
  get enabled() { return mailerEnabled; },
  async send(message) {
    if (failSending) throw new Error('Brevo rejected the message with status 503');
    sent.push(message);
  },
};

beforeEach(async () => {
  sent = [];
  mailerEnabled = true;
  failSending = false;
  resetMailer(fakeMailer);
  app = await buildTestApp({ accounts: { registration: 'open' } });
});
afterEach(async () => { await app.close(); resetMailer(null); });

const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, payload: payload as object });

/** Mail is sent after the response, so wait for it. */
const mailArrives = (count: number) => vi.waitFor(() => expect(sent).toHaveLength(count));

/** The token is in the URL fragment. */
const tokenIn = (message: MailMessage) => /#([A-Za-z0-9_-]{43})/.exec(message.text)![1];

const NEW_PASSWORD = 'a-brand-new-password';
/** What the sign-up form sends when both boxes are ticked: consent to the use of health data, and acceptance of the terms, apart. */
const CONSENT = { consent_health_data: true, accept_terms: true };

describe('GET /api/auth/options', () => {
  it('tells the sign-in page what is available', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/auth/options' })).json())
      .toEqual({ registration: 'open', recovery: true });

    mailerEnabled = false;
    expect((await app.inject({ method: 'GET', url: '/api/auth/options' })).json())
      .toMatchObject({ recovery: false });
  });

  it('reports closed registration, and there is no register route', async () => {
    const closed = await buildTestApp();
    try {
      expect((await closed.inject({ method: 'GET', url: '/api/auth/options' })).json())
        .toMatchObject({ registration: 'operator' });
      const res = await closed.inject({
        method: 'POST', url: '/api/auth/register',
        payload: { email: 'x@example.com', password: NEW_PASSWORD, ...CONSENT },
      });
      expect(res.statusCode).toBe(404);
    } finally { await closed.close(); }
  });
});

describe('POST /api/auth/register', () => {
  it('creates an unverified account and mails one link', async () => {
    const res = await post('/api/auth/register', { email: 'New@Example.com', password: NEW_PASSWORD, ...CONSENT });
    expect(res.statusCode).toBe(200);

    await mailArrives(1);
    expect(sent[0].to).toBe('new@example.com');
    expect(sent[0].text).toContain('/verify#');

    const user = await getStore().users.findByEmail('new@example.com');
    expect(user?.email_verified_at).toBeNull();
    expect(user?.password_hash).toMatch(/^\$argon2id\$/);
  });

  it('answers a taken address exactly as it answers a new one, and mails nothing', async () => {
    const fresh = await post('/api/auth/register', { email: 'fresh@example.com', password: NEW_PASSWORD, ...CONSENT });
    const taken = await post('/api/auth/register', { email: OWNER_EMAIL, password: NEW_PASSWORD, ...CONSENT });

    expect(taken.statusCode).toBe(fresh.statusCode);
    expect(taken.json()).toEqual(fresh.json());

    await mailArrives(1); // only the fresh one
    await new Promise(r => setTimeout(r, 50));
    expect(sent).toHaveLength(1);
  });

  it('does not change the password of an account that already exists', async () => {
    await post('/api/auth/register', { email: OWNER_EMAIL, password: NEW_PASSWORD, ...CONSENT });

    const user = await getStore().users.findByEmail(OWNER_EMAIL);
    expect(await verifyPassword(user!.password_hash, TEST_PASSWORD)).toBe(true);
    expect(await verifyPassword(user!.password_hash, NEW_PASSWORD)).toBe(false);
  });

  it('refuses a weak password or a bad address and creates nothing', async () => {
    expect((await post('/api/auth/register', { email: 'a@example.com', password: 'short', ...CONSENT })).statusCode).toBe(400);
    expect((await post('/api/auth/register', { email: 'not-an-email', password: NEW_PASSWORD, ...CONSENT })).statusCode).toBe(400);
    expect((await post('/api/auth/register', { password: NEW_PASSWORD, ...CONSENT })).statusCode).toBe(400);

    expect(await getStore().users.findByEmail('a@example.com')).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it('still answers 200 when the mail provider is down, and does not crash', async () => {
    failSending = true;
    const res = await post('/api/auth/register', { email: 'down@example.com', password: NEW_PASSWORD, ...CONSENT });

    expect(res.statusCode).toBe(200);
    await new Promise(r => setTimeout(r, 50));
    // The account exists; the owner asks for another link.
    expect(await getStore().users.findByEmail('down@example.com')).not.toBeNull();
  });
});

describe('an unverified account', () => {
  async function register(email = 'pending@example.com') {
    await post('/api/auth/register', { email, password: NEW_PASSWORD, ...CONSENT });
    await mailArrives(1);
    return tokenIn(sent[0]);
  }

  it('cannot sign in, and gets no session', async () => {
    await register();
    const res = await post('/api/auth/login', { email: 'pending@example.com', password: NEW_PASSWORD, ...CONSENT });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'email_not_verified' });

    const cookie = res.cookies.map(c => `${c.name}=${c.value}`).join('; ');
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).statusCode).toBe(401);
  });

  it('is told nothing to a wrong password, so this is not a way to find accounts', async () => {
    await register();
    const res = await post('/api/auth/login', { email: 'pending@example.com', password: 'not-the-password-at-all' });
    expect(res.statusCode).toBe(401);
  });

  it('can sign in once the link is used', async () => {
    const token = await register();
    expect((await post('/api/auth/verify', { token })).statusCode).toBe(200);

    expect((await post('/api/auth/login', { email: 'pending@example.com', password: NEW_PASSWORD, ...CONSENT })).statusCode).toBe(200);
  });
});

describe('POST /api/auth/verify', () => {
  it('works once', async () => {
    await post('/api/auth/register', { email: 'once@example.com', password: NEW_PASSWORD, ...CONSENT });
    await mailArrives(1);
    const token = tokenIn(sent[0]);

    expect((await post('/api/auth/verify', { token })).statusCode).toBe(200);
    expect((await post('/api/auth/verify', { token })).statusCode).toBe(400);
  });

  it('refuses garbage, nothing, and an empty token alike', async () => {
    const answers = await Promise.all([
      post('/api/auth/verify', { token: 'x'.repeat(43) }),
      post('/api/auth/verify', {}),
      post('/api/auth/verify', { token: '' }),
    ]);
    expect(answers.map(r => r.statusCode)).toEqual([400, 400, 400]);
    expect(answers[0].json()).toEqual(answers[1].json());
  });

  it('refuses an expired link', async () => {
    const user = await createTestUser('late@example.com', { verified: false });
    const token = await issueUserToken(user.id, 'verify', -1000);
    expect((await post('/api/auth/verify', { token })).statusCode).toBe(400);
  });

  it('refuses a reset link used as a verification link, and the reverse', async () => {
    const user = await createTestUser('kinds@example.com', { verified: false });
    const reset = await issueUserToken(user.id, 'reset', 60_000);
    const verify = await issueUserToken(user.id, 'verify', 60_000);

    expect((await post('/api/auth/verify', { token: reset })).statusCode).toBe(400);
    expect((await post('/api/auth/reset', { token: verify, password: NEW_PASSWORD, ...CONSENT })).statusCode).toBe(400);
  });

  it('stores only a hash of the token (P6)', async () => {
    const user = await createTestUser('hashed@example.com', { verified: false });
    const token = await issueUserToken(user.id, 'verify', 60_000);
    const now = new Date().toISOString();

    // The raw token is not what is stored, so it cannot be spent as a hash...
    expect(await getStore().users.consumeToken(token, 'verify', now)).toBeNull();
    // ...but its digest is.
    expect(await getStore().users.consumeToken(hashUserToken(token), 'verify', now)).toBe(user.id);
  });

  it('lets exactly one of two simultaneous requests spend a token', async () => {
    const user = await createTestUser('race@example.com', { verified: false });
    const token = await issueUserToken(user.id, 'verify', 60_000);

    const results = await Promise.all([
      post('/api/auth/verify', { token }), post('/api/auth/verify', { token }),
      post('/api/auth/verify', { token }), post('/api/auth/verify', { token }),
    ]);
    expect(results.filter(r => r.statusCode === 200)).toHaveLength(1);
  });
});

describe('POST /api/auth/resend-verification', () => {
  it('sends a new link to an unverified account and kills the old one', async () => {
    await post('/api/auth/register', { email: 'again@example.com', password: NEW_PASSWORD, ...CONSENT });
    await mailArrives(1);
    const first = tokenIn(sent[0]);

    await post('/api/auth/resend-verification', { email: 'again@example.com' });
    await mailArrives(2);
    const second = tokenIn(sent[1]);

    expect(second).not.toBe(first);
    expect((await post('/api/auth/verify', { token: first })).statusCode).toBe(400);
    expect((await post('/api/auth/verify', { token: second })).statusCode).toBe(200);
  });

  it('answers identically for an unknown address and a verified one, and mails neither', async () => {
    const unverified = await createTestUser('u@example.com', { verified: false });
    expect(unverified.id).toBeTruthy();

    const unknown = await post('/api/auth/resend-verification', { email: 'nobody@example.com' });
    const verified = await post('/api/auth/resend-verification', { email: OWNER_EMAIL });
    const real = await post('/api/auth/resend-verification', { email: 'u@example.com' });

    expect(unknown.json()).toEqual(verified.json());
    expect(unknown.json()).toEqual(real.json());
    expect(unknown.statusCode).toBe(real.statusCode);

    await mailArrives(1); // only the unverified one
    await new Promise(r => setTimeout(r, 50));
    expect(sent).toHaveLength(1);
  });
});

describe('password recovery by email', () => {
  it('is not offered without a mailer', async () => {
    mailerEnabled = false;
    expect((await post('/api/auth/forgot', { email: OWNER_EMAIL })).statusCode).toBe(404);
  });

  it('mails a link to a known address and nothing to an unknown one, with the same answer', async () => {
    const known = await post('/api/auth/forgot', { email: OWNER_EMAIL });
    const unknown = await post('/api/auth/forgot', { email: 'ghost@example.com' });

    expect(unknown.statusCode).toBe(known.statusCode);
    expect(unknown.json()).toEqual(known.json());

    await mailArrives(1);
    await new Promise(r => setTimeout(r, 50));
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(OWNER_EMAIL);
    expect(sent[0].text).toContain('/reset#');
  });

  async function requestReset(email = OWNER_EMAIL) {
    const before = sent.length;
    await post('/api/auth/forgot', { email });
    await mailArrives(before + 1);
    return tokenIn(sent[before]);
  }

  it('sets the new password, once, and the old one stops working', async () => {
    const token = await requestReset();

    expect((await post('/api/auth/reset', { token, password: NEW_PASSWORD, ...CONSENT })).statusCode).toBe(200);
    expect((await post('/api/auth/reset', { token, password: 'another-new-password' })).statusCode).toBe(400);

    expect((await post('/api/auth/login', { email: OWNER_EMAIL, password: TEST_PASSWORD })).statusCode).toBe(401);
    expect((await post('/api/auth/login', { email: OWNER_EMAIL, password: NEW_PASSWORD, ...CONSENT })).statusCode).toBe(200);
  });

  it('ends every existing session (P13)', async () => {
    const cookie = await loginAs(app);
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).statusCode).toBe(200);

    const token = await requestReset();
    await post('/api/auth/reset', { token, password: NEW_PASSWORD, ...CONSENT });

    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).statusCode).toBe(401);
  });

  it('does not spend the link on a password that is too short', async () => {
    const token = await requestReset();

    const weak = await post('/api/auth/reset', { token, password: 'short' });
    expect(weak.statusCode).toBe(400);
    expect(weak.json().error).toMatch(/at least 12/);

    expect((await post('/api/auth/reset', { token, password: NEW_PASSWORD, ...CONSENT })).statusCode).toBe(200);
  });

  it('is replaced by a newer request', async () => {
    const older = await requestReset();
    const newer = await requestReset();

    expect((await post('/api/auth/reset', { token: older, password: NEW_PASSWORD, ...CONSENT })).statusCode).toBe(400);
    expect((await post('/api/auth/reset', { token: newer, password: NEW_PASSWORD, ...CONSENT })).statusCode).toBe(200);
  });

  it('refuses an expired link', async () => {
    const user = await getStore().users.findByEmail(OWNER_EMAIL);
    const token = await issueUserToken(user!.id, 'reset', -1000);
    expect((await post('/api/auth/reset', { token, password: NEW_PASSWORD, ...CONSENT })).statusCode).toBe(400);
  });

  it('confirms the address too: receiving the link proves the mailbox', async () => {
    const pending = await createTestUser('pending-reset@example.com', { verified: false });
    const token = await issueUserToken(pending.id, 'reset', 60_000);

    await post('/api/auth/reset', { token, password: NEW_PASSWORD, ...CONSENT });

    expect((await getStore().users.findById(pending.id))?.email_verified_at).not.toBeNull();
    expect((await post('/api/auth/login', { email: pending.email, password: NEW_PASSWORD, ...CONSENT })).statusCode).toBe(200);
  });

  it('lets exactly one of two simultaneous requests spend the link', async () => {
    const token = await requestReset();
    const results = await Promise.all([
      post('/api/auth/reset', { token, password: NEW_PASSWORD, ...CONSENT }),
      post('/api/auth/reset', { token, password: 'a-different-new-password' }),
    ]);
    expect(results.map(r => r.statusCode).sort()).toEqual([200, 400]);
  });
});

/** P5: public endpoints are rate limited, and not only per source. */
describe('rate limits on the public account endpoints', () => {
  it('limits requests for one address, so it cannot be used to flood an inbox', async () => {
    await app.close();
    app = await buildTestApp({ accounts: { registration: 'open', perAddress: { max: 2, windowMs: 60_000 } } });

    const ask = () => post('/api/auth/forgot', { email: OWNER_EMAIL });
    expect((await ask()).statusCode).toBe(200);
    expect((await ask()).statusCode).toBe(200);
    expect((await ask()).statusCode).toBe(429);

    // Another address is unaffected, and so is a differently-cased spelling of the first.
    expect((await post('/api/auth/forgot', { email: 'someone-else@example.com' })).statusCode).toBe(200);
    expect((await post('/api/auth/forgot', { email: OWNER_EMAIL.toUpperCase() })).statusCode).toBe(429);
  });

  it('limits a single source', async () => {
    await app.close();
    app = await buildTestApp({ accounts: { registration: 'open', perSource: { max: 2, timeWindow: '1 minute' } } });

    const ask = (n: number) => post('/api/auth/forgot', { email: `p${n}@example.com` });
    expect((await ask(1)).statusCode).toBe(200);
    expect((await ask(2)).statusCode).toBe(200);
    expect((await ask(3)).statusCode).toBe(429);
  });

  it('limits registration too', async () => {
    await app.close();
    app = await buildTestApp({ accounts: { registration: 'open', perSource: { max: 1, timeWindow: '1 minute' } } });

    const register = (n: number) => post('/api/auth/register', { email: `r${n}@example.com`, password: NEW_PASSWORD, ...CONSENT });
    expect((await register(1)).statusCode).toBe(200);
    expect((await register(2)).statusCode).toBe(429);
  });
});

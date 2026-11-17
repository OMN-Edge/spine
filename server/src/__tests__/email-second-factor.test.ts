import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildTestApp, loginAs } from './helpers/app.js';
import { OWNER_EMAIL, TEST_PASSWORD } from './helpers/seed.js';
import { resetMailer, type MailMessage } from '../mail/index.js';
import { loadMailConfig } from '../config.js';
import { emailCodeMatches, hashEmailCode } from '../email-code.js';
import { base32Decode, hotp, stepAt } from '../totp.js';
import { PENDING_LOGIN_MS, SECOND_FACTOR_ATTEMPTS } from '../routes/auth.js';
import { getAccountsStore } from 'spine-core/store/index.js';
import { runCli } from '../cli.js';

/**
 * SECURITY.md S-20: with `SPINE_EMAIL_2FA=required` an account with no authenticator gets a code by mail after its password, and one with an
 * authenticator is asked for that instead. These drive the real login routes, limiters and session.
 */
type App = Awaited<ReturnType<typeof buildTestApp>>;
let app: App;
let sent: MailMessage[];
let failMail = false;

beforeEach(async () => {
  sent = [];
  failMail = false;
  resetMailer({ enabled: true, async send(m) { if (failMail) throw new Error('provider down'); sent.push(m); } });
  app = await buildTestApp();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  await app.close();
  resetMailer(null);
});

const cookieOf = (res: { cookies: Array<{ name: string; value: string }> }) => res.cookies.map(c => `${c.name}=${c.value}`).join('; ');
const post = (url: string, payload: object, cookie?: string, ip = '10.0.0.1') =>
  app.inject({ method: 'POST', url, payload, headers: { ...(cookie ? { cookie } : {}), 'x-forwarded-for': ip } });
const passwordStep = async (ip = '10.0.0.1') => {
  const res = await post('/api/auth/login', { email: OWNER_EMAIL, password: TEST_PASSWORD }, undefined, ip);
  return { res, cookie: cookieOf(res) };
};
const codeIn = (m: MailMessage) => /\b(\d{6})\b/.exec(m.text)![1];
const signedIn = async (cookie: string) => (await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).statusCode === 200;

describe('a code by mail as the second step (SPINE_EMAIL_2FA=required)', () => {
  beforeEach(() => { vi.stubEnv('SPINE_EMAIL_2FA', 'required'); });

  it('asks for it after the password, mails it to the address, and opens no session until it is typed', async () => {
    const { res, cookie } = await passwordStep();
    expect(res.json()).toEqual({ second_factor_required: true, method: 'email' });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(OWNER_EMAIL);
    expect(codeIn(sent[0])).toMatch(/^\d{6}$/);
    expect(await signedIn(cookie)).toBe(false);

    const done = await post('/api/auth/login/second-factor', { code: codeIn(sent[0]) }, cookie);
    expect(done.statusCode).toBe(200);
    expect(await signedIn(cookieOf(done))).toBe(true);
  });

  it('sends nothing for a wrong password', async () => {
    await post('/api/auth/login', { email: OWNER_EMAIL, password: 'not the password' });
    expect(sent).toHaveLength(0);
  });

  it('refuses a wrong code, and drops the login after the allowed tries, even for the right code', async () => {
    const { cookie } = await passwordStep();
    const right = codeIn(sent[0]);
    const wrong = right === '000000' ? '111111' : '000000';
    for (let i = 1; i < SECOND_FACTOR_ATTEMPTS; i++) expect((await post('/api/auth/login/second-factor', { code: wrong }, cookie)).statusCode).toBe(401);
    expect((await post('/api/auth/login/second-factor', { code: wrong }, cookie)).json()).toMatchObject({ code: 'login_expired' });
    const late = await post('/api/auth/login/second-factor', { code: right }, cookie);
    expect(late.statusCode).toBe(401);
    expect(await signedIn(cookieOf(late) || cookie)).toBe(false);
  });

  it('is good for one sign-in: a new password step makes a new code and the old one stops working', async () => {
    const first = await passwordStep();
    const second = await passwordStep();
    const [a, b] = sent.map(codeIn);
    if (a !== b) expect((await post('/api/auth/login/second-factor', { code: a }, second.cookie)).statusCode).toBe(401);
    expect((await post('/api/auth/login/second-factor', { code: b }, second.cookie)).statusCode).toBe(200);
    // And the code of one login does not open another's: the first cookie holds the first code.
    expect((await post('/api/auth/login/second-factor', { code: b }, first.cookie)).statusCode).toBe(a === b ? 200 : 401);
  });

  it('is not accepted after the few minutes the login is held', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { cookie } = await passwordStep();
    vi.setSystemTime(Date.now() + PENDING_LOGIN_MS + 1000);
    expect((await post('/api/auth/login/second-factor', { code: codeIn(sent[0]) }, cookie)).json()).toMatchObject({ code: 'login_expired' });
  });

  it('says so, and opens nothing, when the mail cannot be sent', async () => {
    failMail = true;
    const { res, cookie } = await passwordStep();
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: 'code_not_sent' });
    expect(await signedIn(cookie)).toBe(false);
    failMail = false;
    expect((await post('/api/auth/login/second-factor', { code: '123456' }, cookie)).statusCode).toBe(401);
  });

  it('is replaced by the authenticator once one is enrolled: that is asked for, and no code is mailed', async () => {
    vi.stubEnv('SPINE_EMAIL_2FA', 'off');
    const enrolled = await loginAs(app);
    const setup = await post('/api/auth/totp/setup', { password: TEST_PASSWORD }, enrolled);
    const { secret } = setup.json() as { secret: string };
    const code = () => hotp(base32Decode(secret), stepAt(Date.now()));
    expect((await post('/api/auth/totp/enable', { code: code() }, enrolled)).statusCode).toBe(200);
    vi.stubEnv('SPINE_EMAIL_2FA', 'required');
    sent.length = 0;

    const { res, cookie } = await passwordStep('10.0.0.2');
    expect(res.json()).toEqual({ second_factor_required: true, method: 'authenticator' });
    expect(sent).toHaveLength(0);
    // The code of a step already spent at enabling is refused, so move on a step.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 60_000);
    expect((await post('/api/auth/login/second-factor', { code: code() }, cookie)).statusCode).toBe(200);
  });

  it('is not asked for when the setting is off: the password is enough, as before', async () => {
    vi.stubEnv('SPINE_EMAIL_2FA', 'off');
    const { res } = await passwordStep();
    expect(res.json()).toMatchObject({ ok: true });
    expect(sent).toHaveLength(0);
  });
});

describe('the mailed code on its own', () => {
  it('is kept as a hash tied to the account, and does not match another account or a malformed answer', () => {
    vi.stubEnv('SESSION_SECRET', 'k'.repeat(48));
    const hash = hashEmailCode('user-1', '123456');
    expect(hash).not.toContain('123456');
    expect(emailCodeMatches('user-1', '123456', hash)).toBe(true);
    expect(emailCodeMatches('user-1', '123 456', hash)).toBe(true);
    expect(emailCodeMatches('user-2', '123456', hash)).toBe(false);
    for (const typed of ['', '12345', '1234567', 'abcdef', '123456 ; drop']) expect(emailCodeMatches('user-1', typed, hash), typed).toBe(false);
  });

  it('is refused at start without a mailer, and when misspelt', () => {
    const base = { SPINE_MAILER: 'none' };
    expect(() => loadMailConfig({ ...base, SPINE_EMAIL_2FA: 'required' })).toThrow(/needs a mailer/);
    expect(() => loadMailConfig({ ...base, SPINE_EMAIL_2FA: 'yes' })).toThrow(/expected off or required/);
    expect(() => loadMailConfig({ ...base })).not.toThrow();
  });
});

describe('chosen by the owner', () => {
  const put = (url: string, cookie: string, payload: object = {}) => post(url, payload, cookie);
  const get = (url: string, cookie: string) => app.inject({ method: 'GET', url, headers: { cookie } });
  /** The two steps of turning it on, from a session that is already signed in. */
  async function turnOn(cookie: string) {
    sent.length = 0;
    const start = await put('/api/auth/email-2fa/start', cookie, { password: TEST_PASSWORD });
    expect(start.statusCode).toBe(200);
    const enable = await put('/api/auth/email-2fa/enable', cookie, { code: codeIn(sent[0]) });
    expect(enable.statusCode).toBe(200);
    // The notice goes after the answer.
    await new Promise(resolve => setTimeout(resolve, 20));
    const after = sent.slice(1);
    sent.length = 0;
    return after;
  }

  it('is turned on with the password and a code mailed to the address, after which sign-in asks for a code', async () => {
    const cookie = await loginAs(app);
    expect((await get('/api/auth/email-2fa', cookie)).json()).toEqual({ enabled: false, required: false, available: true });
    expect((await get('/api/auth/me', cookie)).json()).toMatchObject({ second_factor: null, email_second_factor_required: false });
    expect((await put('/api/auth/email-2fa/start', cookie, { password: 'wrong' })).statusCode).toBe(401);
    expect(sent).toHaveLength(0);

    await turnOn(cookie);
    expect((await get('/api/auth/email-2fa', cookie)).json()).toMatchObject({ enabled: true });
    expect((await get('/api/auth/me', cookie)).json()).toMatchObject({ second_factor: 'email', second_factor_enabled: false });

    const { res, cookie: pending } = await passwordStep('10.0.0.3');
    expect(res.json()).toEqual({ second_factor_required: true, method: 'email' });
    expect((await post('/api/auth/login/second-factor', { code: codeIn(sent[0]) }, pending)).statusCode).toBe(200);
  });

  it('is not turned on by a code that is wrong, or that has waited too long', async () => {
    const cookie = await loginAs(app);
    await put('/api/auth/email-2fa/start', cookie, { password: TEST_PASSWORD });
    const right = codeIn(sent[0]);
    const wrong = right === '000000' ? '111111' : '000000';
    for (let i = 1; i < SECOND_FACTOR_ATTEMPTS; i++) expect((await put('/api/auth/email-2fa/enable', cookie, { code: wrong })).statusCode).toBe(400);
    expect((await put('/api/auth/email-2fa/enable', cookie, { code: wrong })).json()).toMatchObject({ code: 'code_expired' });
    expect((await put('/api/auth/email-2fa/enable', cookie, { code: right })).json()).toMatchObject({ code: 'code_expired' });
    expect((await get('/api/auth/email-2fa', cookie)).json()).toMatchObject({ enabled: false });

    vi.useFakeTimers({ toFake: ['Date'] });
    await put('/api/auth/email-2fa/start', cookie, { password: TEST_PASSWORD });
    vi.setSystemTime(Date.now() + PENDING_LOGIN_MS + 1000);
    expect((await put('/api/auth/email-2fa/enable', cookie, { code: codeIn(sent[sent.length - 1]) })).json()).toMatchObject({ code: 'code_expired' });
  });

  it('ends the other sessions, which were issued without it, and mails the owner', async () => {
    const cookie = await loginAs(app);
    const other = await loginAs(app);
    const notices = await turnOn(cookie);
    expect(await signedIn(other)).toBe(false);
    expect(await signedIn(cookie)).toBe(true);
    expect(notices.some(m => /Two-factor sign-in was turned on/.test(m.text))).toBe(true);
  });

  it('is refused while an authenticator is on, and the authenticator is asked for once one is enrolled', async () => {
    const cookie = await loginAs(app);
    await turnOn(cookie);
    // An authenticator takes its place: it is the one asked for, and no code is mailed.
    const setup = await put('/api/auth/totp/setup', cookie, { password: TEST_PASSWORD });
    const { secret } = setup.json() as { secret: string };
    expect((await put('/api/auth/totp/enable', cookie, { code: hotp(base32Decode(secret), stepAt(Date.now())) })).statusCode).toBe(200);
    sent.length = 0;
    expect((await passwordStep('10.0.0.4')).res.json()).toEqual({ second_factor_required: true, method: 'authenticator' });
    expect(sent).toHaveLength(0);

    // And it is not turned on beside one.
    await getAccountsStore().users.setEmailSecondFactor((await getAccountsStore().users.findByEmail(OWNER_EMAIL))!.id, false);
    const again = await put('/api/auth/email-2fa/start', cookie, { password: TEST_PASSWORD });
    expect(again.json()).toMatchObject({ code: 'authenticator_on' });
  });

  it('is turned off with the password, and then sign-in asks for nothing more', async () => {
    const cookie = await loginAs(app);
    await turnOn(cookie);
    expect((await put('/api/auth/email-2fa/disable', cookie, { password: 'wrong' })).statusCode).toBe(401);
    expect((await put('/api/auth/email-2fa/disable', cookie, { password: TEST_PASSWORD })).statusCode).toBe(200);
    expect((await passwordStep('10.0.0.5')).res.json()).toMatchObject({ ok: true });
    expect((await put('/api/auth/email-2fa/disable', cookie, { password: TEST_PASSWORD })).json()).toMatchObject({ code: 'not_on' });
  });

  it('cannot be turned off where the operator requires it', async () => {
    const cookie = await loginAs(app);
    await turnOn(cookie);
    vi.stubEnv('SPINE_EMAIL_2FA', 'required');
    expect((await put('/api/auth/email-2fa/disable', cookie, { password: TEST_PASSWORD })).json()).toMatchObject({ code: 'required' });
    expect((await get('/api/auth/email-2fa', cookie)).json()).toEqual({ enabled: true, required: true, available: true });
    expect((await get('/api/auth/me', cookie)).json()).toMatchObject({ second_factor: 'email', email_second_factor_required: true });
  });

  it('is not offered when the service sends no mail', async () => {
    const cookie = await loginAs(app);
    resetMailer({ enabled: false, async send() { throw new Error('none'); } });
    expect((await get('/api/auth/email-2fa', cookie)).json()).toMatchObject({ available: false });
    expect((await put('/api/auth/email-2fa/start', cookie, { password: TEST_PASSWORD })).json()).toMatchObject({ code: 'no_mailer' });
  });

  it('limits the codes it sends', async () => {
    const cookie = await loginAs(app);
    const results: number[] = [];
    for (let i = 0; i < 7; i++) results.push((await put('/api/auth/email-2fa/start', cookie, { password: TEST_PASSWORD })).statusCode);
    expect(results.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(results.slice(5)).toEqual([429, 429]);
    expect(sent).toHaveLength(5);
  });

  it('is turned off by the operator for an account that lost its mailbox', async () => {
    const cookie = await loginAs(app);
    await turnOn(cookie);
    const out: string[] = [];
    expect(await runCli(['disable-2fa', OWNER_EMAIL], { out: l => out.push(l), err: l => out.push(l), readPassword: async () => '' })).toBe(0);
    expect(out.join('\n')).toMatch(/turned off/);
    expect((await passwordStep('10.0.0.6')).res.json()).toMatchObject({ ok: true });
  });
});

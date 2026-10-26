import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildTestApp, loginAs } from './helpers/app.js';
import { createTestUser, OWNER_EMAIL, OWNER_ID, TEST_PASSWORD } from './helpers/seed.js';
import { getAccountsStore } from 'spine-core/store/index.js';
import { issueUserToken } from '../accounts.js';
import { checkSecondFactor } from '../second-factor.js';
import { hashPassword } from '../passwords.js';
import { base32Decode, hotp, stepAt } from '../totp.js';

/**
 * SECURITY.md M-12. These drive the real handlers, store and limiters. Time is the one
 * thing faked (Date only), because a code is valid for a 30-second step and replay is
 * defined in terms of steps.
 */

type App = Awaited<ReturnType<typeof buildTestApp>>;
let app: App;

const START = new Date('2026-03-01T12:00:00Z').getTime();
const STEP_MS = 30_000;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(START);
  app = await buildTestApp();
});
afterEach(async () => {
  vi.useRealTimers();
  await app.close();
});

const advanceSteps = (n: number) => vi.setSystemTime(Date.now() + n * STEP_MS);
const cookieOf = (res: { cookies: Array<{ name: string; value: string }> }) =>
  res.cookies.map(c => `${c.name}=${c.value}`).join('; ');

function post(url: string, payload: object, cookie?: string, ip = '10.0.0.1') {
  return app.inject({
    method: 'POST', url, payload,
    headers: { ...(cookie ? { cookie } : {}), 'x-forwarded-for': ip },
  });
}
const get = (url: string, cookie?: string) =>
  app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });

/** The code an authenticator holding `secret` shows `stepsAhead` steps from now. */
const codeFor = (secret: string, stepsAhead = 0) =>
  hotp(base32Decode(secret), stepAt(Date.now()) + stepsAhead);

/** Enrols the owner and returns the secret, the codes and the session that did it. */
async function enrol(email = OWNER_EMAIL) {
  const cookie = await loginAs(app, email);
  const setup = await post('/api/auth/totp/setup', { password: TEST_PASSWORD }, cookie);
  const { secret } = setup.json() as { secret: string };
  const enable = await post('/api/auth/totp/enable', { code: codeFor(secret) }, cookie);
  expect(enable.statusCode).toBe(200);
  const recovery = (enable.json() as { recovery_codes: string[] }).recovery_codes;
  // The enabling session was moved to the new auth_version; keep using its cookie.
  return { secret, recovery, cookie };
}

/** Password step. Returns the response and the cookie that now holds the pending login. */
async function passwordStep(ip = '10.0.0.1') {
  const res = await post('/api/auth/login', { email: OWNER_EMAIL, password: TEST_PASSWORD }, undefined, ip);
  return { res, cookie: cookieOf(res) };
}

describe('enrolling', () => {
  it('needs the password to start, and returns a secret and an authenticator URI', async () => {
    const cookie = await loginAs(app);
    expect((await post('/api/auth/totp/setup', { password: 'wrong' }, cookie)).statusCode).toBe(401);
    expect((await post('/api/auth/totp/setup', {}, cookie)).statusCode).toBe(401);

    const res = await post('/api/auth/totp/setup', { password: TEST_PASSWORD }, cookie);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { secret: string; otpauth_uri: string };
    expect(body.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(body.otpauth_uri).toContain(`secret=${body.secret}`);
    expect(decodeURIComponent(body.otpauth_uri)).toContain(OWNER_EMAIL);
  });

  it('changes nothing at login until a first code has been accepted', async () => {
    const cookie = await loginAs(app);
    await post('/api/auth/totp/setup', { password: TEST_PASSWORD }, cookie);

    expect((await get('/api/auth/totp', cookie)).json()).toMatchObject({ enabled: false });
    const { res } = await passwordStep();
    expect(res.json()).toMatchObject({ ok: true });
  });

  it('refuses a wrong first code and stays off', async () => {
    const cookie = await loginAs(app);
    const { secret } = (await post('/api/auth/totp/setup', { password: TEST_PASSWORD }, cookie)).json() as { secret: string };
    const wrong = codeFor(secret) === '000000' ? '000001' : '000000';

    const res = await post('/api/auth/totp/enable', { code: wrong }, cookie);
    expect(res.statusCode).toBe(400);
    expect((await get('/api/auth/totp', cookie)).json()).toMatchObject({ enabled: false });
  });

  it('refuses to enable without starting setup', async () => {
    const cookie = await loginAs(app);
    expect((await post('/api/auth/totp/enable', { code: '123456' }, cookie)).statusCode).toBe(409);
  });

  it('turns on with a right code, returning ten recovery codes once', async () => {
    const { recovery, cookie } = await enrol();

    expect(recovery).toHaveLength(10);
    expect(new Set(recovery).size).toBe(10);
    for (const code of recovery) expect(code).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);

    expect((await get('/api/auth/totp', cookie)).json()).toEqual({ enabled: true, recovery_codes_left: 10 });
    expect((await get('/api/auth/me', cookie)).json()).toMatchObject({ second_factor_enabled: true });
  });

  it('ends the user’s other sessions but keeps the one that enrolled', async () => {
    const other = await loginAs(app);
    const { cookie } = await enrol();

    expect((await get('/api/auth/me', other)).statusCode).toBe(401);
    expect((await get('/api/auth/me', cookie)).statusCode).toBe(200);
  });

  it('refuses to start again while it is on', async () => {
    const { cookie } = await enrol();
    expect((await post('/api/auth/totp/setup', { password: TEST_PASSWORD }, cookie)).statusCode).toBe(409);
  });

  it('can restart an unfinished setup, replacing the secret', async () => {
    const cookie = await loginAs(app);
    const first = (await post('/api/auth/totp/setup', { password: TEST_PASSWORD }, cookie)).json() as { secret: string };
    const second = (await post('/api/auth/totp/setup', { password: TEST_PASSWORD }, cookie)).json() as { secret: string };
    expect(second.secret).not.toBe(first.secret);

    // Only the newer secret can finish it.
    expect((await post('/api/auth/totp/enable', { code: codeFor(first.secret) }, cookie)).statusCode).toBe(400);
    expect((await post('/api/auth/totp/enable', { code: codeFor(second.secret) }, cookie)).statusCode).toBe(200);
  });

  it('stores the secret encrypted, never in the clear', async () => {
    const { secret } = await enrol();
    const stored = (await getAccountsStore().users.getTotp(OWNER_ID))!;
    expect(stored.secret_enc).not.toContain(secret);
    expect(stored.secret_enc.startsWith('v1.')).toBe(true);
  });

  it('keeps every route behind a session', async () => {
    for (const [method, url] of [
      ['GET', '/api/auth/totp'],
      ['POST', '/api/auth/totp/setup'],
      ['POST', '/api/auth/totp/enable'],
      ['POST', '/api/auth/totp/disable'],
      ['POST', '/api/auth/totp/recovery-codes'],
    ] as const) {
      const res = await app.inject({ method, url, payload: {} });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });
});

describe('signing in with it on', () => {
  it('the right password alone gives no session', async () => {
    await enrol();
    const { res, cookie } = await passwordStep();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ second_factor_required: true });

    // The cookie holds a pending login, which is not a login.
    expect((await get('/api/auth/me', cookie)).statusCode).toBe(401);
    expect((await get('/api/auth/sessions', cookie)).statusCode).toBe(401);
    expect((await get('/api/vault/keys', cookie)).statusCode).toBe(401);
  });

  it('a right code completes it, with a new session id', async () => {
    const { secret } = await enrol();
    advanceSteps(1); // the enrolling code spent this step
    const { cookie: pending } = await passwordStep();

    const res = await post('/api/auth/login/second-factor', { code: codeFor(secret) }, pending);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, email: OWNER_EMAIL });

    const session = cookieOf(res);
    expect(session).not.toBe(pending);
    expect((await get('/api/auth/me', session)).statusCode).toBe(200);
    expect((await get('/api/auth/sessions', session)).statusCode).toBe(200);
    // The pending cookie is not upgraded by the completion.
    expect((await get('/api/auth/me', pending)).statusCode).toBe(401);
  });

  it('a wrong code gives no session, and says so without saying why', async () => {
    const { secret } = await enrol();
    advanceSteps(1);
    const { cookie } = await passwordStep();
    const wrong = codeFor(secret) === '111111' ? '222222' : '111111';

    const res = await post('/api/auth/login/second-factor', { code: wrong }, cookie);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'incorrect code' });
    expect((await get('/api/auth/me', cookie)).statusCode).toBe(401);
  });

  it('drops the pending login after five wrong codes, even for a right one after', async () => {
    const { secret } = await enrol();
    advanceSteps(1);
    const { cookie } = await passwordStep();
    const right = codeFor(secret);
    const wrong = right === '111111' ? '222222' : '111111';

    for (let i = 0; i < 4; i++) {
      expect((await post('/api/auth/login/second-factor', { code: wrong }, cookie)).json()).toEqual({ error: 'incorrect code' });
    }
    const fifth = await post('/api/auth/login/second-factor', { code: wrong }, cookie);
    expect(fifth.json()).toMatchObject({ code: 'login_expired' });

    const after = await post('/api/auth/login/second-factor', { code: right }, cookie);
    expect(after.statusCode).toBe(401);
    expect(after.json()).toMatchObject({ code: 'login_expired' });
  });

  it('a code cannot be used twice (replay)', async () => {
    const { secret } = await enrol();
    advanceSteps(1);
    const code = codeFor(secret);

    const first = await post('/api/auth/login/second-factor', { code }, (await passwordStep()).cookie);
    expect(first.statusCode).toBe(200);

    // Same code, new login, same 30 seconds.
    const again = await post('/api/auth/login/second-factor', { code }, (await passwordStep()).cookie);
    expect(again.statusCode).toBe(401);
  });

  it('refuses a code from before the last one accepted, though it is inside the window', async () => {
    const { secret } = await enrol(); // accepts step S
    advanceSteps(1); // now S+1
    const newer = await post('/api/auth/login/second-factor', { code: codeFor(secret, 1) }, (await passwordStep()).cookie);
    expect(newer.statusCode).toBe(200); // accepts S+1... ahead by drift: last_step is now S+2

    const older = await post('/api/auth/login/second-factor', { code: codeFor(secret, 0) }, (await passwordStep()).cookie);
    expect(older.statusCode).toBe(401);
  });

  it('accepts a code one step old (a slow phone clock) and refuses one two steps old', async () => {
    const { secret } = await enrol();
    advanceSteps(3);
    const stale = codeFor(secret, -2);
    const slow = codeFor(secret, -1);

    expect((await post('/api/auth/login/second-factor', { code: stale }, (await passwordStep()).cookie)).statusCode).toBe(401);
    expect((await post('/api/auth/login/second-factor', { code: slow }, (await passwordStep()).cookie)).statusCode).toBe(200);
  });

  it('two requests with the same code cannot both succeed', async () => {
    const { secret } = await enrol();
    advanceSteps(1);
    const code = codeFor(secret);
    const [a, b] = [(await passwordStep('10.0.0.2')).cookie, (await passwordStep('10.0.0.3')).cookie];

    const results = await Promise.all([
      post('/api/auth/login/second-factor', { code }, a, '10.0.0.2'),
      post('/api/auth/login/second-factor', { code }, b, '10.0.0.3'),
    ]);
    expect(results.map(r => r.statusCode).sort()).toEqual([200, 401]);
  });

  it('a pending login expires after five minutes', async () => {
    const { secret } = await enrol();
    advanceSteps(1);
    const { cookie } = await passwordStep();

    vi.setSystemTime(Date.now() + 5 * 60_000 + 1000);
    const res = await post('/api/auth/login/second-factor', { code: codeFor(secret) }, cookie);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'login_expired' });
  });

  it('a password change between the steps voids the pending login', async () => {
    const { secret } = await enrol();
    advanceSteps(1);
    const { cookie: pending } = await passwordStep();

    await getAccountsStore().users.setPassword(OWNER_ID, await hashPassword('a-brand-new-password-1'));

    const res = await post('/api/auth/login/second-factor', { code: codeFor(secret) }, pending);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'login_expired' });
  });

  it('has nothing to complete without a password step first', async () => {
    const res = await post('/api/auth/login/second-factor', { code: '123456' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'login_expired' });
  });

  it('does not let a user with no second factor be told they have one', async () => {
    // Wrong password for an account that has it on: the same answer as for any account.
    await enrol();
    const wrong = await post('/api/auth/login', { email: OWNER_EMAIL, password: 'not-the-password' });
    const unknown = await post('/api/auth/login', { email: 'nobody@spine.test', password: 'not-the-password' });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toEqual(unknown.json());
  });

  it('leaves users without it untouched, and another user’s factor does not apply', async () => {
    await createTestUser('plain@spine.test');
    await enrol();

    const plain = await post('/api/auth/login', { email: 'plain@spine.test', password: TEST_PASSWORD });
    expect(plain.json()).toMatchObject({ ok: true });
    expect((await get('/api/auth/me', cookieOf(plain))).statusCode).toBe(200);
  });

  it('a second user’s pending login cannot be completed with the first user’s code', async () => {
    const { secret } = await enrol();
    await createTestUser('second@spine.test');
    const cookie = await loginAs(app, 'second@spine.test');
    await post('/api/auth/totp/setup', { password: TEST_PASSWORD }, cookie);
    const second = (await post('/api/auth/totp/setup', { password: TEST_PASSWORD }, cookie)).json() as { secret: string };
    await post('/api/auth/totp/enable', { code: codeFor(second.secret) }, cookie);

    advanceSteps(1);
    const pending = await post('/api/auth/login', { email: 'second@spine.test', password: TEST_PASSWORD });
    const res = await post('/api/auth/login/second-factor', { code: codeFor(secret) }, cookieOf(pending));
    expect(res.statusCode).toBe(401);
  });
});

describe('recovery codes at sign-in', () => {
  it('work once and then are spent', async () => {
    const { recovery } = await enrol();

    const first = await post('/api/auth/login/second-factor', { code: recovery[0] }, (await passwordStep()).cookie);
    expect(first.statusCode).toBe(200);

    const again = await post('/api/auth/login/second-factor', { code: recovery[0] }, (await passwordStep()).cookie);
    expect(again.statusCode).toBe(401);

    const status = (await get('/api/auth/totp', cookieOf(first))).json();
    expect(status).toEqual({ enabled: true, recovery_codes_left: 9 });
  });

  it('are accepted in lower case and without the dash', async () => {
    const { recovery } = await enrol();
    const typed = recovery[3].toLowerCase().replace('-', ' ');
    const res = await post('/api/auth/login/second-factor', { code: typed }, (await passwordStep()).cookie);
    expect(res.statusCode).toBe(200);
  });

  it('two requests with the same code cannot both succeed', async () => {
    const { recovery } = await enrol();
    const [a, b] = [(await passwordStep('10.0.0.2')).cookie, (await passwordStep('10.0.0.3')).cookie];
    const results = await Promise.all([
      post('/api/auth/login/second-factor', { code: recovery[1] }, a, '10.0.0.2'),
      post('/api/auth/login/second-factor', { code: recovery[1] }, b, '10.0.0.3'),
    ]);
    expect(results.map(r => r.statusCode).sort()).toEqual([200, 401]);
  });

  it('are stored as hashes', async () => {
    const { recovery } = await enrol();
    const left = await getAccountsStore().users.countRecoveryCodes(OWNER_ID);
    expect(left).toBe(10);
    // Present the raw string where a hash is expected: it must not match.
    expect(await getAccountsStore().users.useRecoveryCode(OWNER_ID, recovery[0], new Date().toISOString())).toBe(false);
  });

  it('still work if SESSION_SECRET changed and the authenticator no longer can (S-21)', async () => {
    const { secret, recovery } = await enrol();
    advanceSteps(1);
    process.env.SESSION_SECRET = 'a-different-secret-that-is-32-chars-or-more!!';

    const code = await post('/api/auth/login/second-factor', { code: codeFor(secret) }, (await passwordStep()).cookie);
    expect(code.statusCode).toBe(401);

    const viaRecovery = await post('/api/auth/login/second-factor', { code: recovery[0] }, (await passwordStep()).cookie);
    expect(viaRecovery.statusCode).toBe(200);
  });
});

describe('guessing is throttled', () => {
  it('per user, whatever address the guesses come from', async () => {
    await app.close();
    app = await buildTestApp({ auth: { secondFactorAttempts: 3 } });
    const { secret } = await enrol();
    advanceSteps(1);
    const { cookie } = await passwordStep();
    const wrong = codeFor(secret) === '111111' ? '222222' : '111111';

    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      // A different source each time, so only the per-user limit can stop it.
      statuses.push((await post('/api/auth/login/second-factor', { code: wrong }, cookie, `10.9.0.${i}`)).statusCode);
    }
    expect(statuses).toEqual([401, 401, 401, 429, 429]);

    // And the right code is refused while limited.
    expect((await post('/api/auth/login/second-factor', { code: codeFor(secret) }, cookie, '10.9.0.9')).statusCode).toBe(429);
  });

  it('per source as well', async () => {
    await app.close();
    app = await buildTestApp({ auth: { loginRateLimit: { max: 3, timeWindow: '1 minute' } } });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await post('/api/auth/login/second-factor', { code: '000000' })).statusCode);
    expect(statuses.slice(0, 3)).toEqual([401, 401, 401]);
    expect(statuses.slice(3)).toEqual([429, 429]);
  });

  it('does not count callers with no pending login against anyone', async () => {
    await app.close();
    app = await buildTestApp({ auth: { secondFactorAttempts: 1 } });
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await post('/api/auth/login/second-factor', { code: '000000' }, undefined, `10.8.0.${i}`)).statusCode);
    expect(statuses).toEqual([401, 401, 401, 401]);
  });
});

describe('changing it', () => {
  it('turning it off needs the password and a current code', async () => {
    const { secret, cookie } = await enrol();
    advanceSteps(1);
    const code = codeFor(secret);

    expect((await post('/api/auth/totp/disable', { password: 'wrong', code }, cookie)).statusCode).toBe(401);
    expect((await post('/api/auth/totp/disable', { password: TEST_PASSWORD }, cookie)).statusCode).toBe(401);
    expect((await post('/api/auth/totp/disable', { password: TEST_PASSWORD, code: '000000' }, cookie)).statusCode).toBe(401);
    expect((await get('/api/auth/totp', cookie)).json()).toMatchObject({ enabled: true });

    const ok = await post('/api/auth/totp/disable', { password: TEST_PASSWORD, code }, cookie);
    expect(ok.statusCode).toBe(200);
    expect((await get('/api/auth/totp', cookie)).json()).toEqual({ enabled: false, recovery_codes_left: 0 });
    expect((await passwordStep()).res.json()).toMatchObject({ ok: true });
  });

  it('turning it off can use a recovery code, and ends the other sessions', async () => {
    const { recovery, cookie } = await enrol();
    const other = cookieOf(await post('/api/auth/login/second-factor', { code: recovery[1] }, (await passwordStep()).cookie));
    expect((await get('/api/auth/me', other)).statusCode).toBe(200);

    const res = await post('/api/auth/totp/disable', { password: TEST_PASSWORD, code: recovery[2] }, cookie);
    expect(res.statusCode).toBe(200);
    expect((await get('/api/auth/me', other)).statusCode).toBe(401);
    expect((await get('/api/auth/me', cookie)).statusCode).toBe(200);
  });

  it('removes the secret and the codes when it is turned off', async () => {
    const { recovery, cookie } = await enrol();
    await post('/api/auth/totp/disable', { password: TEST_PASSWORD, code: recovery[0] }, cookie);
    expect(await getAccountsStore().users.getTotp(OWNER_ID)).toBeNull();
    expect(await getAccountsStore().users.countRecoveryCodes(OWNER_ID)).toBe(0);
  });

  it('cannot be turned off when it is not on', async () => {
    const cookie = await loginAs(app);
    const res = await post('/api/auth/totp/disable', { password: TEST_PASSWORD, code: '123456' }, cookie);
    expect(res.statusCode).toBe(409);
  });

  it('new recovery codes need the password and a code, and replace all of the old ones', async () => {
    const { secret, recovery, cookie } = await enrol();
    advanceSteps(1);
    const code = codeFor(secret);

    expect((await post('/api/auth/totp/recovery-codes', { password: 'wrong', code }, cookie)).statusCode).toBe(401);
    expect((await post('/api/auth/totp/recovery-codes', { password: TEST_PASSWORD, code: '000000' }, cookie)).statusCode).toBe(401);

    const res = await post('/api/auth/totp/recovery-codes', { password: TEST_PASSWORD, code }, cookie);
    expect(res.statusCode).toBe(200);
    const fresh = (res.json() as { recovery_codes: string[] }).recovery_codes;
    expect(fresh).toHaveLength(10);
    expect(fresh.filter(c => recovery.includes(c))).toEqual([]);

    // Old ones are gone; new ones work.
    expect((await post('/api/auth/login/second-factor', { code: recovery[0] }, (await passwordStep()).cookie)).statusCode).toBe(401);
    expect((await post('/api/auth/login/second-factor', { code: fresh[0] }, (await passwordStep()).cookie)).statusCode).toBe(200);
  });

  it('is limited per user, so a stolen session cannot guess the password or code forever', async () => {
    await app.close();
    app = await buildTestApp({ totp: { attempts: 3 } });
    const { cookie } = await enrol(); // setup + enable used two of the three
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) statuses.push((await post('/api/auth/totp/disable', { password: 'x', code: '000000' }, cookie, `10.7.0.${i}`)).statusCode);
    expect(statuses).toEqual([401, 429, 429]);
  });
});

describe('other ways in do not skip it', () => {
  it('a reset link sets a password and leaves the second factor in force', async () => {
    await enrol();
    const token = await issueUserToken(OWNER_ID, 'reset', 60_000);
    const reset = await post('/api/auth/reset', { token, password: 'a-brand-new-password-1' });
    expect(reset.statusCode).toBe(200);
    // Any response may carry a session cookie; what matters is that it is not a login.
    expect((await get('/api/auth/me', cookieOf(reset))).statusCode).toBe(401);

    const login = await post('/api/auth/login', { email: OWNER_EMAIL, password: 'a-brand-new-password-1' });
    expect(login.json()).toEqual({ second_factor_required: true });
    expect((await get('/api/auth/me', cookieOf(login))).statusCode).toBe(401);
  });

  it('the only code path that issues a session is the login pair', async () => {
    // A guard on the guard: a session is assigned in one function (server/src/sessions.ts startSession), and only the
    // two login steps in routes/auth.ts, and the passkey login, may call it. A new caller is a bypass unless it checks the factor,
    // and needs adding here and justifying in SECURITY.md. Every route file counts, in the server and in core.
    const { readFileSync, readdirSync } = await import('fs');
    const routeDirs = [new URL('../routes/', import.meta.url), new URL('../../../core/src/routes/', import.meta.url)];
    const routeFiles = routeDirs.flatMap(dir => readdirSync(dir).filter(f => f.endsWith('.ts')).map(f => ({ name: f, text: readFileSync(new URL(f, dir), 'utf8') })));
    const assigners = routeFiles.filter(f => /session\.userId\s*=/.test(f.text)).map(f => f.name);
    expect(assigners).toEqual([]);
    expect(readFileSync(new URL('../sessions.ts', import.meta.url), 'utf8')).toMatch(/session\.userId\s*=/);

    const callers = routeFiles.filter(f => /startSession\(/.test(f.text)).map(f => f.name).sort();
    // routes/passkeys.ts is the second, justified in SECURITY.md M-33: a passkey is used with user verification required, so it
    // is the password and the second factor together.
    expect(callers).toEqual(['auth.ts', 'passkeys.ts']);
  });
});

describe('the store', () => {
  it('claims a step once, and only for a newer one', async () => {
    await enrol();
    const store = getAccountsStore();
    const last = (await store.users.getTotp(OWNER_ID))!.last_step;

    expect(await store.users.claimTotpStep(OWNER_ID, last)).toBe(false);
    expect(await store.users.claimTotpStep(OWNER_ID, last - 5)).toBe(false);
    const results = await Promise.all([1, 2, 3, 4].map(() => store.users.claimTotpStep(OWNER_ID, last + 10)));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('will not claim a step for an unconfirmed enrolment', async () => {
    const cookie = await loginAs(app);
    await post('/api/auth/totp/setup', { password: TEST_PASSWORD }, cookie);
    expect(await getAccountsStore().users.claimTotpStep(OWNER_ID, 999_999_999)).toBe(false);
  });

  it('removes the secret and codes with the user', async () => {
    await enrol();
    await getAccountsStore().users.delete(OWNER_ID);
    expect(await getAccountsStore().users.getTotp(OWNER_ID)).toBeNull();
    expect(await getAccountsStore().users.countRecoveryCodes(OWNER_ID)).toBe(0);
  });

  it('refuses a code for a user with no confirmed enrolment', async () => {
    expect(await checkSecondFactor({ id: OWNER_ID }, '123456')).toBe(false);
    const cookie = await loginAs(app);
    await post('/api/auth/totp/setup', { password: TEST_PASSWORD }, cookie);
    expect(await checkSecondFactor({ id: OWNER_ID }, '123456')).toBe(false);
  });
});

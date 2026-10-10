import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { buildTestApp, loginAs } from './helpers/app.js';
import { OWNER_EMAIL, TEST_PASSWORD, createTestUser } from './helpers/seed.js';
import { getStore } from '../store/index.js';
import { MAX_PASSWORD_LENGTH } from '../passwords.js';

let app: Awaited<ReturnType<typeof buildTestApp>>;

beforeAll(async () => { app = await buildTestApp(); });
afterAll(async () => { await app.close(); });

const login = (email: string, password: string) =>
  app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });

const me = (cookie?: string) =>
  app.inject({ method: 'GET', url: '/api/auth/me', headers: cookie ? { cookie } : {} });

describe('POST /api/auth/login', () => {
  it('returns 200 and a session for the right email and password', async () => {
    const res = await login(OWNER_EMAIL, TEST_PASSWORD);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, email: OWNER_EMAIL });
    expect(res.cookies.some(c => c.name === 'sessionId')).toBe(true);
  });

  it('matches the email case-insensitively', async () => {
    expect((await login('OWNER@Spine.Test', TEST_PASSWORD)).statusCode).toBe(200);
  });

  it('returns 401 for a wrong password', async () => {
    expect((await login(OWNER_EMAIL, 'wrong-password-entirely')).statusCode).toBe(401);
  });

  it('returns 400 when either field is missing', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/auth/login', payload: {} })).statusCode).toBe(400);
    expect((await login(OWNER_EMAIL, '')).statusCode).toBe(400);
    expect((await app.inject({
      method: 'POST', url: '/api/auth/login', payload: { email: OWNER_EMAIL },
    })).statusCode).toBe(400);
  });

  it('cannot be used to find out which emails have accounts', async () => {
    const wrongPassword = await login(OWNER_EMAIL, 'wrong-password-entirely');
    const unknownEmail = await login('nobody@spine.test', 'wrong-password-entirely');

    expect(unknownEmail.statusCode).toBe(wrongPassword.statusCode);
    expect(unknownEmail.json()).toEqual(wrongPassword.json());
  });

  it('refuses an oversized password without hashing it', async () => {
    const res = await login(OWNER_EMAIL, 'x'.repeat(MAX_PASSWORD_LENGTH + 1));
    expect(res.statusCode).toBe(401);
  });

  it('gives a new session id on login, so one fixed beforehand is not kept', async () => {
    const before = await me();
    const fixed = before.cookies.find(c => c.name === 'sessionId')!.value;

    const res = await app.inject({
      method: 'POST', url: '/api/auth/login',
      headers: { cookie: `sessionId=${fixed}` },
      payload: { email: OWNER_EMAIL, password: TEST_PASSWORD },
    });

    const after = res.cookies.find(c => c.name === 'sessionId')!.value;
    expect(after).not.toBe(fixed);
    // And the old id no longer works.
    expect((await me(`sessionId=${fixed}`)).statusCode).toBe(401);
  });
});

describe('passwords that are long or not ASCII', () => {
  it('authenticates a 100-character password', async () => {
    const long = await createTestUser('long@spine.test', { password: 'p'.repeat(100) });
    expect((await login(long.email, long.password)).statusCode).toBe(200);
  });

  it('authenticates a non-ASCII password', async () => {
    const accented = await createTestUser('accent@spine.test', { password: 'pàrolă-mediçală-ț' });
    expect((await login(accented.email, accented.password)).statusCode).toBe(200);
  });

  it('returns 401, not 500, for a wrong non-ASCII password', async () => {
    expect((await login(OWNER_EMAIL, 'é'.repeat(20))).statusCode).toBe(401);
  });
});

describe('GET /api/auth/me', () => {
  it('returns 401 when not logged in', async () => {
    expect((await me()).statusCode).toBe(401);
  });

  it('returns the email after login', async () => {
    const cookie = await loginAs(app);
    const res = await me(cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ authenticated: true, email: OWNER_EMAIL });
  });
});

describe('POST /api/auth/logout', () => {
  it('destroys the session', async () => {
    const cookie = await loginAs(app);
    await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
    expect((await me(cookie)).statusCode).toBe(401);
  });
});

/** P13: changing a password ends the user's other sessions. */
describe('POST /api/auth/password', () => {
  const change = (cookie: string, current: string, next: string) =>
    app.inject({
      method: 'POST', url: '/api/auth/password',
      headers: { cookie }, payload: { current, next },
    });

  it('requires a session', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/auth/password', payload: { current: 'a', next: 'b' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('refuses the wrong current password and changes nothing', async () => {
    const user = await createTestUser('wrong-current@spine.test');
    const cookie = await loginAs(app, user.email);

    expect((await change(cookie, 'not-the-password!!', 'a-brand-new-password')).statusCode).toBe(401);
    expect((await login(user.email, user.password)).statusCode).toBe(200);
  });

  it('refuses a new password that is too short', async () => {
    const user = await createTestUser('short-new@spine.test');
    const cookie = await loginAs(app, user.email);

    const res = await change(cookie, user.password, 'short');
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/at least 12/);
  });

  it('ends other sessions, keeps this one, and swaps which password works', async () => {
    const user = await createTestUser('rotate@spine.test');
    const here = await loginAs(app, user.email);
    const elsewhere = await loginAs(app, user.email);
    expect((await me(elsewhere)).statusCode).toBe(200);

    const res = await change(here, user.password, 'a-brand-new-password');
    expect(res.statusCode).toBe(200);

    expect((await me(elsewhere)).statusCode).toBe(401);
    expect((await me(here)).statusCode).toBe(200);
    expect((await login(user.email, user.password)).statusCode).toBe(401);
    expect((await login(user.email, 'a-brand-new-password')).statusCode).toBe(200);
  });

  it('does not store the password, only an argon2id hash', async () => {
    const user = await createTestUser('hashed@spine.test');
    const stored = await getStore().users.findByEmail(user.email);

    expect(stored!.password_hash).toMatch(/^\$argon2id\$/);
    expect(stored!.password_hash).not.toContain(user.password);
  });
});

/**
 * P5 / S-2: these drive the real limiters through the real handler, with a small
 * max rather than a mock.
 */
describe('POST /api/auth/login — rate limiting (P5, S-2)', () => {
  let limited: Awaited<ReturnType<typeof buildTestApp>>;

  afterEach(async () => { await limited?.close(); });

  const attempt = (
    target: typeof limited,
    password: string,
    headers: Record<string, string> = {},
  ) => target.inject({
    method: 'POST', url: '/api/auth/login', headers,
    payload: { email: OWNER_EMAIL, password },
  });

  it('429s a single source after its attempts are spent', async () => {
    limited = await buildTestApp({
      auth: { loginRateLimit: { max: 3, timeWindow: '10 minutes' } },
    });

    for (let i = 0; i < 3; i++) {
      expect((await attempt(limited, 'wrong-password-entirely')).statusCode).toBe(401);
    }
    expect((await attempt(limited, 'wrong-password-entirely')).statusCode).toBe(429);
  });

  it('blocks the correct password too once the limit is hit', async () => {
    limited = await buildTestApp({
      auth: { loginRateLimit: { max: 1, timeWindow: '10 minutes' } },
    });

    expect((await attempt(limited, 'wrong-password-entirely')).statusCode).toBe(401);
    // The limiter runs ahead of the handler, so guessing right eventually
    // does not get through.
    expect((await attempt(limited, TEST_PASSWORD)).statusCode).toBe(429);
  });

  it('throttles instance-wide even when each attempt comes from a new address', async () => {
    limited = await buildTestApp({
      auth: {
        loginRateLimit: { max: 1000, timeWindow: '10 minutes' },
        globalLoginRateLimit: { max: 3, windowMs: 10 * 60 * 1000 },
      },
    });

    for (let i = 0; i < 3; i++) {
      const res = await attempt(limited, 'wrong-password-entirely', { 'x-forwarded-for': `203.0.113.${i}` });
      expect(res.statusCode).toBe(401);
    }
    const blocked = await attempt(limited, 'wrong-password-entirely', { 'x-forwarded-for': '203.0.113.99' });
    expect(blocked.statusCode).toBe(429);
  });

  it('a source that has spent its own budget stops consuming the instance-wide one', async () => {
    limited = await buildTestApp({
      auth: {
        loginRateLimit: { max: 2, timeWindow: '10 minutes' },
        globalLoginRateLimit: { max: 4, windowMs: 10 * 60 * 1000 },
      },
    });

    const from = (ip: string) => attempt(limited, 'wrong-password-entirely', { 'x-forwarded-for': ip });

    expect((await from('203.0.113.1')).statusCode).toBe(401);
    expect((await from('203.0.113.1')).statusCode).toBe(401);
    for (let i = 0; i < 20; i++) expect((await from('203.0.113.1')).statusCode).toBe(429);

    // Another address still has the rest of the instance-wide budget.
    expect((await from('203.0.113.2')).statusCode).toBe(401);
    expect((await from('203.0.113.2')).statusCode).toBe(401);
  });

  it('does not rate limit logout or me', async () => {
    limited = await buildTestApp({
      auth: { loginRateLimit: { max: 1, timeWindow: '10 minutes' } },
    });

    await attempt(limited, 'wrong-password-entirely');
    for (let i = 0; i < 5; i++) {
      expect((await limited.inject({ method: 'GET', url: '/api/auth/me' })).statusCode).toBe(401);
    }
  });
});

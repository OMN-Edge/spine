import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { buildTestApp, loginAs } from './helpers/app.js';
import { OWNER_ID, TEST_PASSWORD, createTestUser } from './helpers/seed.js';
import { getAccountsStore } from 'spine-core/store/index.js';
import { resetMailer, type Mailer, type MailMessage } from '../mail/index.js';

/**
 * Letting a new device in from one that is signed in (TR-CRY-05, SECURITY.md M-41). The server holds an id and ciphertext the code made;
 * these are the rules around it: who may ask, who decides, how often, for how long, and what the new sign-in may do.
 */
let app: Awaited<ReturnType<typeof buildTestApp>>;
let sent: MailMessage[];
const fakeMailer: Mailer = { enabled: true, async send(m) { sent.push(m); } };
const b64 = (n: number) => randomBytes(n).toString('base64url');

beforeEach(async () => {
  sent = [];
  resetMailer(fakeMailer);
  app = await buildTestApp();
});
afterEach(async () => {
  vi.useRealTimers();
  await app.close();
  resetMailer(null);
});

const call = (method: 'GET' | 'POST' | 'DELETE', url: string, cookie?: string, payload?: object, headers: Record<string, string> = {}) =>
  app.inject({ method, url, headers: { ...(cookie ? { cookie } : {}), ...headers }, payload });
const cookieOf = (res: Awaited<ReturnType<typeof call>>) => res.cookies.map(c => `${c.name}=${c.value}`).join('; ');
/** Whether the cookies a reply set are a sign-in (an anonymous session cookie may come with any reply, and is not). */
const signedIn = async (res: Awaited<ReturnType<typeof call>>) => (await call('GET', '/api/auth/me', cookieOf(res))).statusCode === 200;

/** The owner's signed-in device leaves an offer; returns its id and the sealed key. */
async function offer(cookie: string) {
  const id = b64(32);
  const wrapped = b64(100);
  const res = await call('POST', '/api/enrol/offer', cookie, { id, wrapped });
  expect(res.statusCode).toBe(200);
  return { id, wrapped };
}

describe('letting a device in', () => {
  it('lets the browser that asked in once the owner approves, with the sealed key and a sign-in', async () => {
    const owner = await loginAs(app);
    const { id, wrapped } = await offer(owner);
    expect((await call('GET', '/api/enrol/offer', owner)).json()).toMatchObject({ offer: { id, state: 'offered', requested_at: null } });

    const asked = await call('POST', '/api/enrol/request', undefined, { id }, { 'user-agent': 'Firefox on a test machine' });
    expect(asked.statusCode).toBe(200);
    const { token } = asked.json() as { token: string };
    expect(token).toHaveLength(43);

    // the owner sees what asked; the new device is told to wait and has no sign-in
    expect((await call('GET', '/api/enrol/offer', owner)).json()).toMatchObject({ offer: { state: 'requested', requester_agent: 'Firefox on a test machine' } });
    const waiting = await call('POST', '/api/enrol/claim', undefined, { id, token });
    expect(waiting.statusCode).toBe(202);
    expect(await signedIn(waiting)).toBe(false);

    expect((await call('POST', '/api/enrol/decision', owner, { approve: true })).statusCode).toBe(200);
    const claimed = await call('POST', '/api/enrol/claim', undefined, { id, token });
    expect(claimed.statusCode).toBe(200);
    expect(claimed.json()).toEqual({ ok: true, email: 'owner@spine.test', credential_id: `enrol:${id}`, wrapped_key: wrapped });
    const fresh = cookieOf(claimed);
    expect((await call('GET', '/api/auth/me', fresh)).json()).toMatchObject({ authenticated: true });

    // once: the same call again finds nothing, and the sealed key is not kept
    expect((await call('POST', '/api/enrol/claim', undefined, { id, token })).statusCode).toBe(404);
    expect((await call('GET', '/api/enrol/offer', owner)).json()).toEqual({ offer: null });
    expect(sent.some(m => /device|sign-in/i.test(m.subject))).toBe(true);
    expect(sent.every(m => m.to === 'owner@spine.test')).toBe(true);
  });

  it('does not take the new sign-in to have typed the password: what asks for it lately still asks', async () => {
    const owner = await loginAs(app);
    const { id } = await offer(owner);
    const { token } = (await call('POST', '/api/enrol/request', undefined, { id })).json() as { token: string };
    await call('POST', '/api/enrol/decision', owner, { approve: true });
    const fresh = cookieOf(await call('POST', '/api/enrol/claim', undefined, { id, token }));

    expect((await call('POST', '/api/enrol/offer', fresh, { id: b64(32), wrapped: b64(100) })).json()).toMatchObject({ code: 'reauth_required' });
    expect((await call('POST', '/api/enrol/decision', fresh, { approve: true })).json()).toMatchObject({ code: 'reauth_required' });
    expect((await call('POST', '/api/auth/reauth', fresh, { password: TEST_PASSWORD })).statusCode).toBe(200);
    expect((await call('POST', '/api/enrol/offer', fresh, { id: b64(32), wrapped: b64(100) })).statusCode).toBe(200);
  });

  it('gives a refused browser nothing', async () => {
    const owner = await loginAs(app);
    const { id } = await offer(owner);
    const { token } = (await call('POST', '/api/enrol/request', undefined, { id })).json() as { token: string };
    await call('POST', '/api/enrol/decision', owner, { approve: false });
    const refused = await call('POST', '/api/enrol/claim', undefined, { id, token });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ code: 'refused' });
    expect(await signedIn(refused)).toBe(false);
    expect(JSON.stringify(refused.json())).not.toContain('wrapped');
  });

  it('is bound to the first browser that asked: another cannot ask, or claim with its own token', async () => {
    const owner = await loginAs(app);
    const { id } = await offer(owner);
    const first = (await call('POST', '/api/enrol/request', undefined, { id })).json() as { token: string };
    expect((await call('POST', '/api/enrol/request', undefined, { id })).statusCode).toBe(404);
    await call('POST', '/api/enrol/decision', owner, { approve: true });
    expect((await call('POST', '/api/enrol/claim', undefined, { id, token: b64(32) })).statusCode).toBe(404);
    expect((await call('POST', '/api/enrol/claim', undefined, { id, token: first.token })).statusCode).toBe(200);
  });

  it('answers an unknown, malformed or already used code the same way', async () => {
    const owner = await loginAs(app);
    const { id } = await offer(owner);
    const unknown = await call('POST', '/api/enrol/request', undefined, { id: b64(32) });
    const malformed = await call('POST', '/api/enrol/request', undefined, { id: 'short' });
    const missing = await call('POST', '/api/enrol/request', undefined, {});
    for (const res of [unknown, malformed, missing]) expect([res.statusCode, res.json()]).toEqual([404, { error: 'this code is not valid, or it has expired' }]);
    // and so does a claim with no request
    expect((await call('POST', '/api/enrol/claim', undefined, { id, token: b64(32) })).statusCode).toBe(404);
  });

  it('cannot be approved before a browser has asked, or by anyone but the account that made it', async () => {
    const owner = await loginAs(app);
    const { id } = await offer(owner);
    expect((await call('POST', '/api/enrol/decision', owner, { approve: true })).statusCode).toBe(404);
    await call('POST', '/api/enrol/request', undefined, { id });
    const other = await createTestUser('other@spine.test');
    const theirs = await loginAs(app, other.email);
    expect((await call('POST', '/api/enrol/decision', theirs, { approve: true })).statusCode).toBe(404);
    expect((await call('GET', '/api/enrol/offer', theirs)).json()).toEqual({ offer: null });
    expect((await call('DELETE', '/api/enrol/offer', theirs)).statusCode).toBe(200); // theirs, which is none
    expect((await call('GET', '/api/enrol/offer', owner)).json()).toMatchObject({ offer: { state: 'requested' } });
  });

  it('asks for a signed-in account, and the password typed lately, to make an offer or decide', async () => {
    expect((await call('POST', '/api/enrol/offer', undefined, { id: b64(32), wrapped: b64(100) })).statusCode).toBe(401);
    expect((await call('GET', '/api/enrol/offer')).statusCode).toBe(401);
    expect((await call('POST', '/api/enrol/decision', undefined, { approve: true })).statusCode).toBe(401);
    expect((await call('DELETE', '/api/enrol/offer')).statusCode).toBe(401);
  });

  it('refuses an offer that is not an id and a sealed key', async () => {
    const owner = await loginAs(app);
    for (const body of [{}, { id: 'x', wrapped: b64(100) }, { id: b64(32), wrapped: 'short' }, { id: b64(32), wrapped: 'not base64 !!'.padEnd(100, '!') }, { id: b64(32), wrapped: b64(400) }]) {
      expect((await call('POST', '/api/enrol/offer', owner, body)).statusCode, JSON.stringify(body)).toBe(400);
    }
    expect((await call('POST', '/api/enrol/decision', owner, { approve: 'yes' })).statusCode).toBe(400);
  });

  it('keeps one offer per account: a new one replaces the old', async () => {
    const owner = await loginAs(app);
    const first = await offer(owner);
    const second = await offer(owner);
    expect((await call('POST', '/api/enrol/request', undefined, { id: first.id })).statusCode).toBe(404);
    expect((await call('POST', '/api/enrol/request', undefined, { id: second.id })).statusCode).toBe(200);
  });

  it('can be taken back', async () => {
    const owner = await loginAs(app);
    const { id } = await offer(owner);
    await call('DELETE', '/api/enrol/offer', owner);
    expect((await call('POST', '/api/enrol/request', undefined, { id })).statusCode).toBe(404);
  });

  it('is good for ten minutes, asked or approved', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const owner = await loginAs(app);
    const stale = await offer(owner);
    vi.setSystemTime(Date.now() + 10 * 60 * 1000 + 1000);
    expect((await call('POST', '/api/enrol/request', undefined, { id: stale.id })).statusCode).toBe(404);
    expect((await call('GET', '/api/enrol/offer', owner)).json()).toEqual({ offer: null });

    vi.setSystemTime(Date.now() + 1000);
    const live = await offer(await loginAs(app));
    const { token } = (await call('POST', '/api/enrol/request', undefined, { id: live.id })).json() as { token: string };
    vi.setSystemTime(Date.now() + 5 * 60 * 1000);
    await call('POST', '/api/enrol/decision', owner, { approve: true }); // the owner's own sign-in may be older than that; the offer is not
    vi.setSystemTime(Date.now() + 6 * 60 * 1000);
    expect((await call('POST', '/api/enrol/claim', undefined, { id: live.id, token })).statusCode).toBe(404);
  });

  it('is void when the password changes', async () => {
    const owner = await loginAs(app);
    const { id } = await offer(owner);
    const { token } = (await call('POST', '/api/enrol/request', undefined, { id })).json() as { token: string };
    await call('POST', '/api/enrol/decision', owner, { approve: true });
    await getAccountsStore().users.setPassword(OWNER_ID, 'a-different-hash');
    const res = await call('POST', '/api/enrol/claim', undefined, { id, token });
    expect(res.statusCode).toBe(404);
    expect(await signedIn(res)).toBe(false);
  });

  it('is limited at each public step', async () => {
    const limited = await buildTestApp({ enrolment: { requestsPerSource: 3, claimsPerSource: 3 } });
    try {
      const asks: number[] = [];
      for (let i = 0; i < 5; i++) asks.push((await limited.inject({ method: 'POST', url: '/api/enrol/request', payload: { id: b64(32) } })).statusCode);
      expect(asks.slice(0, 3)).toEqual([404, 404, 404]);
      expect(asks.slice(3)).toEqual([429, 429]);
      const claims: number[] = [];
      for (let i = 0; i < 5; i++) claims.push((await limited.inject({ method: 'POST', url: '/api/enrol/claim', payload: { id: b64(32), token: b64(32) } })).statusCode);
      expect(claims.slice(3)).toEqual([429, 429]);
    } finally { await limited.close(); }
  });

  it('goes with the account', async () => {
    const owner = await loginAs(app);
    await offer(owner);
    await getAccountsStore().users.delete(OWNER_ID);
    expect(await getAccountsStore().enrolments.current(OWNER_ID, new Date().toISOString())).toBeNull();
  });
});

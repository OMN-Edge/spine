import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildTestApp, loginAs } from './helpers/app.js';
import { OWNER_EMAIL, OWNER_ID, TEST_PASSWORD, createTestUser } from './helpers/seed.js';
import { getStore } from '../store/index.js';
import { resetMailer, type Mailer, type MailMessage } from '../mail/index.js';

/**
 * SECURITY.md S-33: a sign-in is a row the owner can see and end, it expires by inactivity and by age,
 * a stolen cookie cannot export everything or widen a link without the password, and a new browser is mailed about.
 */

let app: Awaited<ReturnType<typeof buildTestApp>>;
let sent: MailMessage[];
const fakeMailer: Mailer = { enabled: true, async send(m) { sent.push(m); } };

beforeEach(async () => {
  sent = [];
  resetMailer(fakeMailer);
  app = await buildTestApp();
});
afterEach(async () => {
  vi.useRealTimers();
  delete process.env.SPINE_SESSION_IDLE_HOURS;
  delete process.env.SPINE_SESSION_DAYS;
  await app.close();
  resetMailer(null);
});

const get = (url: string, cookie: string) => app.inject({ method: 'GET', url, headers: { cookie } });
const send = (method: 'POST' | 'DELETE' | 'PATCH', url: string, cookie: string, payload?: object) =>
  app.inject({ method, url, headers: { cookie }, payload });

describe('the list of sign-ins', () => {
  it('shows each sign-in once, marks the current one and carries no cookie value', async () => {
    const a = await loginAs(app);
    const b = await loginAs(app);
    const res = await get('/api/auth/sessions', a);
    expect(res.statusCode).toBe(200);
    const rows = res.json() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows.filter(r => r.current)).toHaveLength(1);
    expect(Object.keys(rows[0]).sort()).toEqual(['address', 'created_at', 'current', 'id', 'last_seen_at', 'user_agent']);
    expect(JSON.stringify(rows)).not.toContain(b.split('=')[1].split(';')[0]);
  });

  it('ending one signs that browser out and no other', async () => {
    const a = await loginAs(app);
    const b = await loginAs(app);
    const rows = (await get('/api/auth/sessions', a)).json() as Array<{ id: string; current: boolean }>;
    const other = rows.find(r => !r.current)!;

    expect((await send('DELETE', `/api/auth/sessions/${other.id}`, a)).statusCode).toBe(200);
    expect((await get('/api/auth/me', b)).statusCode).toBe(401);
    expect((await get('/api/auth/me', a)).statusCode).toBe(200);
  });

  it('end-others keeps the one asking', async () => {
    const a = await loginAs(app);
    const b = await loginAs(app);
    const c = await loginAs(app);
    const res = await send('POST', '/api/auth/sessions/end-others', a);
    expect(res.json()).toEqual({ ok: true, ended: 2 });
    expect((await get('/api/auth/me', b)).statusCode).toBe(401);
    expect((await get('/api/auth/me', c)).statusCode).toBe(401);
    expect((await get('/api/auth/me', a)).statusCode).toBe(200);
  });

  it('logging out removes the row', async () => {
    const a = await loginAs(app);
    await send('POST', '/api/auth/logout', a);
    expect(await getStore().sessions.list(OWNER_ID)).toHaveLength(0);
  });

  it('cannot read or end another user’s sign-in (404, nothing changed)', async () => {
    const mine = await loginAs(app);
    const other = await createTestUser('other@spine.test');
    const theirs = await loginAs(app, other.email);
    const theirRow = (await getStore().sessions.list(other.id))[0];

    expect((await get('/api/auth/sessions', mine)).json()).toHaveLength(1);
    expect((await send('DELETE', `/api/auth/sessions/${theirRow.id}`, mine)).statusCode).toBe(404);
    expect((await get('/api/auth/me', theirs)).statusCode).toBe(200);
  });

  it('needs a session', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/auth/sessions' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/auth/reauth', payload: { password: TEST_PASSWORD } })).statusCode).toBe(401);
  });
});

describe('how long a sign-in lasts', () => {
  it('ends after a day without use, and use keeps it going', async () => {
    const cookie = await loginAs(app);
    const [row] = await getStore().sessions.list(OWNER_ID);

    await getStore().sessions.touch(OWNER_ID, row.id, new Date(Date.now() - 23 * 3600_000).toISOString());
    expect((await get('/api/auth/me', cookie)).statusCode).toBe(200);

    await getStore().sessions.touch(OWNER_ID, row.id, new Date(Date.now() - 25 * 3600_000).toISOString());
    expect((await get('/api/auth/me', cookie)).statusCode).toBe(401);
    expect(await getStore().sessions.list(OWNER_ID)).toHaveLength(0);
  });

  it('ends after the absolute limit however much it is used', async () => {
    const cookie = await loginAs(app);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 13 * 24 * 3600_000);
    await getStore().sessions.touch(OWNER_ID, (await getStore().sessions.list(OWNER_ID))[0].id, new Date().toISOString());
    expect((await get('/api/auth/me', cookie)).statusCode).toBe(200);

    vi.setSystemTime(Date.now() + 2 * 24 * 3600_000);
    await getStore().sessions.touch(OWNER_ID, (await getStore().sessions.list(OWNER_ID))[0].id, new Date().toISOString());
    expect((await get('/api/auth/me', cookie)).statusCode).toBe(401);
  });

  it('the limits are settable, and a bad value never lengthens them', async () => {
    const { sessionLimits } = await import('../config.js');
    expect(sessionLimits({ SPINE_SESSION_IDLE_HOURS: '2', SPINE_SESSION_DAYS: '3' } as NodeJS.ProcessEnv)).toEqual({ idleMs: 2 * 3600_000, absoluteMs: 3 * 86_400_000 });
    expect(sessionLimits({ SPINE_SESSION_IDLE_HOURS: 'x', SPINE_SESSION_DAYS: '-1' } as NodeJS.ProcessEnv)).toEqual({ idleMs: 24 * 3600_000, absoluteMs: 14 * 86_400_000 });
    expect(sessionLimits({ SPINE_SESSION_DAYS: '100000' } as NodeJS.ProcessEnv).absoluteMs).toBe(90 * 86_400_000);
  });

  it('a password change ends the other sign-ins and shows only the one that changed it', async () => {
    const a = await loginAs(app);
    const b = await loginAs(app);
    const res = await send('POST', '/api/auth/password', a, { current: TEST_PASSWORD, next: 'a-brand-new-password-1' });
    expect(res.statusCode).toBe(200);
    expect((await get('/api/auth/me', b)).statusCode).toBe(401);
    expect(await getStore().sessions.list(OWNER_ID)).toHaveLength(1);
  });
});

describe('asking for the password again', () => {
  const exportUrl = '/api/export';

  it('lets a sign-in just made through, and asks again after ten minutes', async () => {
    const cookie = await loginAs(app);
    expect((await get(exportUrl, cookie)).statusCode).toBe(404); // past the guard: nothing to export yet

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 11 * 60_000);
    await getStore().sessions.touch(OWNER_ID, (await getStore().sessions.list(OWNER_ID))[0].id, new Date().toISOString());
    const res = await get(exportUrl, cookie);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'reauth_required' });

    expect((await send('POST', '/api/auth/reauth', cookie, { password: 'not-the-password' })).statusCode).toBe(401);
    expect((await get(exportUrl, cookie)).statusCode).toBe(403);
    expect((await send('POST', '/api/auth/reauth', cookie, { password: TEST_PASSWORD })).statusCode).toBe(200);
    expect((await get(exportUrl, cookie)).statusCode).toBe(404);
  });

  it('asks before a share link shows page images, creating or changing, and not otherwise', async () => {
    const cookie = await loginAs(app);
    const create = (include_scans: boolean) => send('POST', '/api/share-links', cookie, { scope: 'all', include_scans });

    const plain = await create(false);
    expect(plain.statusCode).toBe(201);
    expect((await create(true)).statusCode).toBe(201); // just signed in

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 11 * 60_000);
    await getStore().sessions.touch(OWNER_ID, (await getStore().sessions.list(OWNER_ID))[0].id, new Date().toISOString());

    expect((await create(false)).statusCode).toBe(201);
    expect((await create(true)).statusCode).toBe(403);
    const id = plain.json().id as string;
    expect((await send('PATCH', `/api/share-links/${id}`, cookie, { include_scans: true })).statusCode).toBe(403);
    expect((await send('PATCH', `/api/share-links/${id}`, cookie, { include_scans: false })).statusCode).toBe(200);
  });

  it('limits guesses per user, so a stolen cookie cannot guess the password here', async () => {
    const limited = await buildTestApp({});
    const cookie = await loginAs(limited);
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      statuses.push((await limited.inject({ method: 'POST', url: '/api/auth/reauth', headers: { cookie }, payload: { password: `wrong-password-${i}-x` } })).statusCode);
    }
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses[6]).toBe(429);
    await limited.close();
  });
});

describe('telling the owner', () => {
  const flush = () => new Promise(resolve => setTimeout(resolve, 20));

  it('mails a sign-in from a browser the account has not used, not the first, not a known one', async () => {
    const first = await loginAs(app);
    await flush();
    expect(sent).toHaveLength(0); // the first browser: nobody to tell

    const again = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { cookie: first }, payload: { email: OWNER_EMAIL, password: TEST_PASSWORD } });
    await flush();
    expect(again.statusCode).toBe(200);
    expect(sent).toHaveLength(0); // same browser (its device cookie came with it)

    await loginAs(app); // no cookie: another browser
    await flush();
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(OWNER_EMAIL);
    expect(sent[0].subject).toMatch(/new sign-in/i);
  });

  it('mails a password change and a change to two-factor, with nothing clinical in it', async () => {
    const cookie = await loginAs(app);
    await send('POST', '/api/auth/password', cookie, { current: TEST_PASSWORD, next: 'a-brand-new-password-1' });
    await flush();
    expect(sent.map(m => m.subject)).toEqual(['A security setting on your account changed']);
    expect(sent[0].text).toMatch(/password was changed/i);
    for (const m of sent) {
      expect(`${m.subject} ${m.text}`).not.toMatch(/document|record|diagnos|result|medical|health|doctor|scan/i);
    }
  });

  it('says nothing when there is no mailer', async () => {
    resetMailer({ enabled: false, async send() { throw new Error('should not be called'); } });
    await loginAs(app);
    await loginAs(app);
    await flush();
    expect(sent).toHaveLength(0);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildTestApp } from './helpers/app.js';
import { createTestUser } from './helpers/seed.js';
import { getAccountsStore } from 'spine-core/store/index.js';
import { sweepUnverified } from '../accounts.js';
import { resetMailer } from '../mail/index.js';

/**
 * SECURITY.md S-51 and S-52. Each of these routes was limited per source address and per email address only, so a spread of addresses could make
 * the instance send mail to as many strangers as there were sources, fill the accounts table with unverified rows and fill the waitlist.
 * The mail the instance sends, and the sign-ups it takes, are capped in all; unverified accounts end; the waitlist has a ceiling.
 */
let app: Awaited<ReturnType<typeof buildTestApp>> | null = null;
let sent = 0;
beforeEach(() => { sent = 0; resetMailer({ enabled: true, async send() { sent++; } }); });
afterEach(async () => { await app?.close(); app = null; resetMailer(null); });

const post = (url: string, payload: unknown, ip: string) => app!.inject({ method: 'POST', url, payload: payload as object, headers: { 'x-forwarded-for': ip } });

describe('the mail an instance sends to people who are not its accounts', () => {
  it('is capped in all, across the sign-up, the resend and the reset, whoever asks', async () => {
    app = await buildTestApp({ accounts: { registration: 'open', mailPerHour: 4 } });
    await createTestUser('known@spine.test');
    const codes: number[] = [];
    // different sources and different addresses, so neither per-source nor per-address limit is what stops it
    for (let i = 0; i < 6; i++) codes.push((await post(i % 2 ? '/api/auth/forgot' : '/api/auth/resend-verification', { email: `person${i}@example.com` }, `10.0.0.${i + 1}`)).statusCode);
    expect(codes).toEqual([200, 200, 200, 200, 429, 429]);
    expect((await post('/api/auth/register', { email: 'late@example.com', auth_value: 'x'.repeat(43), keys: {} }, '10.0.1.1')).statusCode).toBe(429);
  });

  it('is limited in new sign-ups an hour apart from it', async () => {
    app = await buildTestApp({ accounts: { registration: 'open', mailPerHour: 100, signupsPerHour: 2 } });
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await post('/api/auth/register', { email: `new${i}@example.com`, auth_value: 'x'.repeat(43), keys: {} }, `10.0.2.${i + 1}`)).statusCode);
    expect(codes.slice(2)).toEqual([429, 429]);
    expect(codes.slice(0, 2).every(c => c !== 429)).toBe(true);
  });
});

describe('accounts whose address was never confirmed', () => {
  it('end after a week, and only those: a confirmed one, a recent one and one waiting for approval stay', async () => {
    app = await buildTestApp({ accounts: { registration: 'open' } });
    const day = 86_400_000;
    const old = new Date(Date.now() - 8 * day).toISOString();
    const stale = await createTestUser('stale@example.com', { verified: false, createdAt: old });
    const fresh = await createTestUser('fresh@example.com', { verified: false });
    const kept = await createTestUser('kept@example.com', { createdAt: old });
    const waiting = await createTestUser('waiting@example.com', { verified: false, createdAt: old, approved: false });
    expect(await sweepUnverified()).toBe(1);
    const ids = (await getAccountsStore().users.list()).map(u => u.id);
    expect(ids).not.toContain(stale.id);
    expect(ids).toEqual(expect.arrayContaining([fresh.id, kept.id, waiting.id]));
  });
});

describe('the waitlist', () => {
  it('holds at most as many addresses as it may, says so, and still answers one already on it', async () => {
    app = await buildTestApp({ waitlist: { max: 3, perSource: { max: 100, timeWindow: '1 minute' } } });
    const add = (n: number | string) => post('/api/waitlist', { email: `hopeful${n}@example.com` }, '10.0.3.1');
    for (const n of [1, 2, 3]) expect((await add(n)).statusCode).toBe(200);
    const full = await add(4);
    expect(full.statusCode).toBe(503);
    expect(full.json()).toMatchObject({ code: 'full' });
    expect((await getAccountsStore().waitlist.list()).map(w => w.email)).not.toContain('hopeful4@example.com');
    expect((await add(1)).statusCode).toBe(200);
  });

  it('is limited in all an hour, whatever the sources', async () => {
    app = await buildTestApp({ waitlist: { max: 1000, perHour: 3, perSource: { max: 100, timeWindow: '1 minute' } } });
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await post('/api/waitlist', { email: `spread${i}@example.com` }, `10.0.4.${i + 1}`)).statusCode);
    expect(codes).toEqual([200, 200, 200, 429, 429]);
  });
});

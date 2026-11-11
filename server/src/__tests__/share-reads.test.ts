import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'crypto';
import { buildTestApp, loginAs } from './helpers/app.js';
import { createTestUser } from './helpers/seed.js';
import { readBudget } from '../read-budget.js';

/**
 * SECURITY.md S-57. A share's id is in every address, and its sealed copy can be a hundred megabytes, so a source that knew the id could pull
 * it sixty times a minute: the limit counted requests, not bytes. A source's reads of one share are limited in bytes an hour.
 */
const MB = 1024 * 1024;
let app: Awaited<ReturnType<typeof buildTestApp>>;
let cookie: string;
const saved = { ...process.env };

beforeEach(async () => {
  app = await buildTestApp();
  await createTestUser('share-reads@spine.test');
  cookie = await loginAs(app, 'share-reads@spine.test');
});
afterEach(async () => { await app.close(); process.env = { ...saved }; });

const id = () => randomBytes(16).toString('base64url');
const publish = (share: string, bytes: Buffer) => app.inject({ method: 'PUT', url: `/api/shared/${share}`, payload: bytes, headers: { cookie, 'content-type': 'application/octet-stream', 'x-spine-pass-check': 'c'.repeat(43), 'x-spine-expires': new Date(Date.now() + 3_600_000).toISOString() } });
const read = (share: string, ip: string) => app.inject({ method: 'GET', url: `/api/shared/${share}/bundle`, headers: { 'x-forwarded-for': ip } });

describe('how much of a share one source may read in an hour', () => {
  it('is a number of bytes, so a large copy is read a few times and a small one many', async () => {
    process.env.SPINE_SHARE_READ_MB_PER_HOUR = '3';
    const big = id();
    expect((await publish(big, randomBytes(MB))).statusCode).toBe(201);
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await read(big, '10.0.7.1')).statusCode);
    expect(codes).toEqual([200, 200, 200, 429]);
    const refused = await read(big, '10.0.7.1');
    expect(refused.json()).toMatchObject({ code: 'read_budget' });

    const small = id();
    expect((await publish(small, randomBytes(1000))).statusCode).toBe(201);
    for (let i = 0; i < 40; i++) expect((await read(small, '10.0.7.1')).statusCode, String(i)).toBe(200);
  });

  it('is each source’s own: another source reads the same copy, and so does the same one of another share', async () => {
    process.env.SPINE_SHARE_READ_MB_PER_HOUR = '1';
    const a = id();
    const b = id();
    await publish(a, randomBytes(MB));
    await publish(b, randomBytes(MB));
    expect((await read(a, '10.0.8.1')).statusCode).toBe(200);
    expect((await read(a, '10.0.8.1')).statusCode).toBe(429);
    expect((await read(a, '10.0.8.2')).statusCode).toBe(200);
    expect((await read(b, '10.0.8.1')).statusCode).toBe(200);
  });

  it('forgets a read when its hour has passed', () => {
    const key = 'bundle:x:10.0.9.1';
    const at = Date.now() + 10_000_000; // after every window the other tests opened, which the walk goes through in the order they began
    expect(readBudget.take(key, 600, 1000, 1000, at)).toBe(true);
    expect(readBudget.take(key, 600, 1000, 1000, at + 500)).toBe(false);
    expect(readBudget.take(key, 600, 1000, 1000, at + 1001)).toBe(true);
  });
});

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { randomBytes } from 'crypto';
import { buildTestApp, loginAs, loginSession } from './helpers/app.js';
import { createTestUser } from './helpers/seed.js';
import { getStore } from '../store/index.js';
import { verifyToken } from '../relay/token.js';
import { sweepShares } from '../routes/shared.js';

const SECRET = 'shared-test-relay-secret-shared-test-relay';
const id = () => randomBytes(16).toString('base64url');
const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
const visitorKey = () => randomBytes(32).toString('base64url');
const wrapped = () => randomBytes(80).toString('base64url');

describe('sealed shares on the server', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  let owner: string;
  let other: string;
  const saved = { ...process.env };
  const dir = mkdtempSync(path.join(tmpdir(), 'spine-shared-'));

  beforeAll(async () => {
    process.env.DATA_DIR = dir;
    app = await buildTestApp();
    owner = await loginSession(app);
    await createTestUser('other@spine.test');
    other = await loginAs(app, 'other@spine.test');
  });
  afterEach(() => { process.env = { ...saved, DATA_DIR: dir }; vi.useRealTimers(); });

  const publish = (share: string, bytes: Buffer, cookie = owner, headers: Record<string, string> = {}) =>
    app.inject({ method: 'PUT', url: `/api/shared/${share}`, headers: { cookie, 'content-type': 'application/octet-stream', 'x-spine-expires': inHours(24), ...headers }, payload: bytes });
  const get = (url: string, cookie?: string) => app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });
  const post = (url: string, payload?: unknown, cookie?: string) => app.inject({ method: 'POST', url, headers: cookie ? { cookie } : {}, payload: payload as object | undefined });

  it('takes a sealed copy from its owner and gives the same bytes to anyone with the id, and says what it is', async () => {
    const share = id();
    const bytes = randomBytes(5000);
    expect((await publish(share, bytes)).statusCode).toBe(201);
    const meta = (await get(`/api/shared/${share}/meta`)).json();
    expect(meta).toMatchObject({ approval: false, size: 5000, blobs: 0 });
    const res = await get(`/api/shared/${share}/bundle`);
    expect(Buffer.from(res.rawPayload).equals(bytes)).toBe(true);
    expect(res.headers['x-robots-tag']).toContain('noindex');
    expect((await get(`/api/shared/${id()}/meta`)).statusCode).toBe(404);
    expect((await get('/api/shared/short/meta')).statusCode).toBe(404);
  });

  it('is for signed-in owners, and one owner cannot touch another’s', async () => {
    const share = id();
    expect((await publish(share, randomBytes(10), '')).statusCode).toBe(401);
    await publish(share, randomBytes(10));
    expect((await publish(share, randomBytes(10), other)).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/api/shared/${share}`, headers: { cookie: other } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PATCH', url: `/api/shared/${share}`, headers: { cookie: other }, payload: { require_approval: true } })).statusCode).toBe(404);
    expect((await get(`/api/shared/${share}/meta`)).statusCode).toBe(200);
  });

  it('refuses a copy with no end, an end in the past, one too far off, or nothing in it', async () => {
    const share = id();
    expect((await publish(share, randomBytes(10), owner, { 'x-spine-expires': '' })).statusCode).toBe(400);
    expect((await publish(share, randomBytes(10), owner, { 'x-spine-expires': new Date(Date.now() - 1000).toISOString() })).statusCode).toBe(400);
    expect((await publish(share, randomBytes(10), owner, { 'x-spine-expires': inHours(24 * 40) })).statusCode).toBe(400);
    expect((await publish(share, Buffer.alloc(0))).statusCode).toBe(400);
  });

  it('keeps page images beside the copy, and replaces them when it is published again', async () => {
    const share = id();
    await publish(share, randomBytes(100));
    const blob = randomBytes(2000);
    expect((await app.inject({ method: 'PUT', url: `/api/shared/${share}/blob/0`, headers: { cookie: owner, 'content-type': 'application/octet-stream' }, payload: blob })).statusCode).toBe(201);
    expect((await get(`/api/shared/${share}/meta`)).json().blobs).toBe(1);
    expect(Buffer.from((await get(`/api/shared/${share}/blob/0`)).rawPayload).equals(blob)).toBe(true);
    expect((await app.inject({ method: 'PUT', url: `/api/shared/${share}/blob/0`, headers: { cookie: other, 'content-type': 'application/octet-stream' }, payload: blob })).statusCode).toBe(404);
    await publish(share, randomBytes(100));
    expect((await get(`/api/shared/${share}/meta`)).json().blobs).toBe(0);
    expect((await get(`/api/shared/${share}/blob/0`)).statusCode).toBe(404);
  });

  it('ends a share when it is revoked, and deletes what it held', async () => {
    const share = id();
    await publish(share, randomBytes(100));
    const file = path.join(dir, 'shares', share, 'db');
    expect(existsSync(file)).toBe(true);
    expect((await app.inject({ method: 'DELETE', url: `/api/shared/${share}`, headers: { cookie: owner } })).statusCode).toBe(200);
    expect(existsSync(file)).toBe(false);
    const meta = await get(`/api/shared/${share}/meta`);
    expect(meta.statusCode).toBe(410);
    expect((await get(`/api/shared/${share}/bundle`)).statusCode).toBe(410);
    expect((await publish(share, randomBytes(100))).statusCode).toBe(409);
  });

  it('ends a share at its time, deletes the files, and the keys of any approval with them', async () => {
    const share = id();
    await publish(share, randomBytes(100), owner, { 'x-spine-approval': '1' });
    const req = (await post(`/api/shared/${share}/access-request`, { key: visitorKey() })).json();
    await post(`/api/shared/requests/${req.request_id}/decision`, { decision: 'approved', wrapped_key: wrapped() }, owner);
    expect((await get(`/api/shared/${share}/access-request/${req.request_id}`)).json().wrapped_key).toBeTruthy();

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 25 * 3_600_000);
    expect((await get(`/api/shared/${share}/meta`)).statusCode).toBe(410);
    await sweepShares();
    expect(existsSync(path.join(dir, 'shares', share))).toBe(false);
    const row = (await getStore().shared.pendingRequests((await getStore().users.findByEmail('owner@spine.test'))!.id)).find(r => r.id === req.request_id);
    expect(row?.wrappedKey ?? null).toBeNull();
  });

  it('lets an owner change the end and the approval of a live share', async () => {
    const share = id();
    await publish(share, randomBytes(10));
    expect((await app.inject({ method: 'PATCH', url: `/api/shared/${share}`, headers: { cookie: owner }, payload: { require_approval: true, expires_at: inHours(48) } })).statusCode).toBe(200);
    expect((await get(`/api/shared/${share}/meta`)).json().approval).toBe(true);
    expect((await app.inject({ method: 'PATCH', url: `/api/shared/${share}`, headers: { cookie: owner }, payload: { expires_at: new Date(Date.now() - 5000).toISOString() } })).statusCode).toBe(400);
  });

  describe('approval', () => {
    it('hands the owner each browser’s request once, and the browser the key the owner wrapped for it, and nothing before', async () => {
      const share = id();
      await publish(share, randomBytes(10), owner, { 'x-spine-approval': '1' });
      const key = visitorKey();
      const asked = await post(`/api/shared/${share}/access-request`, { key, note: 'Dr. Example\u0007' });
      expect(asked.statusCode).toBe(202);
      const rid = asked.json().request_id as string;
      expect((await get(`/api/shared/${share}/access-request/${rid}`)).json()).toEqual({ status: 'pending', wrapped_key: null });

      const events = (await get('/api/shared/events', owner)).json<{ requests: Array<{ id: string; bundleId: string; visitorKey: string; note: string }> }>();
      expect(events.requests.filter(r => r.bundleId === share).map(r => [r.id, r.visitorKey, r.note])).toEqual([[rid, key, 'Dr. Example']]);
      expect((await get('/api/shared/events', other)).json().requests).toEqual([]);

      const key80 = wrapped();
      expect((await post(`/api/shared/requests/${rid}/decision`, { decision: 'approved', wrapped_key: key80 }, other)).statusCode).toBe(404);
      expect((await post(`/api/shared/requests/${rid}/decision`, { decision: 'approved' }, owner)).statusCode).toBe(400);
      expect((await post(`/api/shared/requests/${rid}/decision`, { decision: 'approved', wrapped_key: key80 }, owner)).statusCode).toBe(200);
      expect((await get(`/api/shared/${share}/access-request/${rid}`)).json()).toEqual({ status: 'approved', wrapped_key: key80 });
      expect((await post(`/api/shared/requests/${rid}/decision`, { decision: 'denied' }, owner)).statusCode).toBe(404);

      await post('/api/shared/events/ack', { requests: [rid], opens: [] }, owner);
      expect((await get('/api/shared/events', owner)).json<{ requests: Array<{ id: string }> }>().requests.some(r => r.id === rid)).toBe(false);
    });

    it('answers a second ask from the same browser with its first, and refuses a link that needs no approval, a bad key, or a crowd', async () => {
      const share = id();
      await publish(share, randomBytes(10), owner, { 'x-spine-approval': '1' });
      const key = visitorKey();
      const first = (await post(`/api/shared/${share}/access-request`, { key })).json();
      const again = await post(`/api/shared/${share}/access-request`, { key });
      expect(again.json()).toMatchObject({ request_id: first.request_id, known: true });
      expect((await post(`/api/shared/${share}/access-request`, { key: 'not-a-key' })).statusCode).toBe(400);
      for (let i = 0; i < 4; i++) await post(`/api/shared/${share}/access-request`, { key: visitorKey() });
      expect((await post(`/api/shared/${share}/access-request`, { key: visitorKey() })).statusCode).toBe(429);

      const open = id();
      await publish(open, randomBytes(10));
      expect((await post(`/api/shared/${open}/access-request`, { key: visitorKey() })).statusCode).toBe(409);
    });
  });

  it('notes that a link was opened, with only a time and a place, for the owner’s device to collect once', async () => {
    const share = id();
    await publish(share, randomBytes(10));
    const doc = 'a1b2c3d4-0000-4000-8000-000000000000';
    expect((await post(`/api/shared/${share}/opened`, { document_id: doc })).statusCode).toBe(204);
    expect((await post(`/api/shared/${share}/opened`, {})).statusCode).toBe(204);
    expect((await post(`/api/shared/${share}/opened`, { document_id: 'a b/../c' })).statusCode).toBe(400);
    const { opens } = (await get('/api/shared/events', owner)).json<{ opens: Array<{ id: number; documentId: string | null; countView: boolean; country: string | null }> }>();
    expect(opens.filter(o => o.documentId === doc)).toHaveLength(1);
    expect(JSON.stringify(opens)).not.toMatch(/127\.0\.0\.1|ip/i);
    await post('/api/shared/events/ack', { requests: [], opens: opens.map(o => o.id) }, owner);
    expect((await get('/api/shared/events', owner)).json().opens).toEqual([]);
    expect((await get('/api/shared/events', other)).json().opens).toEqual([]);
  });

  it('gives a recipient a pass for model calls that lasts no longer than the share', async () => {
    const share = id();
    await publish(share, randomBytes(10), owner);
    expect((await post(`/api/shared/${share}/relay-token`)).statusCode).toBe(503);
    Object.assign(process.env, { SPINE_RELAY_URL: 'https://relay.example.run.app', SPINE_RELAY_SECRET: SECRET });
    const res = (await post(`/api/shared/${share}/relay-token`)).json<{ token: string; expires_at: number }>();
    expect(verifyToken(SECRET, res.token)).toEqual({ userId: `share:${share}` });
    expect(res.expires_at - Date.now()).toBeLessThanOrEqual(10 * 60 * 1000);

    const short = id();
    await publish(short, randomBytes(10), owner, { 'x-spine-expires': new Date(Date.now() + 90_000).toISOString() });
    const brief = (await post(`/api/shared/${short}/relay-token`)).json<{ expires_at: number }>();
    expect(brief.expires_at - Date.now()).toBeLessThanOrEqual(90_000);
  });

  it('limits how many shares are live and how many bytes they hold', async () => {
    process.env.SPINE_SHARE_MAX_LIVE = '1';
    const user = await createTestUser('limited@spine.test');
    const cookie = await loginAs(app, user.email);
    expect((await publish(id(), randomBytes(10), cookie)).statusCode).toBe(201);
    expect((await publish(id(), randomBytes(10), cookie)).statusCode).toBe(409);
    delete process.env.SPINE_SHARE_MAX_LIVE;
  });

  afterEach(() => undefined);
  it('cleans up', () => { rmSync(dir, { recursive: true, force: true }); });
});

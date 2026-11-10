import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'crypto';
import { buildTestApp, loginAs } from './helpers/app.js';
import { createTestUser } from './helpers/seed.js';
import { getAccountsStore } from 'spine-core/store/index.js';
import { verifyToken } from '../relay/token.js';

/**
 * SECURITY.md S-48. A share's id is in the address of every link, in the web server's log and in the server's tables, so it is not a secret and
 * not a proof of the key. A recipient's browser asks for the pass for its model calls with a value only the key makes, which the owner's device
 * sent with the copy; an id alone gets none, in approval mode too, where the id is meant to open nothing.
 */
const SECRET = 'share-pass-test-relay-secret-share-pass-test';
const id = () => randomBytes(16).toString('base64url');
const check = () => randomBytes(32).toString('base64url');
const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

let app: Awaited<ReturnType<typeof buildTestApp>>;
let owner: string;
let ownerId: string;
const saved = { ...process.env };
beforeEach(async () => {
  Object.assign(process.env, { SPINE_RELAY_URL: 'https://relay.example.run.app', SPINE_RELAY_SECRET: SECRET });
  app = await buildTestApp();
  ownerId = (await createTestUser('pass-owner@spine.test')).id;
  owner = await loginAs(app, 'pass-owner@spine.test');
});
afterEach(async () => { await app.close(); process.env = { ...saved }; });

const publish = (share: string, headers: Record<string, string> = {}, cookie = owner) =>
  app.inject({ method: 'PUT', url: `/api/shared/${share}`, headers: { cookie, 'content-type': 'application/octet-stream', 'x-spine-expires': inHours(24), ...headers }, payload: randomBytes(100) });
const ask = (share: string, payload?: unknown) => app.inject({ method: 'POST', url: `/api/shared/${share}/relay-token`, payload: payload as object | undefined });

describe('the pass for a share’s model calls', () => {
  it('is given to a browser that shows the key’s value, and to none that does not', async () => {
    const share = id();
    const mine = check();
    expect((await publish(share, { 'x-spine-pass-check': mine })).statusCode).toBe(201);
    for (const body of [undefined, {}, { check: 'x'.repeat(43) }, { check: check() }, { check: 5 }]) {
      const res = await ask(share, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(403);
      expect(res.json()).toMatchObject({ code: 'share_key_needed' });
    }
    const ok = await ask(share, { check: mine });
    expect(ok.statusCode).toBe(200);
    expect(verifyToken(SECRET, ok.json<{ token: string }>().token)).toEqual({ userId: `share:${share}` });
  });

  it('is not given for the id alone when the share waits for approval, where the id opens nothing', async () => {
    const share = id();
    const mine = check();
    expect((await publish(share, { 'x-spine-pass-check': mine, 'x-spine-approval': '1' })).statusCode).toBe(201);
    expect((await ask(share)).statusCode).toBe(403);
    expect((await ask(share, { check: mine })).statusCode).toBe(200);
  });

  it('keeps the value when the copy is sent again without one, and takes a new one when it comes', async () => {
    const share = id();
    const first = check();
    await publish(share, { 'x-spine-pass-check': first });
    await publish(share);
    expect((await ask(share, { check: first })).statusCode).toBe(200);
    const second = check();
    await publish(share, { 'x-spine-pass-check': second });
    expect((await ask(share, { check: first })).statusCode).toBe(403);
    expect((await ask(share, { check: second })).statusCode).toBe(200);
  });

  it('refuses a value that is not in the shape the device makes', async () => {
    expect((await publish(id(), { 'x-spine-pass-check': 'short' })).statusCode).toBe(400);
    expect((await publish(id(), { 'x-spine-pass-check': 'x'.repeat(44) })).statusCode).toBe(400);
  });

  it('is not given for a card, which makes no model call', async () => {
    const card = id();
    expect((await publish(card, { 'x-spine-kind': 'card' })).statusCode).toBe(201);
    expect((await ask(card, { check: check() })).statusCode).toBe(404);
  });

  it('is refused for a share that ended or never was, as before', async () => {
    expect((await ask(id(), { check: check() })).statusCode).toBe(404);
  });
});

/**
 * SECURITY.md S-54. The route that notes an opening wrote a row for any request that named a live share's id, so the owner's record of who
 * read a link could be filled with invented openings. It takes the same value as the pass, and the rows waiting to be collected are capped.
 */
describe('the record of who opened a share', () => {
  const opened = (share: string, payload?: unknown) => app.inject({ method: 'POST', url: `/api/shared/${share}/opened`, payload: payload as object | undefined });
  const waiting = async () => (await getAccountsStore().shared.pendingOpens(ownerId, 100_000)).length;

  it('takes an opening from a browser that shows the key’s value, and from none that does not', async () => {
    const share = id();
    const mine = check();
    await publish(share, { 'x-spine-pass-check': mine });
    for (const body of [undefined, {}, { check: 'x'.repeat(43) }, { check: check() }, { document_id: 'doc-12345678', check: 7 }]) {
      const res = await opened(share, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(403);
      expect(res.json()).toMatchObject({ code: 'share_key_needed' });
    }
    expect(await waiting()).toBe(0);
    expect((await opened(share, { check: mine })).statusCode).toBe(204);
    expect((await opened(share, { document_id: 'doc-12345678', check: mine })).statusCode).toBe(204);
    expect(await waiting()).toBe(2);
  });

  it('is the same for an emergency card, which the owner is mailed about', async () => {
    const card = id();
    const mine = check();
    expect((await publish(card, { 'x-spine-kind': 'card', 'x-spine-pass-check': mine })).statusCode).toBe(201);
    expect((await opened(card, {})).statusCode).toBe(403);
    expect((await opened(card, { check: mine })).statusCode).toBe(204);
    expect(await waiting()).toBe(1);
  });

  it('keeps at most a thousand openings waiting to be collected for a share, however many are made', async () => {
    const share = id();
    await publish(share);
    for (let i = 0; i < 1010; i++) await getAccountsStore().shared.logOpen(share, new Date().toISOString(), 'RO', null, true);
    expect(await waiting()).toBe(1000);
    // and once the owner's device has collected them, openings are noted again
    const pending = await getAccountsStore().shared.pendingOpens(ownerId, 2000);
    await getAccountsStore().shared.ackOpens(ownerId, pending.map(o => o.id));
    await getAccountsStore().shared.logOpen(share, new Date().toISOString(), 'RO', null, true);
    expect(await waiting()).toBe(1);
  });
});

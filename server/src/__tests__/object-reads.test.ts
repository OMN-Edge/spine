import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'crypto';
import { buildTestApp, loginAs } from './helpers/app.js';
import { createTestUser } from './helpers/seed.js';
import { fakeAuthValue, fakeVaultKeys } from 'spine-core/testing/vault.js';
import { readSlots } from '../read-slots.js';

/**
 * SECURITY.md S-58. A sealed object was read whole into memory for each request, reads had no limit, and an account could hold any number of
 * objects. Reads are streamed, the reads in flight for one account (or one source of a share) are limited, and an account holds a bounded number.
 */
const EMAIL = 'reads@spine.test';
const ID = 'user-object-reads';
let app: Awaited<ReturnType<typeof buildTestApp>>;
let cookie: string;
const saved = { ...process.env };

beforeEach(async () => {
  app = await buildTestApp({ accounts: { registration: 'open' } });
  await createTestUser(EMAIL, { id: ID });
  cookie = await loginAs(app, EMAIL);
  const keys = fakeVaultKeys();
  expect((await app.inject({ method: 'PUT', url: '/api/vault/keys', payload: { auth_value: fakeAuthValue(), keys } as object, headers: { cookie } })).statusCode).toBe(200);
});
afterEach(async () => { await app.close(); process.env = { ...saved }; });

const headers = (base = 0) => ({ cookie, 'content-type': 'application/octet-stream', 'x-spine-kind': 'bundle', 'x-spine-profile': 'profile-0001', 'x-spine-wrapped-key': fakeVaultKeys().wrapped_by_master, 'x-spine-base-seq': String(base) });
const put = (id: string, bytes: Buffer, base = 0) => app.inject({ method: 'PUT', url: `/api/vault/objects/${id}`, payload: bytes, headers: headers(base) });
const get = (id: string) => app.inject({ method: 'GET', url: `/api/vault/objects/${id}`, headers: { cookie } });

describe('reading a sealed object', () => {
  it('answers the same bytes, with their length, from a stream', async () => {
    const bytes = randomBytes(200_000);
    expect((await put('object-0001', bytes)).statusCode).toBe(200);
    const res = await get('object-0001');
    expect(res.statusCode).toBe(200);
    expect(Buffer.from(res.rawPayload).equals(bytes)).toBe(true);
    expect(res.headers['content-length']).toBe(String(bytes.length));
    expect(res.headers['x-spine-kind']).toBe('bundle');
  });

  it('is refused while the account already has as many reads open as it may', async () => {
    await put('object-0001', randomBytes(100));
    const held = readSlots.acquireAll(`vault:${ID}`);
    expect(held).toBeGreaterThan(0);
    const refused = await get('object-0001');
    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toMatchObject({ code: 'too_many_reads' });
    readSlots.releaseAll(`vault:${ID}`, held);
    expect((await get('object-0001')).statusCode).toBe(200);
  });

  it('gives its slot back when the read ends, so a hundred reads in turn all succeed', async () => {
    await put('object-0001', randomBytes(100));
    for (let i = 0; i < 100; i++) expect((await get('object-0001')).statusCode, String(i)).toBe(200);
  });
});

describe('how many objects an account holds', () => {
  it('is bounded, new ones refused past the bound and an existing one still replaced', async () => {
    process.env.SPINE_VAULT_MAX_OBJECTS = '3';
    for (const n of [1, 2, 3]) expect((await put(`object-000${n}`, randomBytes(10))).statusCode, String(n)).toBe(200);
    const over = await put('object-0004', randomBytes(10));
    expect(over.statusCode).toBe(413);
    expect(over.json()).toMatchObject({ code: 'full' });
    // an object already there may still be written again, naming the sequence number it last saw
    const first = await get('object-0001');
    expect((await put('object-0001', randomBytes(12), Number(first.headers['x-spine-seq']))).statusCode).toBe(200);
    // and a removed object makes room
    const second = await get('object-0002');
    expect((await app.inject({ method: 'DELETE', url: `/api/vault/objects/object-0002?base=${second.headers['x-spine-seq']}`, headers: { cookie } })).statusCode).toBe(200);
    expect((await put('object-0004', randomBytes(10))).statusCode).toBe(200);
  });
});

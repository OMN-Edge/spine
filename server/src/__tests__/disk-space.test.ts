import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'crypto';
import { buildTestApp, loginAs } from './helpers/app.js';
import { createTestUser } from './helpers/seed.js';
import { fakeAuthValue, fakeVaultKeys } from 'spine-core/testing/vault.js';
import { disk, minFreeBytes, quotaWarning, spaceFor } from '../disk-space.js';

/**
 * SECURITY.md S-56. Every account may hold gigabytes and nothing bounded all of them together, so accounts made in numbers could fill the disk
 * behind `data/`, after which every save, the accounts database and the daily snapshot failed. Writes are refused while the free space is
 * below a reserve, and the server says at start when a quota could not be honoured for a handful of accounts.
 */
const MB = 1024 * 1024;
const EMAIL = 'space@spine.test';
let app: Awaited<ReturnType<typeof buildTestApp>>;
let cookie: string;
const saved = { ...process.env };
const realFree = disk.free;

beforeEach(async () => {
  app = await buildTestApp({ accounts: { registration: 'open' } });
  await createTestUser(EMAIL, { id: 'user-disk-space' });
  cookie = await loginAs(app, EMAIL);
  expect((await app.inject({ method: 'PUT', url: '/api/vault/keys', payload: { auth_value: fakeAuthValue(), keys: fakeVaultKeys() } as object, headers: { cookie } })).statusCode).toBe(200);
});
afterEach(async () => { disk.free = realFree; await app.close(); process.env = { ...saved }; });

const put = (id: string, bytes: Buffer) => app.inject({ method: 'PUT', url: `/api/vault/objects/${id}`, payload: bytes, headers: { cookie, 'content-type': 'application/octet-stream', 'x-spine-kind': 'bundle', 'x-spine-profile': 'profile-0001', 'x-spine-wrapped-key': fakeVaultKeys().wrapped_by_master, 'x-spine-base-seq': '0' } });

describe('the reserve of free space', () => {
  it('is a gigabyte unless the operator sets it, and a bad value gives that', () => {
    expect(minFreeBytes({})).toBe(1024 * MB);
    expect(minFreeBytes({ SPINE_MIN_FREE_MB: '200' })).toBe(200 * MB);
    expect(minFreeBytes({ SPINE_MIN_FREE_MB: 'lots' })).toBe(1024 * MB);
    expect(minFreeBytes({ SPINE_MIN_FREE_MB: '0' })).toBe(0);
  });

  it('is kept: a write that would leave less is refused, one that leaves more goes through', async () => {
    process.env.SPINE_MIN_FREE_MB = '100';
    disk.free = () => 100 * MB + 1000;
    expect(await spaceFor(500)).toBe(true);
    expect(await spaceFor(2000)).toBe(false);
  });

  it('turns a vault write away with a code the device can wait on, and writes again once there is room', async () => {
    process.env.SPINE_MIN_FREE_MB = '100';
    disk.free = () => 50 * MB;
    const refused = await put('object-0001', randomBytes(100));
    expect(refused.statusCode).toBe(507);
    expect(refused.json()).toMatchObject({ code: 'storage_low' });
    disk.free = () => 500 * MB;
    expect((await put('object-0001', randomBytes(100))).statusCode).toBe(200);
  });

  it('turns away a share’s copy, a card and a page image the same way', async () => {
    process.env.SPINE_MIN_FREE_MB = '100';
    disk.free = () => 50 * MB;
    const share = randomBytes(16).toString('base64url');
    const copy = (id: string, extra: Record<string, string> = {}) => app.inject({ method: 'PUT', url: `/api/shared/${id}`, payload: randomBytes(100), headers: { cookie, 'content-type': 'application/octet-stream', 'x-spine-expires': new Date(Date.now() + 3_600_000).toISOString(), ...extra } });
    expect((await copy(share)).json()).toMatchObject({ code: 'storage_low' });
    expect((await copy(randomBytes(16).toString('base64url'), { 'x-spine-kind': 'card' })).statusCode).toBe(507);
    disk.free = () => 500 * MB;
    expect((await copy(share)).statusCode).toBe(201);
    disk.free = () => 50 * MB;
    expect((await app.inject({ method: 'PUT', url: `/api/shared/${share}/blob/page-one`, payload: randomBytes(50), headers: { cookie, 'content-type': 'application/octet-stream' } })).statusCode).toBe(507);
  });

  it('is not asked of a store that is not on this disk', async () => {
    process.env.SPINE_MIN_FREE_MB = '100';
    disk.free = () => null;
    expect(await spaceFor(10_000_000)).toBe(true);
  });
});

describe('the warning at start', () => {
  it('says so when ten accounts at the quota would not fit, and not when they would', () => {
    expect(quotaWarning(20_000 * MB, 5120 * MB)).toMatch(/SPINE_VAULT_MAX_MB/);
    expect(quotaWarning(200_000 * MB, 5120 * MB)).toBeNull();
    expect(quotaWarning(null, 5120 * MB)).toBeNull();
  });
});

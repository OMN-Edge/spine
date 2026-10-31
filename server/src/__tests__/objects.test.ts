import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createObjects, useObjects, objects, OBJECT_ADAPTERS } from '../objects/index.js';
import { createFilesystemObjects } from '../objects/filesystem.js';
import { createGcsObjects } from '../objects/gcs.js';
import { ObjectsConfigError, type ObjectStore } from '../objects/types.js';
import { buildTestApp, loginSession } from './helpers/app.js';
import { fakeAuthValue, fakeVaultKeys } from 'spine-core/testing/vault.js';

/** A bucket in memory that answers the JSON API the adapter speaks, so the adapter's requests are what is checked. */
function fakeBucket(bucketName: string) {
  const objectsHeld = new Map<string, Buffer>();
  const calls: Array<{ method: string; url: string; auth: string | null }> = [];
  let failNext: Array<number | 'network'> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    calls.push({ method, url: String(input), auth: (init?.headers as Record<string, string>)?.authorization ?? null });
    const fail = failNext.shift();
    if (fail === 'network') throw new Error('socket hang up');
    if (typeof fail === 'number') return new Response('nope', { status: fail });
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url.pathname === `/upload/storage/v1/b/${bucketName}/o` && method === 'POST') {
      objectsHeld.set(url.searchParams.get('name')!, Buffer.from(init!.body as Buffer));
      return json({ name: url.searchParams.get('name') });
    }
    const one = new RegExp(`^/storage/v1/b/${bucketName}/o/(.+)$`).exec(url.pathname);
    if (one) {
      const name = decodeURIComponent(one[1]);
      if (method === 'GET') return objectsHeld.has(name) ? new Response(new Uint8Array(objectsHeld.get(name)!)) : json({ error: 'not found' }, 404);
      if (method === 'DELETE') return objectsHeld.delete(name) ? new Response(null, { status: 204 }) : json({ error: 'not found' }, 404);
    }
    if (url.pathname === `/storage/v1/b/${bucketName}/o` && method === 'GET') {
      const prefix = url.searchParams.get('prefix') ?? '';
      const all = [...objectsHeld.keys()].filter(k => k.startsWith(prefix)).sort();
      const from = Number(url.searchParams.get('pageToken') ?? 0);
      const page = all.slice(from, from + 2); // two to a page, so paging is exercised
      return json({ items: page.map(name => ({ name })), nextPageToken: from + 2 < all.length ? String(from + 2) : undefined });
    }
    return json({ error: 'unexpected' }, 400);
  }) as typeof fetch;
  return { fetchImpl, objectsHeld, calls, failNext: (...codes: Array<number | 'network'>) => { failNext = codes; } };
}

const bytes = (text: string) => Buffer.from(text);

/** What every object store must do; run once for each adapter, so a third is finished when this passes for it. */
function describeObjectStore(name: string, make: () => { store: ObjectStore; cleanup?: () => void }) {
  describe(`the object store contract: ${name}`, () => {
    let store: ObjectStore;
    let cleanup: (() => void) | undefined;
    beforeEach(() => { ({ store, cleanup } = make()); });
    afterEach(() => cleanup?.());

    it('keeps what it is given and answers null for what it has not', async () => {
      expect(await store.get('vault/u1/object-0001')).toBeNull();
      await store.put('vault/u1/object-0001', bytes('sealed'));
      expect((await store.get('vault/u1/object-0001'))?.toString()).toBe('sealed');
    });

    it('replaces an object whole', async () => {
      await store.put('shares/s1/db', bytes('first'));
      await store.put('shares/s1/db', bytes('second, longer'));
      expect((await store.get('shares/s1/db'))?.toString()).toBe('second, longer');
    });

    it('removes one object, and removing what is not there is not an error', async () => {
      await store.put('vault/u1/a', bytes('1'));
      await store.remove('vault/u1/a');
      await store.remove('vault/u1/a');
      expect(await store.get('vault/u1/a')).toBeNull();
    });

    it('lists by prefix, across pages, within a directory by the start of a name', async () => {
      for (const key of ['shares/s1/db', 'shares/s1/blob-0', 'shares/s1/blob-1', 'shares/s1/blob-2', 'shares/s2/blob-0']) await store.put(key, bytes('x'));
      expect((await store.list('shares/s1/blob-')).sort()).toEqual(['shares/s1/blob-0', 'shares/s1/blob-1', 'shares/s1/blob-2']);
      expect((await store.list('shares/s1/')).sort()).toEqual(['shares/s1/blob-0', 'shares/s1/blob-1', 'shares/s1/blob-2', 'shares/s1/db']);
      expect(await store.list('shares/none/')).toEqual([]);
    });

    it('removes everything under a prefix and nothing beside it', async () => {
      await store.put('vault/u1/a', bytes('1'));
      await store.put('vault/u1/b', bytes('2'));
      await store.put('vault/u10/a', bytes('3'));
      await store.removeAll('vault/u1/');
      expect(await store.get('vault/u1/a')).toBeNull();
      expect(await store.get('vault/u1/b')).toBeNull();
      expect((await store.get('vault/u10/a'))?.toString()).toBe('3');
      await expect(store.removeAll('vault/u1')).rejects.toThrow(/invalid/);
    });

    it('refuses a key that could reach outside its place', async () => {
      for (const key of ['../x', 'vault/../../x', '/etc/passwd', 'vault//a', 'vault/a b', '', 'a/./b']) {
        await expect(store.put(key, bytes('x')), key).rejects.toThrow(/invalid/);
        await expect(store.get(key), key).rejects.toThrow(/invalid/);
      }
      await expect(store.list('../')).rejects.toThrow(/invalid/);
    });
  });
}

let dir: string;
describeObjectStore('filesystem', () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-objects-'));
  return { store: createFilesystemObjects(() => dir), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
});
describeObjectStore('gcs', () => ({ store: createGcsObjects({ bucket: 'spine-test', credentials: { headers: async () => ({ authorization: 'Bearer t' }) }, fetchImpl: fakeBucket('spine-test').fetchImpl, retryDelaysMs: [] }) }));

describe('the filesystem adapter', () => {
  it('leaves no half-written file where a reader looks', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-objects-'));
    const store = createFilesystemObjects(() => root);
    await store.put('vault/u1/a', bytes('whole'));
    expect(fs.readdirSync(path.join(root, 'vault', 'u1'))).toEqual(['a']);
    fs.writeFileSync(path.join(root, 'vault', 'u1', 'a.1234.part'), 'half');
    expect(await store.list('vault/u1/')).toEqual(['vault/u1/a']);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('the bucket adapter', () => {
  const credentials = { headers: async () => ({ authorization: 'Bearer token-1' }) };

  it('speaks the JSON API with the process’s own credentials, under its prefix', async () => {
    const bucket = fakeBucket('spine-eu');
    const store = createGcsObjects({ bucket: 'spine-eu', prefix: 'staging/', credentials, fetchImpl: bucket.fetchImpl, retryDelaysMs: [] });
    await store.put('vault/u1/a', bytes('x'));
    expect([...bucket.objectsHeld.keys()]).toEqual(['staging/vault/u1/a']);
    expect(await store.list('vault/')).toEqual(['vault/u1/a']);
    expect(bucket.calls.every(c => c.auth === 'Bearer token-1' && c.url.startsWith('https://storage.googleapis.com/'))).toBe(true);
    expect(bucket.calls[0].url).toContain('uploadType=media&name=staging%2Fvault%2Fu1%2Fa');
  });

  it('tries again after a server error, a rate limit or a dropped connection, and then gives up in words', async () => {
    const bucket = fakeBucket('spine-eu');
    const store = createGcsObjects({ bucket: 'spine-eu', credentials, fetchImpl: bucket.fetchImpl, retryDelaysMs: [0, 0, 0] });
    bucket.failNext(503, 429, 'network');
    await store.put('shares/s1/db', bytes('ok'));
    expect(bucket.objectsHeld.get('shares/s1/db')?.toString()).toBe('ok');
    bucket.failNext(500, 500, 500, 500);
    await expect(store.get('shares/s1/db')).rejects.toThrow(/answered 500/);
  });

  it('does not take a refusal for a missing object', async () => {
    const bucket = fakeBucket('spine-eu');
    const store = createGcsObjects({ bucket: 'spine-eu', credentials, fetchImpl: bucket.fetchImpl, retryDelaysMs: [] });
    bucket.failNext(403);
    await expect(store.get('vault/u1/a')).rejects.toThrow(/answered 403/);
    bucket.failNext(401);
    await expect(store.put('vault/u1/a', bytes('x'))).rejects.toThrow(/answered 401/);
  });

  it('refuses a name that is not a bucket', () => {
    expect(() => createGcsObjects({ bucket: 'No Such Bucket!' })).toThrow(ObjectsConfigError);
  });
});

describe('choosing the store', () => {
  it('is files unless the environment says a bucket, and says what is missing', () => {
    expect(createObjects({}).kind).toBe('filesystem');
    expect(createObjects({ SPINE_OBJECTS: 'gcs', SPINE_GCS_BUCKET: 'spine-eu' }).kind).toBe('gcs');
    expect(() => createObjects({ SPINE_OBJECTS: 'gcs' })).toThrow(/SPINE_GCS_BUCKET/);
    expect(() => createObjects({ SPINE_OBJECTS: 's3' })).toThrow(new RegExp(OBJECT_ADAPTERS.join(', ')));
  });

  it('fails at first use, in words, in a process that did not choose one (S3)', () => {
    useObjects(null);
    expect(() => objects()).toThrow(/useObjects/);
    useObjects(() => createObjects());
  });
});

describe('when the bucket cannot be written', () => {
  it('takes the object’s row back and says so, so the device refetches instead of finding an object that cannot be read', async () => {
    const failing: ObjectStore = { ...createFilesystemObjects(() => os.tmpdir()), kind: 'failing', put: async () => { throw new Error('the object store answered 503'); } };
    useObjects(() => failing);
    try {
      const app = await buildTestApp();
      const cookie = await loginSession(app);
      await app.inject({ method: 'PUT', url: '/api/vault/keys', headers: { cookie }, payload: { auth_value: fakeAuthValue(), keys: fakeVaultKeys() } });
      const put = await app.inject({
        method: 'PUT', url: '/api/vault/objects/object-0001', headers: { cookie, 'content-type': 'application/octet-stream', 'x-spine-profile': 'profile-0001', 'x-spine-kind': 'bundle', 'x-spine-wrapped-key': 'k'.repeat(100), 'x-spine-base-seq': '0' },
        payload: Buffer.from('sealed'),
      });
      expect(put.statusCode).toBe(503);
      expect(put.json().code).toBe('storage');
      const listed = await app.inject({ method: 'GET', url: '/api/vault/objects', headers: { cookie } });
      expect(listed.json().objects.every((o: { deleted: boolean }) => o.deleted)).toBe(true);
      await app.close();
    } finally {
      useObjects(() => createObjects());
    }
  });
});

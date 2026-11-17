import { createServer, type Server } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { refreshCountryFile, updateGeoip, updateGeoipInBucket } from '../geoip-update.js';
import { countryKey } from '../geo.js';
import type { ObjectStore } from '../objects/index.js';

let server: Server;
let base: string;
let answer: { status: number; body: Buffer };
let dir: string;
let file: string;

beforeAll(async () => {
  server = createServer((_req, res) => { res.writeHead(answer.status); res.end(answer.body); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/country.mmdb`;
});
afterAll(() => new Promise<void>(r => server.close(() => r())));
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-geoip-'));
  file = path.join(dir, 'geoip', 'country.mmdb');
  answer = { status: 200, body: Buffer.alloc(1_500_000, 7) };
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const accept = async () => {};
const leftovers = () => fs.existsSync(path.dirname(file)) ? fs.readdirSync(path.dirname(file)).filter(f => f.endsWith('.part')) : [];

describe('updateGeoip', () => {
  it('writes the downloaded file where it is read, making the folder, and leaves no partial file', async () => {
    expect(await updateGeoip({ url: base, file, check: accept })).toBe(1_500_000);
    expect(fs.readFileSync(file).equals(answer.body)).toBe(true);
    expect(leftovers()).toEqual([]);
  });

  it('replaces the file it had', async () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'old');
    await updateGeoip({ url: base, file, check: accept });
    expect(fs.statSync(file).size).toBe(1_500_000);
  });

  it('keeps the file it had when the new one fails its check', async () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'old');
    await expect(updateGeoip({ url: base, file, check: async () => { throw new Error('no country'); } })).rejects.toThrow('no country');
    expect(fs.readFileSync(file, 'utf8')).toBe('old');
    expect(leftovers()).toEqual([]);
  });

  it('refuses something that is not a country database, by the check it runs itself', async () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'old');
    await expect(updateGeoip({ url: base, file })).rejects.toThrow();
    expect(fs.readFileSync(file, 'utf8')).toBe('old');
    expect(leftovers()).toEqual([]);
  });

  it('refuses an answer that is not a success, or is far too small', async () => {
    answer = { status: 404, body: Buffer.from('not found') };
    await expect(updateGeoip({ url: base, file, check: accept })).rejects.toThrow('404');
    answer = { status: 200, body: Buffer.from('tiny') };
    await expect(updateGeoip({ url: base, file, check: accept })).rejects.toThrow('smaller than expected');
    expect(fs.existsSync(file)).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it('downloads only over https, or from this machine', async () => {
    for (const url of ['http://example.com/c.mmdb', 'ftp://example.com/c.mmdb', 'file:///etc/passwd', 'nonsense']) {
      await expect(updateGeoip({ url, file, check: accept }), url).rejects.toThrow('https');
    }
  });
});

/** An object store in memory: what the bucket does, with the keys the way it is asked for them. */
function memoryStore(): ObjectStore & { keys(): string[] } {
  const held = new Map<string, Buffer>();
  return {
    kind: 'memory',
    keys: () => [...held.keys()].sort(),
    async put(key, bytes) { held.set(key, bytes); },
    async get(key) { return held.get(key) ?? null; },
    async stream() { return null; },
    async remove(key) { held.delete(key); },
    async list(prefix) { return [...held.keys()].filter(k => k.startsWith(prefix)); },
    async removeAll() {},
  };
}

describe('updateGeoipInBucket', () => {
  const day = (d: string) => new Date(`${d}T10:00:00Z`);

  it('puts the download in the bucket under the day it was made, and leaves nothing in the machine’s temporary directory', async () => {
    const store = memoryStore();
    const before = fs.readdirSync(os.tmpdir()).filter(f => f.startsWith('spine-geoip-') && f !== path.basename(dir));
    expect(await updateGeoipInBucket({ url: base, store, now: day('2026-11-13'), check: accept })).toBe(1_500_000);
    expect(store.keys()).toEqual([countryKey('20261113')]);
    expect((await store.get(countryKey('20261113')))!.equals(answer.body)).toBe(true);
    expect(fs.readdirSync(os.tmpdir()).filter(f => f.startsWith('spine-geoip-') && f !== path.basename(dir))).toEqual(before);
  });

  it('downloads once a day: with the day’s object there it does nothing, and the next day it does', async () => {
    const store = memoryStore();
    await updateGeoipInBucket({ url: base, store, now: day('2026-11-13'), check: accept });
    answer = { status: 500, body: Buffer.alloc(0) }; // a second download would fail
    expect(await updateGeoipInBucket({ url: base, store, now: day('2026-11-13'), check: accept })).toBe(0);
    answer = { status: 200, body: Buffer.alloc(1_600_000, 8) };
    expect(await updateGeoipInBucket({ url: base, store, now: day('2026-11-14'), check: accept })).toBe(1_600_000);
    expect(store.keys()).toEqual([countryKey('20261113'), countryKey('20261114')]);
  });

  it('keeps the last three days and removes the older ones, and leaves what is not its own', async () => {
    const store = memoryStore();
    await store.put('geoip/other-thing', Buffer.from('x'));
    for (const d of ['2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13']) await updateGeoipInBucket({ url: base, store, now: day(d), check: accept });
    expect(store.keys()).toEqual([countryKey('20261111'), countryKey('20261112'), countryKey('20261113'), 'geoip/other-thing']);
  });

  it('keeps what the bucket has when the download fails or the file fails its check', async () => {
    const store = memoryStore();
    await updateGeoipInBucket({ url: base, store, now: day('2026-11-12'), check: accept });
    answer = { status: 503, body: Buffer.alloc(0) };
    await expect(updateGeoipInBucket({ url: base, store, now: day('2026-11-13'), check: accept })).rejects.toThrow('503');
    answer = { status: 200, body: Buffer.alloc(1_500_000, 7) };
    await expect(updateGeoipInBucket({ url: base, store, now: day('2026-11-13'), check: async () => { throw new Error('no country'); } })).rejects.toThrow('no country');
    expect(store.keys()).toEqual([countryKey('20261112')]);
  });
});

describe('refreshCountryFile', () => {
  it('does nothing on a machine with a disk, where the install and the backup unit keep the file', async () => {
    await expect(refreshCountryFile({ SPINE_STORE: 'sqlite', SPINE_OBJECTS: 'filesystem', SPINE_GEOIP_URL: 'http://127.0.0.1:9/x' })).resolves.toBeUndefined();
  });

  it('does nothing for a file the operator named, even with no disk', async () => {
    await expect(refreshCountryFile({ SPINE_STORE: 'postgres', SPINE_OBJECTS: 'gcs', SPINE_GEOIP_DB: '/mine.mmdb' })).resolves.toBeUndefined();
  });

  it('ends well, and says so, when the store cannot be reached or the download fails: the job is not failed by it', async () => {
    // No object store is chosen in this process, so the first thing it asks of one throws; the job must still end.
    await expect(refreshCountryFile({ SPINE_STORE: 'postgres', SPINE_OBJECTS: 'gcs', SPINE_GEOIP_URL: 'http://127.0.0.1:9/x' })).resolves.toBeUndefined();
  });
});

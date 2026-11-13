import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The reader is a stand-in that answers from the bytes it was given: the file's own format is maxmind's to read, what is tested here is which object is
// read, when the bucket is looked at again, and what stays when it cannot be reached.
const made: Array<{ bytes: Buffer }> = [];
class Reader {
  bytes: Buffer;
  constructor(bytes: Buffer) { this.bytes = bytes; made.push(this); }
  get(ip: string) { return ip === '8.8.8.8' ? { country: { iso_code: this.bytes.toString() } } : null; }
}
vi.mock('maxmind', () => ({ default: { open: vi.fn() }, Reader }));

const held = new Map<string, Buffer>();
let reachable = true;
const gets: string[] = [];
const store = {
  kind: 'memory',
  async put(k: string, b: Buffer) { held.set(k, b); },
  async get(k: string) { if (!reachable) throw new Error('bucket away'); gets.push(k); return held.get(k) ?? null; },
  async stream() { return null; },
  async remove(k: string) { held.delete(k); },
  async list(prefix: string) { if (!reachable) throw new Error('bucket away'); return [...held.keys()].filter(k => k.startsWith(prefix)); },
  async removeAll() {},
};

const NO_DISK = { SPINE_STORE: 'postgres', SPINE_OBJECTS: 'gcs' } as NodeJS.ProcessEnv;
let countryOf: typeof import('../geo.js').countryOf;

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['Date'] });
  held.clear(); made.length = 0; gets.length = 0; reachable = true;
  const { useObjects } = await import('../objects/index.js');
  useObjects(() => store as never);
  ({ countryOf } = await import('../geo.js'));
});
afterEach(() => vi.useRealTimers());

describe('the country file where the process has no disk', () => {
  it('is the newest object of the bucket, read into memory', async () => {
    held.set('geoip/country-20261112.mmdb', Buffer.from('RO'));
    held.set('geoip/country-20261113.mmdb', Buffer.from('FR'));
    expect(await countryOf('8.8.8.8', NO_DISK)).toBe('FR');
    expect(gets).toEqual(['geoip/country-20261113.mmdb']);
  });

  it('gives no country while the bucket has none, and finds one that is put there, at the next look', async () => {
    expect(await countryOf('8.8.8.8', NO_DISK)).toBeNull();
    held.set('geoip/country-20261113.mmdb', Buffer.from('FR'));
    expect(await countryOf('8.8.8.8', NO_DISK)).toBeNull(); // not looked at again yet
    vi.setSystemTime(Date.now() + 11 * 60_000);
    expect(await countryOf('8.8.8.8', NO_DISK)).toBe('FR');
  });

  it('takes up a newer day without a restart, and reads the file once for each day', async () => {
    held.set('geoip/country-20261113.mmdb', Buffer.from('FR'));
    expect(await countryOf('8.8.8.8', NO_DISK)).toBe('FR');
    vi.setSystemTime(Date.now() + 11 * 60_000);
    expect(await countryOf('8.8.8.8', NO_DISK)).toBe('FR');
    expect(gets).toHaveLength(1);
    held.set('geoip/country-20261114.mmdb', Buffer.from('DE'));
    vi.setSystemTime(Date.now() + 11 * 60_000);
    expect(await countryOf('8.8.8.8', NO_DISK)).toBe('DE');
    expect(made).toHaveLength(2);
  });

  it('keeps the file it has when the bucket cannot be reached, and never throws', async () => {
    held.set('geoip/country-20261113.mmdb', Buffer.from('FR'));
    expect(await countryOf('8.8.8.8', NO_DISK)).toBe('FR');
    reachable = false;
    vi.setSystemTime(Date.now() + 11 * 60_000);
    expect(await countryOf('8.8.8.8', NO_DISK)).toBe('FR');
  });

  it('is not used where there is a disk, or where the operator names a file: nothing is asked of the bucket', async () => {
    held.set('geoip/country-20261113.mmdb', Buffer.from('FR'));
    await countryOf('8.8.8.8', { DATA_DIR: '/nowhere' });
    await countryOf('8.8.8.8', { ...NO_DISK, SPINE_GEOIP_DB: '/nowhere/mine.mmdb' });
    expect(gets).toEqual([]);
  });
});

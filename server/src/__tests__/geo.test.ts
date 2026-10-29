import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The reader is a stand-in that answers from this table: the file's own format is maxmind's to read, what is tested here is which file is
// read, when it is looked at again, and what is made of a record.
const records: Record<string, unknown> = {};
const open = vi.fn(async () => ({ get: (ip: string) => { if (ip === 'boom') throw new Error('unreadable'); return records[ip] ?? null; } }));
vi.mock('maxmind', () => ({ default: { open } }));

let dir: string;
let file: string;
let env: NodeJS.ProcessEnv;
let countryOf: typeof import('../geo.js').countryOf;

beforeEach(async () => {
  vi.resetModules();
  open.mockClear();
  for (const k of Object.keys(records)) delete records[k];
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-geo-'));
  file = path.join(dir, 'geoip', 'country.mmdb');
  env = { DATA_DIR: dir };
  ({ countryOf } = await import('../geo.js'));
});
afterEach(() => { vi.useRealTimers(); fs.rmSync(dir, { recursive: true, force: true }); });

const put = (at = file) => { fs.mkdirSync(path.dirname(at), { recursive: true }); fs.writeFileSync(at, 'x'); };

describe('countryOf', () => {
  it('has no country for anything while the file is missing, and says so without throwing', async () => {
    expect(await countryOf('8.8.8.8', env)).toBeNull();
    expect(open).not.toHaveBeenCalled();
  });

  it('reads geoip/country.mmdb in the data directory', async () => {
    put();
    records['8.8.8.8'] = { country: { iso_code: 'US' } };
    expect(await countryOf('8.8.8.8', env)).toBe('US');
    expect(open).toHaveBeenCalledWith(file);
  });

  it('reads the file SPINE_GEOIP_DB names instead', async () => {
    const own = path.join(dir, 'mine.mmdb');
    put(own);
    records['1.1.1.1'] = { country: { iso_code: 'AU' } };
    expect(await countryOf('1.1.1.1', { ...env, SPINE_GEOIP_DB: own })).toBe('AU');
    expect(open).toHaveBeenCalledWith(own);
  });

  it('picks up a file that arrives after the server started, within the minute it rechecks', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    records['8.8.8.8'] = { country: { iso_code: 'US' } };
    expect(await countryOf('8.8.8.8', env)).toBeNull();
    put();
    expect(await countryOf('8.8.8.8', env)).toBeNull(); // not looked at again yet
    vi.setSystemTime(Date.now() + 61_000);
    expect(await countryOf('8.8.8.8', env)).toBe('US');
  });

  it('opens the file again when it was replaced, and not otherwise', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    put();
    records['8.8.8.8'] = { country: { iso_code: 'US' } };
    await countryOf('8.8.8.8', env);
    vi.setSystemTime(Date.now() + 61_000);
    await countryOf('8.8.8.8', env);
    expect(open).toHaveBeenCalledTimes(1);
    const later = new Date(Date.now() + 120_000);
    fs.utimesSync(file, later, later);
    vi.setSystemTime(Date.now() + 61_000);
    await countryOf('8.8.8.8', env);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('reads the older country_code key when country.iso_code is absent', async () => {
    put();
    records['5.9.0.1'] = { country_code: 'DE' };
    expect(await countryOf('5.9.0.1', env)).toBe('DE');
  });

  it('answers only a two-letter upper-case code', async () => {
    put();
    records['1.2.3.4'] = { country: { iso_code: 'usa' } };
    records['1.2.3.5'] = { country: {} };
    expect(await countryOf('1.2.3.4', env)).toBeNull();
    expect(await countryOf('1.2.3.5', env)).toBeNull();
  });

  it('treats an IPv4 address that arrived over an IPv6 socket as the IPv4 address', async () => {
    put();
    records['81.196.1.1'] = { country: { iso_code: 'RO' } };
    expect(await countryOf('::ffff:81.196.1.1', env)).toBe('RO');
  });

  it('has no country for no address, an unknown one, or a lookup that throws', async () => {
    put();
    expect(await countryOf(null, env)).toBeNull();
    expect(await countryOf('', env)).toBeNull();
    expect(await countryOf('10.0.0.1', env)).toBeNull();
    expect(await countryOf('boom', env)).toBeNull();
  });

  it('has no country when the file will not open', async () => {
    put();
    open.mockRejectedValueOnce(new Error('not a database'));
    expect(await countryOf('8.8.8.8', env)).toBeNull();
  });
});

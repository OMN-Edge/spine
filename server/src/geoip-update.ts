import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import maxmind, { type CountryResponse } from 'maxmind';
import { geoipFile } from './geo.js';
import { useAccountsStore } from './store.js';

/**
 * Puts the country file where `geo.ts` reads it (`geoip/country.mmdb` in the data directory): the ip-location-db "user-country"
 * database, public domain, built daily, which is a release asset on GitHub and not an npm package. The build does not fetch it (a build
 * stays the same from the lockfile, rule S10 in docs/structure-rules.md); `install.sh -s` runs this once and the backup unit runs it daily, and a failed
 * download changes nothing: countries stay as they were, or blank, and the process still ends well.
 *
 * The file is checked before it replaces the one in use: it must be of a plausible size and open as a country database that answers for a
 * public address. It is written beside the target and renamed, so a reader never sees half a file.
 */
const DEFAULT_URL = 'https://github.com/sapics/ip-location-db/releases/download/latest/user-country.mmdb';
const MIN_BYTES = 1_000_000;
const MAX_BYTES = 100_000_000;

/** https, or http to this machine (a mirror, or a test). */
function allowed(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || (u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost'));
  } catch { return false; }
}

/** The file opens as a country database and knows a well-known public address (Google's resolver, in the United States). */
async function plausible(file: string): Promise<void> {
  const db = await maxmind.open<CountryResponse>(file);
  const record = db.get('8.8.8.8') as unknown as { country?: { iso_code?: string }; country_code?: string } | null;
  if (!/^[A-Z]{2}$/.test(record?.country?.iso_code ?? record?.country_code ?? '')) throw new Error('the file has no country for a public address');
}

export async function updateGeoip(options: { url: string; file: string; check?: (file: string) => Promise<void> }): Promise<number> {
  if (!allowed(options.url)) throw new Error('the address must be https');
  const part = `${options.file}.part`;
  await fs.mkdir(path.dirname(options.file), { recursive: true });
  try {
    const res = await fetch(options.url, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok || !res.body) throw new Error(`the server answered ${res.status}`);
    let bytes = 0;
    const counted = new Transform({
      transform(chunk: Buffer, _enc, done) {
        bytes += chunk.length;
        done(bytes > MAX_BYTES ? new Error('the file is larger than expected') : null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body as never), counted, createWriteStream(part));
    if (bytes < MIN_BYTES) throw new Error(`the file is ${bytes} bytes, smaller than expected`);
    await (options.check ?? plausible)(part);
    await fs.chmod(part, 0o644);
    await fs.rename(part, options.file);
    return bytes;
  } finally {
    await fs.rm(part, { force: true });
  }
}

async function main(): Promise<void> {
  useAccountsStore();
  if (process.env.SPINE_GEOIP_DB) {
    console.log('geoip: SPINE_GEOIP_DB names a file of your own; nothing is downloaded');
    return;
  }
  const file = geoipFile();
  try {
    const bytes = await updateGeoip({ url: process.env.SPINE_GEOIP_URL || DEFAULT_URL, file });
    console.log(`geoip: ${file} updated (${bytes} bytes)`);
  } catch (err) {
    // Best effort on purpose: a unit that runs this before a backup, or an install, must not fail because GitHub was unreachable.
    console.error(`geoip: not updated (${err instanceof Error ? err.message : String(err)}); countries stay as they were`);
  }
}

// Only when executed directly, so importing this in a test does not run it.
if (process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join('dist', 'geoip-update.js'))) {
  await main();
}

import fs from 'node:fs/promises';
import path from 'node:path';
import maxmind, { Reader, type CountryResponse } from 'maxmind';
import { resolveDataDir } from 'spine-core/config.js';
import { keepsFilesHere } from './local-files.js';
import { objects } from './objects/index.js';

/**
 * The country an address belongs to, for the access log of a share link (FR-SHR-04: when, from which country, which documents).
 * Looked up on this host in a file of address ranges, so the address goes nowhere. The ranges are the ip-location-db "user-country"
 * database (public domain), which `geoip-update.ts` keeps current; an address in a private range, or one the file does not
 * know, has no country, and neither has any address while the file is missing.
 *
 * Where it is kept follows where the process keeps its other bytes: in the data directory (`data/geoip/country.mmdb`) on a machine with a disk, and in
 * the bucket (`geoip/country-YYYYMMDD.mmdb`, the newest one) where the process keeps no file (docs/deploy-cloud-run.md), read into memory.
 * `SPINE_GEOIP_DB` points at another .mmdb country file of the operator's own, and then nothing is downloaded.
 */
export function geoipFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.SPINE_GEOIP_DB || path.join(resolveDataDir(env), 'geoip', 'country.mmdb');
}

/** In the bucket, one object for each day it was updated, so that the newest is found by name and a reader never sees half of one. */
export const COUNTRY_PREFIX = 'geoip/country-';
export const countryKey = (day: string): string => `${COUNTRY_PREFIX}${day}.mmdb`;
export const countryFileIsInTheBucket = (env: NodeJS.ProcessEnv = process.env): boolean => !env.SPINE_GEOIP_DB && !keepsFilesHere(env);

/** How often the file is looked at again: a download that arrives while the server runs is picked up within this, with no restart. */
const RECHECK_MS = 60_000;
/** A look in the bucket is a request to it, and the file changes once a day. */
const BUCKET_RECHECK_MS = 10 * 60_000;

let held: { where: string; version: string; checked: number; reader: Reader<CountryResponse> | null } | undefined;

async function openFile(env: NodeJS.ProcessEnv): Promise<Reader<CountryResponse> | null> {
  const file = geoipFile(env);
  const now = Date.now();
  if (held && held.where === file && now - held.checked < RECHECK_MS) return held.reader;
  const mtime = await fs.stat(file).then(s => s.mtimeMs, () => 0);
  if (held && held.where === file && held.version === String(mtime)) { held.checked = now; return held.reader; }
  // A missing file is not remembered as a failure: it is looked for again at the next check.
  const reader = mtime ? await maxmind.open<CountryResponse>(file).catch(() => null) : null;
  held = { where: file, version: String(mtime), checked: now, reader };
  return reader;
}

async function openBucket(): Promise<Reader<CountryResponse> | null> {
  const now = Date.now();
  const same = held?.where === 'bucket' ? held : undefined;
  if (same && now - same.checked < BUCKET_RECHECK_MS) return same.reader;
  try {
    const latest = (await objects().list(COUNTRY_PREFIX)).sort().pop();
    if (!latest || latest === same?.version) {
      held = { where: 'bucket', version: same?.version ?? '', checked: now, reader: same?.reader ?? null };
      return held.reader;
    }
    // It may have been removed since it was listed: then what is held stays, and the next check looks again.
    const bytes = await objects().get(latest);
    held = bytes
      ? { where: 'bucket', version: latest, checked: now, reader: new Reader<CountryResponse>(bytes) }
      : { where: 'bucket', version: same?.version ?? '', checked: now, reader: same?.reader ?? null };
    return held.reader;
  } catch {
    // The bucket could not be reached or the file is not one: keep what is held, and ask again at the next check.
    held = { where: 'bucket', version: same?.version ?? '', checked: now, reader: same?.reader ?? null };
    return held.reader;
  }
}

const open = (env: NodeJS.ProcessEnv) => (countryFileIsInTheBucket(env) ? openBucket() : openFile(env));

/** Two upper-case letters (ISO 3166-1), or null. Never throws: a log line must not fail a recipient's read. */
export async function countryOf(address: string | null | undefined, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (!address) return null;
  try {
    const db = await open(env);
    if (!db) return null;
    // `::ffff:81.196.1.1` is an IPv4 address that arrived over an IPv6 socket.
    const plain = address.replace(/^::ffff:/i, '');
    // The file has MaxMind's `country.iso_code`, and still the older `country_code` beside it.
    const record = db.get(plain) as unknown as { country?: { iso_code?: string }; country_code?: string } | null;
    const code = record?.country?.iso_code ?? record?.country_code;
    return code && /^[A-Z]{2}$/.test(code) ? code : null;
  } catch {
    return null;
  }
}

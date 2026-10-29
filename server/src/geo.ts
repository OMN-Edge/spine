import fs from 'node:fs/promises';
import path from 'node:path';
import maxmind, { type CountryResponse, type Reader } from 'maxmind';
import { resolveDataDir } from 'spine-core/config.js';

/**
 * The country an address belongs to, for the access log of a share link (FR-SHR-04: when, from which country, which documents).
 * Looked up on this host in a file of address ranges, so the address goes nowhere. The ranges are the ip-location-db "user-country"
 * database (public domain), which `geoip-update.ts` puts in the data directory; an address in a private range, or one the file does not
 * know, has no country, and neither has any address while the file is missing. `SPINE_GEOIP_DB` points at another .mmdb country file.
 */
export function geoipFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.SPINE_GEOIP_DB || path.join(resolveDataDir(env), 'geoip', 'country.mmdb');
}

/** How often the file is looked at again: a download that arrives while the server runs is picked up within this, with no restart. */
const RECHECK_MS = 60_000;

let held: { file: string; mtime: number; checked: number; reader: Reader<CountryResponse> | null } | undefined;

async function open(env: NodeJS.ProcessEnv): Promise<Reader<CountryResponse> | null> {
  const file = geoipFile(env);
  const now = Date.now();
  if (held && held.file === file && now - held.checked < RECHECK_MS) return held.reader;
  const mtime = await fs.stat(file).then(s => s.mtimeMs, () => 0);
  if (held && held.file === file && held.mtime === mtime) { held.checked = now; return held.reader; }
  // A missing file is not remembered as a failure: it is looked for again at the next check.
  const reader = mtime ? await maxmind.open<CountryResponse>(file).catch(() => null) : null;
  held = { file, mtime, checked: now, reader };
  return reader;
}

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

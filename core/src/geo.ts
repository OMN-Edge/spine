import { createRequire } from 'node:module';
import path from 'node:path';
import maxmind, { type CountryResponse, type Reader } from 'maxmind';

/**
 * The country an address belongs to, for the access log of a share link (FR-SHR-04: when, from which country, which documents).
 * Looked up on this host in a file of address ranges, so the address goes nowhere. The ranges are the DB-IP "IP to Country Lite"
 * database (CC BY 4.0, attribution in the readme), shipped as an npm package and refreshed by updating it; an address in a private
 * range, or one the file does not know, has no country. `SPINE_GEOIP_DB` points at another .mmdb country file instead.
 */
let reader: Promise<Reader<CountryResponse> | null> | undefined;

function open(env: NodeJS.ProcessEnv): Promise<Reader<CountryResponse> | null> {
  const file = env.SPINE_GEOIP_DB
    ?? path.join(path.dirname(createRequire(import.meta.url).resolve('@ip-location-db/dbip-country-mmdb/package.json')), 'dbip-country.mmdb');
  return maxmind.open<CountryResponse>(file).catch(() => null);
}

/** Two upper-case letters (ISO 3166-1), or null. Never throws: a log line must not fail a recipient's read. */
export async function countryOf(address: string | null | undefined, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (!address) return null;
  reader ??= open(env);
  const db = await reader;
  if (!db) return null;
  // `::ffff:81.196.1.1` is an IPv4 address that arrived over an IPv6 socket.
  const plain = address.replace(/^::ffff:/i, '');
  try {
    // DB-IP's file stores `country_code`, not the `country.iso_code` of MaxMind's own country databases.
    const code = (db.get(plain) as unknown as { country_code?: string } | null)?.country_code;
    return code && /^[A-Z]{2}$/.test(code) ? code : null;
  } catch {
    return null;
  }
}

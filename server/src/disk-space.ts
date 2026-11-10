import fs from 'node:fs';
import { resolveDataDir } from 'spine-core/config.js';
import { objects } from './objects/index.js';

/**
 * The disk behind `data/` is the whole instance's, and every account may hold gigabytes: nothing bounded all of them together, so accounts
 * made in numbers could fill it, after which every save, the accounts database and the daily snapshot failed (SECURITY.md S-56). A write of
 * sealed bytes is refused while the free space would fall below a reserve, which always leaves room for the database and the backup.
 * `SPINE_MIN_FREE_MB`, default 1024; 0 turns it off. Only for a store on this machine's disk: a bucket has no such limit to guard.
 */
const MB = 1024 * 1024;

export function minFreeBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.SPINE_MIN_FREE_MB;
  if (raw === undefined || raw.trim() === '') return 1024 * MB;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) * MB : 1024 * MB;
}

/** Where the free space comes from: replaceable, so a test can say how much there is. Null when the store is not on this disk. */
export const disk = {
  free(): number | null {
    if (objects().kind !== 'filesystem') return null;
    try {
      const stat = fs.statfsSync(resolveDataDir());
      return Number(stat.bavail) * Number(stat.bsize);
    } catch {
      return null; // not knowing is not a reason to refuse a write
    }
  },
};

/** Whether `incoming` more bytes of sealed objects leave the reserve in place. */
export async function spaceFor(incoming: number): Promise<boolean> {
  const reserve = minFreeBytes();
  if (reserve === 0) return true;
  const free = disk.free();
  return free === null || free - incoming >= reserve;
}

/** What to say at start when a handful of accounts at the quota could not be held in the free space; null when they could. */
export function quotaWarning(free: number | null, accountBytes: number, accounts = 10): string | null {
  if (free === null || free >= accountBytes * accounts) return null;
  return `the free space (${Math.floor(free / MB)} MB) is less than ${accounts} accounts at the vault quota (${Math.floor(accountBytes / MB)} MB each): set SPINE_VAULT_MAX_MB to what this disk can bear before registration is open`;
}

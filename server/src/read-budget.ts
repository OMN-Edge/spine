/**
 * How many bytes of a share one source may read in an hour (SECURITY.md S-57). A share's id is in every address, and its sealed copy can be a
 * hundred megabytes; a limit on requests lets a source with the id pull the whole copy sixty times a minute, from a home connection, so the
 * limit is in bytes. `SPINE_SHARE_READ_MB_PER_HOUR`, default 2048; a bad value gives the default.
 */
export function shareReadBytesPerHour(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.SPINE_SHARE_READ_MB_PER_HOUR);
  return Number.isInteger(n) && n >= 1 ? n * 1024 * 1024 : 2048 * 1024 * 1024;
}

const MAX_KEYS = 100_000;
const HOUR = 60 * 60 * 1000;
/** Keys in the order their windows began, so the first one that has not ended ends the walk (as in `rate-limit.ts`). */
const windows = new Map<string, { start: number; bytes: number }>();

export const readBudget = {
  /** Takes `bytes` from the key's budget for the window; false, with nothing taken, when that would pass `limit`. */
  take(key: string, bytes: number, limit: number = shareReadBytesPerHour(), windowMs: number = HOUR, now: number = Date.now()): boolean {
    for (const [k, w] of windows) {
      if (now - w.start < windowMs) break;
      windows.delete(k);
    }
    while (windows.size >= MAX_KEYS) windows.delete(windows.keys().next().value as string);
    const have = windows.get(key) ?? { start: now, bytes: 0 };
    if (have.bytes + bytes > limit) return false;
    have.bytes += bytes;
    windows.set(key, have);
    return true;
  },
};

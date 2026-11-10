/**
 * How many reads of sealed objects one account (or one source of a share) may have open at once (SECURITY.md S-58). A read is streamed, so it
 * holds little memory, but each holds a file, a connection and a slice of the disk's and the card's time; a few dozen opened together and
 * left slow are enough to starve everyone else on a small host. `SPINE_MAX_CONCURRENT_READS`, default 8; a bad value gives the default.
 */
export function maxConcurrentReads(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.SPINE_MAX_CONCURRENT_READS);
  return Number.isInteger(n) && n >= 1 ? n : 8;
}

const open = new Map<string, number>();

export const readSlots = {
  /** A slot for this key, or null when it has none left. The release it returns may be called any number of times. */
  take(key: string): (() => void) | null {
    const have = open.get(key) ?? 0;
    if (have >= maxConcurrentReads()) return null;
    open.set(key, have + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (open.get(key) ?? 1) - 1;
      if (left <= 0) open.delete(key);
      else open.set(key, left);
    };
  },
  /** For a test: takes every slot the key has and says how many. */
  acquireAll(key: string): number {
    let n = 0;
    while (this.take(key)) n++;
    return n;
  },
  /** For a test: gives back what `acquireAll` took. */
  releaseAll(key: string, n: number): void {
    const left = (open.get(key) ?? 0) - n;
    if (left <= 0) open.delete(key);
    else open.set(key, left);
  },
};

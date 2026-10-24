/**
 * A random whole number that fits JavaScript's exact integers (below 2^53), for the three tables whose key was the database's own counter.
 * Two devices that each count from the same start would give different rows the same key; a random one makes that a chance of about one
 * in 10^15 (store/sqlite/changes.ts merges what the devices wrote).
 */
export function randomRowId(): number {
  const words = new Uint32Array(2);
  crypto.getRandomValues(words);
  return (words[0] & 0x1fffff) * 2 ** 32 + words[1] + 1;
}

/**
 * The same number for the same name and person on every device, for the tags a new account starts with: two devices that each make them then make
 * the same rows, so there is nothing to merge. (FNV-1a over the name, twice with different seeds, cut to 52 bits.)
 */
export function starterTagId(userId: string, name: string): number {
  const key = `${userId}\u0000${name}`;
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x9e3779b9;
  for (let i = 0; i < key.length; i++) {
    a = Math.imul(a ^ key.charCodeAt(i), 0x01000193) >>> 0;
    b = Math.imul(b ^ key.charCodeAt(i), 0x85ebca6b) >>> 0;
  }
  return (a & 0xfffff) * 2 ** 32 + b + 1;
}

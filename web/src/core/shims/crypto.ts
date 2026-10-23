import { Buffer } from 'buffer';
import { sodium } from '../../crypto/sodium';

/**
 * The part of Node's `crypto` that the core uses: sha256 (in one go at `digest`), random bytes and ids. sha256 is libsodium's, so the
 * core must have awaited `sodium()` before its first hash; it does, at start, and a hash before that throws instead of guessing.
 */
let lib: Awaited<ReturnType<typeof sodium>> | null = null;
void sodium().then(s => { lib = s; });
export const ready = () => sodium().then(s => { lib = s; });

export function createHash(algorithm: string) {
  if (algorithm !== 'sha256') throw new Error(`the device core hashes with sha256 only, not ${algorithm}`);
  const parts: Uint8Array[] = [];
  const self = {
    update(data: string | Uint8Array) { parts.push(typeof data === 'string' ? new TextEncoder().encode(data) : data); return self; },
    digest(encoding?: BufferEncoding) {
      if (!lib) throw new Error('libsodium is not ready; await ready() before hashing');
      const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let at = 0; for (const p of parts) { all.set(p, at); at += p.length; }
      const out = Buffer.from(lib.crypto_hash_sha256(all));
      return encoding ? out.toString(encoding) : out;
    },
  };
  return self;
}
export const randomBytes = (n: number) => Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(n)));
export const randomUUID = () => globalThis.crypto.randomUUID();
export default { createHash, randomBytes, randomUUID };

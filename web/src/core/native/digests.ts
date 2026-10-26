import type { Digests } from 'spine-core/digest';
import { sodium } from '../../crypto/sodium';

/**
 * The device's hashing: libsodium's SHA-256, in one go at `hex()`. The core awaits `ready()` before its first hash (it does, at start), and a
 * hash before that throws instead of guessing.
 */
let lib: Awaited<ReturnType<typeof sodium>> | null = null;
export const ready = (): Promise<void> => sodium().then(s => { lib = s; });
void ready();

const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');

export const browserDigests: Digests = {
  sha256() {
    const parts: Uint8Array[] = [];
    const self = {
      update(data: string | Uint8Array) { parts.push(typeof data === 'string' ? new TextEncoder().encode(data) : data); return self; },
      hex() {
        if (!lib) throw new Error('libsodium is not ready; await ready() before hashing');
        const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
        let at = 0;
        for (const p of parts) { all.set(p, at); at += p.length; }
        return hex(lib.crypto_hash_sha256(all));
      },
    };
    return self;
  },
};

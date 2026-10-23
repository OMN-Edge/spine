import { sodium, sodiumNow } from './sodium.js';

/**
 * Sealing: XChaCha20-Poly1305 with a fresh random 24-byte nonce, written in front of the ciphertext (nonce, then ciphertext and tag).
 * `context` is authenticated but not stored: it names what the bytes are (which object, which kind of key), so a sealed value cannot be
 * moved to another place and still open. A wrong key, a changed byte and a wrong context all fail the same way.
 */
export class OpenError extends Error {
  constructor() {
    super('could not open: wrong key, wrong place or changed bytes');
    this.name = 'OpenError';
  }
}

const utf8 = (text: string) => new TextEncoder().encode(text);

export async function seal(key: Uint8Array, plaintext: Uint8Array, context: string): Promise<Uint8Array> {
  const s = await sodium();
  const nonce = s.randombytes_buf(s.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const body = s.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, utf8(context), null, nonce, key);
  const out = new Uint8Array(nonce.length + body.length);
  out.set(nonce, 0);
  out.set(body, nonce.length);
  return out;
}

export async function open(key: Uint8Array, sealed: Uint8Array, context: string): Promise<Uint8Array> {
  const s = await sodium();
  const n = s.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
  if (sealed.length < n + s.crypto_aead_xchacha20poly1305_ietf_ABYTES) throw new OpenError();
  try {
    return s.crypto_aead_xchacha20poly1305_ietf_decrypt(null, sealed.subarray(n), utf8(context), sealed.subarray(0, n), key);
  } catch {
    throw new OpenError();
  }
}

/** `open`, for a caller that cannot wait; libsodium must already be loaded. */
export function openNow(key: Uint8Array, sealed: Uint8Array, context: string): Uint8Array {
  const s = sodiumNow();
  const n = s.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
  if (sealed.length < n + s.crypto_aead_xchacha20poly1305_ietf_ABYTES) throw new OpenError();
  try {
    return s.crypto_aead_xchacha20poly1305_ietf_decrypt(null, sealed.subarray(n), utf8(context), sealed.subarray(0, n), key);
  } catch {
    throw new OpenError();
  }
}

export async function sealJson(key: Uint8Array, value: unknown, context: string): Promise<Uint8Array> {
  return seal(key, utf8(JSON.stringify(value)), context);
}

export async function openJson<T>(key: Uint8Array, sealed: Uint8Array, context: string): Promise<T> {
  return JSON.parse(new TextDecoder().decode(await open(key, sealed, context))) as T;
}

export async function randomKey(): Promise<Uint8Array> {
  const s = await sodium();
  return s.randombytes_buf(s.crypto_aead_xchacha20poly1305_ietf_KEYBYTES);
}

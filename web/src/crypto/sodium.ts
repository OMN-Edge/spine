import sodiumLib from 'libsodium-wrappers-sumo';

/**
 * libsodium, loaded once. Every primitive Spine uses comes from here (Argon2id, XChaCha20-Poly1305, X25519, BLAKE2b): nothing is
 * invented (docs/key-hierarchy.md). The WebAssembly build is initialised on first use, so callers await this before anything else.
 */
export type Sodium = typeof sodiumLib;

let ready: Promise<Sodium> | null = null;
let loaded = false;

export function sodium(): Promise<Sodium> {
  ready ??= sodiumLib.ready.then(() => { loaded = true; return sodiumLib; });
  return ready;
}

/** The library, for code that cannot wait (a file read that must answer at once). Only after `await sodium()` has been done once. */
export function sodiumNow(): Sodium {
  if (!loaded) throw new Error('libsodium is not ready yet');
  return sodiumLib;
}

export const toB64 = (s: Sodium, bytes: Uint8Array): string => s.to_base64(bytes, s.base64_variants.URLSAFE_NO_PADDING);
export const fromB64 = (s: Sodium, text: string): Uint8Array => s.from_base64(text, s.base64_variants.URLSAFE_NO_PADDING);

import sodiumLib from 'libsodium-wrappers-sumo';

/**
 * libsodium, loaded once. Every primitive Spine uses comes from here (Argon2id, XChaCha20-Poly1305, X25519, BLAKE2b): nothing is
 * invented (docs/key-hierarchy.md). The WebAssembly build is initialised on first use, so callers await this before anything else.
 */
export type Sodium = typeof sodiumLib;

let ready: Promise<Sodium> | null = null;

export function sodium(): Promise<Sodium> {
  ready ??= sodiumLib.ready.then(() => sodiumLib);
  return ready;
}

export const toB64 = (s: Sodium, bytes: Uint8Array): string => s.to_base64(bytes, s.base64_variants.URLSAFE_NO_PADDING);
export const fromB64 = (s: Sodium, text: string): Uint8Array => s.from_base64(text, s.base64_variants.URLSAFE_NO_PADDING);

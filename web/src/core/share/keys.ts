import { sodium, sodiumNow, fromB64, toB64 } from '../../crypto/sodium';
import { seal, open, openNow } from '../../crypto/seal';

/**
 * The keys of an encrypted share (docs/crypto-design.md, stage 4). A share is sealed with one random key; the link carries it after the
 * `#`, which a browser never sends to a server. For a link that needs approval the key is not in the link: the visitor's browser makes
 * a key pair, the owner's device seals the share key to its public half (a sealed box, which only that browser's private half opens),
 * and the server relays the sealed key without being able to read it. What is sealed is bound to the share's id and the part's name,
 * so a copy cannot be put in the place of another.
 */
const context = (shareId: string, part: string) => `spine/v1/share/${shareId}/${part}`;

export async function newShareKey(): Promise<string> {
  const s = await sodium();
  return toB64(s, s.randombytes_buf(32));
}

export async function sealPart(keyB64: string, shareId: string, part: string, plaintext: Uint8Array): Promise<Uint8Array> {
  const s = await sodium();
  return seal(fromB64(s, keyB64), plaintext, context(shareId, part));
}

export async function openPart(keyB64: string, shareId: string, part: string, sealed: Uint8Array): Promise<Uint8Array> {
  const s = await sodium();
  return open(fromB64(s, keyB64), sealed, context(shareId, part));
}

/** For a read that must answer at once (a page image asked for by synchronous code). libsodium must already be loaded. */
export function openPartNow(keyB64: string, shareId: string, part: string, sealed: Uint8Array): Uint8Array {
  const s = sodiumNow();
  return openNow(fromB64(s, keyB64), sealed, context(shareId, part));
}
/** A visitor's key pair for asking to be let in. The private half stays in that browser. */
export async function newVisitorKeys(): Promise<{ publicKey: string; privateKey: string }> {
  const s = await sodium();
  const pair = s.crypto_box_keypair();
  return { publicKey: toB64(s, pair.publicKey), privateKey: toB64(s, pair.privateKey) };
}

/** The owner's device: the share key sealed to a visitor's public key. */
export async function wrapShareKey(shareKeyB64: string, visitorPublicB64: string): Promise<string> {
  const s = await sodium();
  return toB64(s, s.crypto_box_seal(fromB64(s, shareKeyB64), fromB64(s, visitorPublicB64)));
}

/** The visitor's browser: the share key, from what the owner sealed to it. Null if it was not sealed to this key pair. */
export async function unwrapShareKey(wrappedB64: string, keys: { publicKey: string; privateKey: string }): Promise<string | null> {
  const s = await sodium();
  try {
    return toB64(s, s.crypto_box_seal_open(fromB64(s, wrappedB64), fromB64(s, keys.publicKey), fromB64(s, keys.privateKey)));
  } catch {
    return null;
  }
}

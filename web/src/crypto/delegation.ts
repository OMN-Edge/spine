import { sodium, toB64, fromB64 } from './sodium.js';
import { decode32 } from './recovery-kit.js';
import { open, seal } from './seal.js';
import { newEnrolmentCode, readEnrolmentCode, showCode } from './enrolment.js';
import type { UnlockedKeys } from './keys.js';

export { newEnrolmentCode as newInviteCode, readEnrolmentCode as readInviteCode, showCode as showInviteCode };

/**
 * Letting another account into a profile (SECURITY.md **M-49**). The owner's device makes a one-time code (the same kind the device
 * enrolment uses: eighty bits and two check characters, typed or followed from a link). Three things are made from it, and the server is
 * given the first and a hash of the third, never the code or the second:
 *
 *   code ──BLAKE2b──▶ root ──▶ id      (public: what the invited device asks for; it cannot be run back to the code)
 *                          ├──▶ key     (the profile key is sealed under it; it opens the invitation and nothing else)
 *                          └──▶ proof   (shown to claim the invitation; the server kept its hash)
 *
 * Whoever claims it opens the profile key with the code and seals it to their own key pair (a sealed box), which is what the grant holds.
 * A later rotation of the profile key seals the new one to each delegate's public key without them being there.
 */
const CONTEXT = 'spine/v1/invite-code';
const SECRET_CHARS = 16;

export interface Invite { id: string; key: Uint8Array; proof: string }

export async function fromInviteCode(code: string): Promise<Invite> {
  const s = await sodium();
  const root = s.crypto_generichash(32, decode32(code.slice(0, SECRET_CHARS)), s.from_string(CONTEXT));
  const out = {
    id: toB64(s, s.crypto_kdf_derive_from_key(32, 1, 'spineinv', root)),
    key: s.crypto_kdf_derive_from_key(32, 2, 'spineink', root),
    proof: toB64(s, s.crypto_kdf_derive_from_key(32, 3, 'spineinp', root)),
  };
  s.memzero(root);
  return out;
}

const inviteContext = (id: string) => `spine/v1/invite/${id}`;

/**
 * The owner's device: a code to tell the other person, and what the server is given for it. What the code opens is the profile key and the
 * owner's own public key, so the invited device learns it through the code and not from the server (SECURITY.md S-39, S-41). `ownerBlob` is the
 * invitation's key sealed under the owner's account key, kept at the server beside the invitation, so that any of the owner's devices can later
 * open the delegate's hello (`readHello`) without the code, which is not kept.
 */
export async function makeInvite(profileKey: Uint8Array, ownerPublicKey: Uint8Array, accountKey: Uint8Array): Promise<{ code: string; id: string; wrapped: string; proofHash: string; ownerBlob: string }> {
  const s = await sodium();
  const code = await newEnrolmentCode();
  const invite = await fromInviteCode(code);
  try {
    const payload = new Uint8Array(64);
    payload.set(profileKey, 0);
    payload.set(ownerPublicKey, 32);
    const wrapped = toB64(s, await seal(invite.key, payload, inviteContext(invite.id)));
    const ownerBlob = toB64(s, await seal(accountKey, invite.key, OWNER_BLOB));
    // A hash of the proof is all the server keeps: it cannot show the proof, so a copy of its tables claims nothing.
    const proofHash = Array.from(s.crypto_hash_sha256(s.from_string(invite.proof))).map(b => b.toString(16).padStart(2, '0')).join('');
    return { code, id: invite.id, wrapped, proofHash, ownerBlob };
  } finally {
    s.memzero(invite.key);
  }
}

/** The invited device: what an invitation held, opened with the code. The owner's key is null for an invitation made before it carried one. */
export async function openInvite(invite: Invite, wrapped: string): Promise<{ profileKey: Uint8Array; ownerPublicKey: Uint8Array | null }> {
  const s = await sodium();
  const plain = await open(invite.key, fromB64(s, wrapped), inviteContext(invite.id));
  if (plain.length === 32) return { profileKey: plain, ownerPublicKey: null };
  if (plain.length !== 64) throw new Error('the invitation is not what it should be');
  return { profileKey: plain.slice(0, 32), ownerPublicKey: plain.slice(32) };
}

const OWNER_BLOB = 'spine/v1/invite-owner';
const HELLO = 'spine/v1/invite-hello';
const pinContext = (profileId: string) => `spine/v1/key-pin/${profileId}`;

/** The invited device: its own public key under the key the code makes. The server carries it and cannot make one, or change it. */
export async function helloFor(invite: Invite, publicKey: Uint8Array): Promise<string> {
  const s = await sodium();
  return toB64(s, await seal(invite.key, publicKey, HELLO));
}

/** The invitation's key, from what the owner's device kept at the server; null if it does not open under this account's key. */
export async function inviteKeyFromBlob(accountKey: Uint8Array, ownerBlob: string): Promise<Uint8Array | null> {
  const s = await sodium();
  try { return await open(accountKey, fromB64(s, ownerBlob), OWNER_BLOB); } catch { return null; }
}

/** The delegate's public key as the invited device sealed it under the invitation's key; null if it was not made with it. */
export async function readHello(inviteKey: Uint8Array, hello: string): Promise<Uint8Array | null> {
  const s = await sodium();
  try {
    const key = await open(inviteKey, fromB64(s, hello), HELLO);
    return key.length === 32 ? key : null;
  } catch {
    return null;
  }
}

/** The other side's public key for one profile, kept sealed under this account's key, for the server to hold and to be unable to change. */
export async function sealPin(accountKey: Uint8Array, profileId: string, publicKey: Uint8Array): Promise<string> {
  const s = await sodium();
  return toB64(s, await seal(accountKey, publicKey, pinContext(profileId)));
}

/** The key a pin holds (its first 32 bytes), or null if it does not open under this account's key for this profile. */
export async function openPin(accountKey: Uint8Array, profileId: string, pin: string): Promise<Uint8Array | null> {
  const s = await sodium();
  try {
    const plain = await open(accountKey, fromB64(s, pin), pinContext(profileId));
    return plain.length >= 32 ? plain.slice(0, 32) : null;
  } catch {
    return null;
  }
}

/**
 * A profile key sealed to a delegate's public key and authenticated by the sender's private key (a box: nonce and ciphertext). The owner seals
 * a replaced key this way, and the delegate seals the first one to themselves this way, so that whoever opens it knows it was made by the one
 * they expected and not by a server that holds only the public key (S-41).
 */
export async function sealGrantKey(sender: UnlockedKeys, receiverPublicKey: Uint8Array, profileKey: Uint8Array): Promise<string> {
  const s = await sodium();
  const nonce = s.randombytes_buf(s.crypto_box_NONCEBYTES);
  const boxed = s.crypto_box_easy(profileKey, nonce, receiverPublicKey, sender.privateKey);
  const out = new Uint8Array(nonce.length + boxed.length);
  out.set(nonce, 0);
  out.set(boxed, nonce.length);
  return toB64(s, out);
}

/**
 * The profile key a grant holds for this account, or null if it was not made for it by one of `senders`: the owner's key as the code gave it,
 * and this account's own. Only a box from one of them opens. An anonymous sealed box is not accepted, since a server holds every public key and
 * can make one, and with no senders nothing opens (S-39, S-41).
 */
export async function openGrantKey(unlocked: UnlockedKeys, wrapped: string, senders: Uint8Array[]): Promise<Uint8Array | null> {
  const s = await sodium();
  let bytes: Uint8Array;
  try { bytes = fromB64(s, wrapped); } catch { return null; }
  if (bytes.length <= s.crypto_box_NONCEBYTES) return null;
  const nonce = bytes.slice(0, s.crypto_box_NONCEBYTES);
  const boxed = bytes.slice(s.crypto_box_NONCEBYTES);
  for (const sender of senders) {
    try { return s.crypto_box_open_easy(boxed, nonce, sender, unlocked.privateKey); } catch { /* not from this one */ }
  }
  return null;
}

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

/** The owner's device: a code to tell the other person, and what the server is given for it. */
export async function makeInvite(profileKey: Uint8Array): Promise<{ code: string; id: string; wrapped: string; proofHash: string }> {
  const s = await sodium();
  const code = await newEnrolmentCode();
  const invite = await fromInviteCode(code);
  try {
    const wrapped = toB64(s, await seal(invite.key, profileKey, inviteContext(invite.id)));
    // A hash of the proof is all the server keeps: it cannot show the proof, so a copy of its tables claims nothing.
    const proofHash = Array.from(s.crypto_hash_sha256(s.from_string(invite.proof))).map(b => b.toString(16).padStart(2, '0')).join('');
    return { code, id: invite.id, wrapped, proofHash };
  } finally {
    s.memzero(invite.key);
  }
}

/** The invited device: the profile key an invitation held, opened with the code. */
export async function openInvite(invite: Invite, wrapped: string): Promise<Uint8Array> {
  const s = await sodium();
  return open(invite.key, fromB64(s, wrapped), inviteContext(invite.id));
}

/** A profile key sealed to an account's public key: only that account's private half opens it. */
export async function sealProfileKeyTo(publicKeyB64: string, profileKey: Uint8Array): Promise<string> {
  const s = await sodium();
  return toB64(s, s.crypto_box_seal(profileKey, fromB64(s, publicKeyB64)));
}

/** The profile key a grant holds for this account, or null if it was not sealed to this account's key pair. */
export async function openGrantKey(unlocked: UnlockedKeys, wrapped: string): Promise<Uint8Array | null> {
  const s = await sodium();
  try {
    return s.crypto_box_seal_open(fromB64(s, wrapped), unlocked.publicKey, unlocked.privateKey);
  } catch {
    return null;
  }
}

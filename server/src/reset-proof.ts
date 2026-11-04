import { createPublicKey, verify } from 'crypto';
import type { KdfParams } from './vault-keys.js';
import type { VaultKeys } from 'spine-core/store/types.js';

/**
 * What a reset must be signed for (SECURITY.md S-38). The device makes an Ed25519 key from the account key, which the recovery kit opens,
 * and the server keeps its public half (`vault_keys.reset_verifier`). A reset that replaces the keys carries a signature over the link and
 * the new keys, so the email link alone is not enough: the server learns that the kit, or an open vault, was used, though everything the kit
 * opens is sealed and it cannot check more. The message is built here as the device builds it (`resetMessage` in `web/src/crypto/keys.ts`).
 */
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
export const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;

export const resetMessage = (token: string, authValue: string, k: Pick<VaultKeys, 'kdf_salt' | 'wrapped_by_master' | 'wrapped_by_recovery' | 'public_key' | 'wrapped_private_key'>, params: KdfParams): string =>
  ['spine/v1/reset', token, authValue, k.kdf_salt, params.ops, params.memKiB, k.wrapped_by_master, k.wrapped_by_recovery, k.public_key, k.wrapped_private_key].join('\n');

/** True when `signature` is the verifier's signature of `message`. Anything malformed is false, never an error. */
export function verifyResetProof(verifier: string, message: string, signature: unknown): boolean {
  if (typeof signature !== 'string' || !SIGNATURE.test(signature)) return false;
  try {
    const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(verifier, 'base64url')]), format: 'der', type: 'spki' });
    return verify(null, Buffer.from(message), key, Buffer.from(signature, 'base64url'));
  } catch {
    return false;
  }
}

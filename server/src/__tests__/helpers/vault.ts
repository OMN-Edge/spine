import { randomBytes } from 'crypto';
import type { VaultKeys } from '../../store/types.js';

/**
 * Keys in the shape a device sends. The server cannot tell sealed bytes from random ones, so random bytes of the right length are what
 * it is given: these tests are about what the server checks and keeps, and the sealing itself is tested with the device's code.
 */
const b64 = (n: number) => randomBytes(n).toString('base64url');

export function fakeVaultKeys(): Omit<VaultKeys, 'kdf_params'> & { kdf_params: { alg: string; ops: number; memKiB: number } } {
  return {
    kdf_salt: b64(16),
    kdf_params: { alg: 'argon2id13', ops: 3, memKiB: 65536 },
    wrapped_by_master: b64(72),
    wrapped_by_recovery: b64(72),
    public_key: b64(32),
    wrapped_private_key: b64(72),
  };
}

/** What a device derives from the password and sends as the credential: 32 random bytes. */
export const fakeAuthValue = () => b64(32);

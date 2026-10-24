import { deriveFromPassword } from './keys.js';
import { VaultSession, fetchKdf, type PasskeyUnlock } from './vault-client.js';
import { OpenError } from './seal.js';
import { device, forgetDeviceObjectUrls } from '../core/client';

/**
 * What the page holds about the vault between steps: the address signed in with, the master key from the sign-in until the vault has
 * been opened with it, and the open vault. All of it is memory: a reload forgets it, and the next use asks for the password again.
 */
let email = '';
let pendingMaster: Uint8Array | null = null;
let session: VaultSession | null = null;

export const vaultState = {
  setEmail(address: string) {
    email = address.trim().toLowerCase();
  },
  email: () => email,
  stashMaster(masterKey: Uint8Array | null) {
    pendingMaster = masterKey;
  },
  session: () => session,

  /**
   * Hands the master key a sign-in left to the core, which opens the vault in its own worker and loads the records. The page keeps its
   * own copy until `openStashed` has used it, for the settings that change keys.
   */
  async startDevice(): Promise<'open' | 'locked'> {
    if (device.isOpen()) return 'open';
    if (!pendingMaster) return 'locked';
    await device.unlock(pendingMaster.slice());
    return 'open';
  },

  /** Opens the vault with the master key a sign-in left, if there is one. Returns what happened. */
  async openStashed(): Promise<'open' | 'locked' | 'no_vault'> {
    if (session) return 'open';
    if (!pendingMaster) return 'locked';
    try {
      session = await VaultSession.open(pendingMaster);
      pendingMaster = null;
      return 'open';
    } catch (err) {
      if ((err as { code?: string }).code === 'no_vault') return 'no_vault';
      throw err;
    }
  },

  /** Opens it with a password typed now (a reload, or a change of password). Throws `OpenError` if the password is wrong. */
  async unlock(password: string): Promise<VaultSession> {
    const kdf = await fetchKdf(email);
    if (!kdf.vault) throw new Error('this account has no vault yet');
    const { masterKey } = await deriveFromPassword(password, kdf.salt, kdf.params);
    // Always opened from the key just made: that is what proves the password, even when a session is already held.
    const forDevice = masterKey.slice();
    const opened = await VaultSession.open(masterKey);
    await session?.close();
    session = opened;
    if (!device.isOpen()) await device.unlock(forDevice);
    return session;
  },

  /** Opens it with a passkey's PRF output (a sign-in with a passkey that opens the vault). Throws `OpenError` if the sealed key does not open. */
  async unlockWithPasskey(unlock: PasskeyUnlock): Promise<VaultSession> {
    const opened = await VaultSession.openWithPasskey({ ...unlock, prf: unlock.prf.slice() });
    await session?.close();
    session = opened;
    if (!device.isOpen()) await device.unlockWithPasskey({ credentialId: unlock.credentialId, wrapped: unlock.wrapped, prf: unlock.prf.slice() });
    return session;
  },

  adopt(next: VaultSession) {
    session = next;
    pendingMaster = null;
  },

  async lock() {
    await device.lock();
    forgetDeviceObjectUrls();
    await session?.close();
    session = null;
    pendingMaster = null;
  },
};

/**
 * What to send as the password: the value derived from it for an account with a vault, the password itself for one without (until it
 * makes one). The server compares it to what it holds and learns nothing else.
 */
export async function credentialFor(password: string): Promise<string> {
  const kdf = await fetchKdf(email);
  if (!kdf.vault) return password;
  return (await deriveFromPassword(password, kdf.salt, kdf.params)).authValue;
}

export { OpenError };

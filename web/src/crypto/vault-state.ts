import { deriveFromPassword } from './keys.js';
import { VaultSession, fetchKdf } from './vault-client.js';
import { OpenError } from './seal.js';

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
    if (session) return session;
    const kdf = await fetchKdf(email);
    if (!kdf.vault) throw new Error('this account has no vault yet');
    const { masterKey } = await deriveFromPassword(password, kdf.salt, kdf.params);
    session = await VaultSession.open(masterKey);
    return session;
  },

  adopt(next: VaultSession) {
    session = next;
    pendingMaster = null;
  },

  async lock() {
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

import { deriveFromPassword, type KdfParams } from './keys.js';
import { VaultSession, fetchKdf, fetchKeys, type KeysResponse, type PasskeyUnlock } from './vault-client.js';
import { sodium } from './sodium.js';
import { OpenError } from './seal.js';
import { device, forgetDeviceObjectUrls } from '../core/client';

/**
 * What the page holds about the vault between steps: the address signed in with, the master key from the sign-in until the vault has
 * been opened with it, and the open vault. All of it is memory: a reload forgets it, and the next use asks for the password again.
 */
let email = '';
let pendingMaster: Uint8Array | null = null;
let session: VaultSession | null = null;

/**
 * What the unlock screen asks the server for before the password is typed (the key derivation's parameters and the sealed keys), so that
 * after it only the derivation and the opening of the records are left. A failure here is not an error: the unlock asks again.
 */
let prefetched: { email: string; kdf: Promise<Awaited<ReturnType<typeof fetchKdf>> | null>; keys: Promise<KeysResponse | null> } | null = null;

/** The master key for a password, made in the core's worker where there is one (so the screen keeps moving), else here. */
export async function deriveKey(password: string, salt: string, params: KdfParams): Promise<{ masterKey: Uint8Array; authValue: string }> {
  try {
    return await device.derive(password, salt, params);
  } catch {
    // No worker (a test, a browser that refuses one): in the page, after a moment so what is on screen has been drawn.
    await new Promise(resolve => setTimeout(resolve, 0));
    return deriveFromPassword(password, salt, params);
  }
}

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

  /**
   * Called when the unlock screen appears: starts what does not need the password. The core's worker loads (it is 7 MB), the cryptography
   * library starts, and the server is asked for the derivation's parameters and the sealed keys, all while the person types.
   */
  prefetch() {
    device.warm();
    void sodium().catch(() => undefined);
    if (!email || prefetched?.email === email) return;
    prefetched = {
      email,
      kdf: fetchKdf(email).catch(() => null),
      keys: fetchKeys().catch(() => null),
    };
  },

  /** Opens it with a password typed now (a reload, or a change of password). Throws `OpenError` if the password is wrong. */
  async unlock(password: string): Promise<VaultSession> {
    const t0 = performance.now();
    const ahead = prefetched?.email === email ? prefetched : null;
    prefetched = null; // used once: a second unlock asks the server again
    const kdf = (await ahead?.kdf) ?? (await fetchKdf(email));
    if (!kdf.vault) throw new Error('this account has no vault yet');
    const t1 = performance.now();
    const { masterKey } = await deriveKey(password, kdf.salt, kdf.params);
    const t2 = performance.now();
    // Always opened from the key just made: that is what proves the password, even when a session is already held.
    const forDevice = masterKey.slice();
    let keys = (await ahead?.keys) ?? (await fetchKeys());
    let opened: VaultSession;
    try {
      opened = await VaultSession.open(masterKey.slice(), undefined, keys);
    } catch (err) {
      if (!(err instanceof OpenError) || !ahead) throw err;
      // The keys fetched ahead were changed since (a password changed on another device): the fresh ones decide.
      keys = await fetchKeys();
      opened = await VaultSession.open(masterKey, undefined, keys);
    }
    const t3 = performance.now();
    await session?.close();
    session = opened;
    if (!device.isOpen()) await device.unlock(forDevice, keys);
    // Where the time went, for whoever is finding out why opening is slow: milliseconds, never a key or a record.
    console.debug('[unlock]', { prefetched: !!ahead, kdfMs: Math.round(t1 - t0), deriveMs: Math.round(t2 - t1), keysMs: Math.round(t3 - t2), openMs: Math.round(performance.now() - t3), totalMs: Math.round(performance.now() - t0) });
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

  /** Throws `UnsavedChangesError` if changes are not in the vault yet, and then nothing is lost or closed; `force` is the person's choice. */
  async lock(force = false) {
    await device.lock(force);
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
  return (await deriveKey(password, kdf.salt, kdf.params)).authValue;
}

export { OpenError };

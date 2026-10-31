import { fromB64, sodium, sodiumNow, toB64 } from './sodium.js';
import { open, openNow, randomKey, seal } from './seal.js';

/**
 * The key hierarchy (docs/key-hierarchy.md, docs/crypto-design.md), all of it on the device.
 *
 *   password ──Argon2id(salt)──▶ root ──▶ master key        (never leaves the device)
 *                                    └──▶ authentication value (what the server gets, and hashes again)
 *   account key (random) ── sealed under the master key, and again under the recovery key
 *   account key pair (X25519) ── the private half sealed under the account key
 *   profile key (random, one per profile) ── sealed under the account key
 *   data key (random, one per object) ── sealed under the profile key
 *
 * The server stores the sealed forms and the public key. It cannot go from the authentication value to the master key: they are
 * separate subkeys of the root, and the root is not sent.
 */
export interface KdfParams {
  alg: 'argon2id13';
  ops: number;
  /** Memory in KiB. */
  memKiB: number;
}

/** 64 MiB and 3 passes: well above the OWASP minimum (19 MiB, 2) and still about a second on a phone. */
export const DEFAULT_KDF: KdfParams = { alg: 'argon2id13', ops: 3, memKiB: 65536 };

/** What is sent to the server and comes back from it. Every field is sealed or public. */
export interface VaultKeyPayload {
  kdf_salt: string;
  kdf_params: KdfParams;
  wrapped_by_master: string;
  wrapped_by_recovery: string;
  public_key: string;
  wrapped_private_key: string;
}

/** What an unlocked device holds in memory. Never stored, never sent. */
export interface UnlockedKeys {
  accountKey: Uint8Array;
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

const CTX = {
  byMaster: 'spine/v1/account-key/master',
  byRecovery: 'spine/v1/account-key/recovery',
  byPasskey: (credentialId: string) => `spine/v1/account-key/passkey/${credentialId}`,
  privateKey: 'spine/v1/account-private-key',
  profileKey: (profileId: string) => `spine/v1/profile-key/${profileId}`,
  dataKey: (objectId: string) => `spine/v1/data-key/${objectId}`,
};

/** The same password typed on any device or keyboard layout gives the same bytes. */
const passwordBytes = (s: { from_string(t: string): Uint8Array }, password: string) => s.from_string(password.normalize('NFKC'));

export async function deriveFromPassword(password: string, salt: string, params: KdfParams): Promise<{ masterKey: Uint8Array; authValue: string }> {
  const s = await sodium();
  const root = s.crypto_pwhash(32, passwordBytes(s, password), fromB64(s, salt), params.ops, params.memKiB * 1024, s.crypto_pwhash_ALG_ARGON2ID13);
  const masterKey = s.crypto_kdf_derive_from_key(32, 1, 'spinemst', root);
  const authValue = toB64(s, s.crypto_kdf_derive_from_key(32, 2, 'spineaut', root));
  s.memzero(root);
  return { masterKey, authValue };
}

export interface NewAccount {
  /** Sent as the credential. */
  authValue: string;
  keys: VaultKeyPayload;
  /** Shown once as the recovery kit; the device keeps nothing of it. */
  recoveryKey: Uint8Array;
  unlocked: UnlockedKeys;
}

export async function createAccountKeys(password: string, params: KdfParams = DEFAULT_KDF): Promise<NewAccount> {
  const s = await sodium();
  const salt = toB64(s, s.randombytes_buf(16));
  const { masterKey, authValue } = await deriveFromPassword(password, salt, params);
  const accountKey = await randomKey();
  const recoveryKey = s.randombytes_buf(32);
  const pair = s.crypto_box_keypair();
  const keys: VaultKeyPayload = {
    kdf_salt: salt,
    kdf_params: params,
    wrapped_by_master: toB64(s, await seal(masterKey, accountKey, CTX.byMaster)),
    wrapped_by_recovery: toB64(s, await seal(recoveryKey, accountKey, CTX.byRecovery)),
    public_key: toB64(s, pair.publicKey),
    wrapped_private_key: toB64(s, await seal(accountKey, pair.privateKey, CTX.privateKey)),
  };
  s.memzero(masterKey);
  return { authValue, keys, recoveryKey, unlocked: { accountKey, publicKey: pair.publicKey, privateKey: pair.privateKey } };
}

async function unlockWith(key: Uint8Array, context: string, wrapped: string, payload: VaultKeyPayload): Promise<UnlockedKeys> {
  const s = await sodium();
  const accountKey = await open(key, fromB64(s, wrapped), context);
  const privateKey = await open(accountKey, fromB64(s, payload.wrapped_private_key), CTX.privateKey);
  return { accountKey, publicKey: fromB64(s, payload.public_key), privateKey };
}

/** Throws `OpenError` for a wrong master key (that is, a wrong password). */
export const unlockWithMaster = (masterKey: Uint8Array, payload: VaultKeyPayload) => unlockWith(masterKey, CTX.byMaster, payload.wrapped_by_master, payload);

/** Throws `OpenError` for a wrong recovery key. */
export const unlockWithRecovery = (recoveryKey: Uint8Array, payload: Pick<VaultKeyPayload, 'wrapped_by_recovery' | 'wrapped_private_key' | 'public_key'>) =>
  unlockWith(recoveryKey, CTX.byRecovery, payload.wrapped_by_recovery, payload as VaultKeyPayload);

/**
 * A passkey that opens the vault: its PRF output (32 bytes the authenticator derives from a fixed input and never shows anyone else) makes
 * a key on the device, and the account key is sealed under it. The server keeps the sealed form on the passkey's row and cannot open it:
 * it never sees the PRF output. The account key does not change with the password, so this stays valid through a change of password.
 */
async function keyFromPrf(prf: Uint8Array): Promise<Uint8Array> {
  const s = await sodium();
  if (prf.length !== 32) throw new Error('the passkey gave an unexpected value');
  return s.crypto_kdf_derive_from_key(32, 1, 'spineprf', prf);
}

export async function wrapForPasskey(unlocked: UnlockedKeys, prf: Uint8Array, credentialId: string): Promise<string> {
  const s = await sodium();
  const key = await keyFromPrf(prf);
  try {
    return toB64(s, await seal(key, unlocked.accountKey, CTX.byPasskey(credentialId)));
  } finally {
    s.memzero(key);
  }
}

/** Throws `OpenError` for another passkey's output, a key sealed for another credential, or changed bytes. */
export async function unlockWithPasskey(prf: Uint8Array, credentialId: string, wrapped: string, payload: VaultKeyPayload): Promise<UnlockedKeys> {
  const s = await sodium();
  const key = await keyFromPrf(prf);
  try {
    return await unlockWith(key, CTX.byPasskey(credentialId), wrapped, payload);
  } finally {
    s.memzero(key);
  }
}

/** A new master password over the same account key: a new salt, a new master key, the recovery wrapping as it was. */
export async function rewrapForPassword(unlocked: UnlockedKeys, current: VaultKeyPayload, newPassword: string, params: KdfParams = DEFAULT_KDF): Promise<{ authValue: string; keys: VaultKeyPayload }> {
  const s = await sodium();
  const salt = toB64(s, s.randombytes_buf(16));
  const { masterKey, authValue } = await deriveFromPassword(newPassword, salt, params);
  const keys: VaultKeyPayload = { ...current, kdf_salt: salt, kdf_params: params, wrapped_by_master: toB64(s, await seal(masterKey, unlocked.accountKey, CTX.byMaster)) };
  s.memzero(masterKey);
  return { authValue, keys };
}

/** A new recovery kit: the account key sealed under a new recovery key, the old kit useless from then on. */
export async function newRecoveryKit(unlocked: UnlockedKeys, current: VaultKeyPayload): Promise<{ recoveryKey: Uint8Array; keys: VaultKeyPayload }> {
  const s = await sodium();
  const recoveryKey = s.randombytes_buf(32);
  return { recoveryKey, keys: { ...current, wrapped_by_recovery: toB64(s, await seal(recoveryKey, unlocked.accountKey, CTX.byRecovery)) } };
}

/** A reset by the recovery kit: unlock with it, then wrap the same account key under a master key made from the new password. */
export async function resetWithRecovery(
  recoveryKey: Uint8Array,
  stored: Pick<VaultKeyPayload, 'wrapped_by_recovery' | 'wrapped_private_key' | 'public_key'>,
  newPassword: string,
  params: KdfParams = DEFAULT_KDF,
): Promise<{ authValue: string; keys: VaultKeyPayload; unlocked: UnlockedKeys }> {
  const s = await sodium();
  const unlocked = await unlockWithRecovery(recoveryKey, stored);
  const salt = toB64(s, s.randombytes_buf(16));
  const { masterKey, authValue } = await deriveFromPassword(newPassword, salt, params);
  const keys: VaultKeyPayload = {
    kdf_salt: salt,
    kdf_params: params,
    wrapped_by_master: toB64(s, await seal(masterKey, unlocked.accountKey, CTX.byMaster)),
    wrapped_by_recovery: stored.wrapped_by_recovery,
    public_key: stored.public_key,
    wrapped_private_key: stored.wrapped_private_key,
  };
  s.memzero(masterKey);
  return { authValue, keys, unlocked };
}

/** A profile's key, sealed under the account key. */
export async function newProfileKey(unlocked: UnlockedKeys, profileId: string): Promise<{ profileKey: Uint8Array; wrapped: string }> {
  const s = await sodium();
  const profileKey = await randomKey();
  return { profileKey, wrapped: toB64(s, await seal(unlocked.accountKey, profileKey, CTX.profileKey(profileId))) };
}

export async function openProfileKey(unlocked: UnlockedKeys, profileId: string, wrapped: string): Promise<Uint8Array> {
  const s = await sodium();
  return open(unlocked.accountKey, fromB64(s, wrapped), CTX.profileKey(profileId));
}

/**
 * Replacing a profile's key (SECURITY.md **M-49**, TR-CRY-07): one object's data key, sealed again under the new profile key. The data key is
 * the same, so the object's body is untouched; what changes is which profile key opens it.
 */
export async function rewrapObjectKey(oldProfileKey: Uint8Array, newProfileKey: Uint8Array, objectId: string, wrappedKey: string): Promise<string> {
  const s = await sodium();
  const dataKey = await open(oldProfileKey, fromB64(s, wrappedKey), CTX.dataKey(objectId));
  try {
    return toB64(s, await seal(newProfileKey, dataKey, CTX.dataKey(objectId)));
  } finally {
    s.memzero(dataKey);
  }
}

/** A sealed object: the bytes to upload and the data key that opens them, sealed under the profile key. */
export interface SealedObject {
  body: Uint8Array;
  wrappedKey: string;
}

const objectContext = (kind: string, id: string) => `spine/v1/object/${kind}/${id}`;

export async function sealObject(profileKey: Uint8Array, kind: string, id: string, plaintext: Uint8Array): Promise<SealedObject> {
  const s = await sodium();
  const dataKey = await randomKey();
  const body = await seal(dataKey, plaintext, objectContext(kind, id));
  const wrappedKey = toB64(s, await seal(profileKey, dataKey, CTX.dataKey(id)));
  s.memzero(dataKey);
  return { body, wrappedKey };
}

export async function openObject(profileKey: Uint8Array, kind: string, id: string, body: Uint8Array, wrappedKey: string): Promise<Uint8Array> {
  const s = await sodium();
  const dataKey = await open(profileKey, fromB64(s, wrappedKey), CTX.dataKey(id));
  try {
    return await open(dataKey, body, objectContext(kind, id));
  } finally {
    s.memzero(dataKey);
  }
}

/** `openObject` for a caller that cannot wait (the core's file system answers a read at once); libsodium must already be loaded. */
export function openObjectNow(profileKey: Uint8Array, kind: string, id: string, body: Uint8Array, wrappedKey: string): Uint8Array {
  const s = sodiumNow();
  const dataKey = openNow(profileKey, fromB64(s, wrappedKey), CTX.dataKey(id));
  try {
    return openNow(dataKey, body, objectContext(kind, id));
  } finally {
    s.memzero(dataKey);
  }
}

/** Forget the keys held in memory (signing out). */
export async function lock(unlocked: UnlockedKeys): Promise<void> {
  const s = await sodium();
  s.memzero(unlocked.accountKey);
  s.memzero(unlocked.privateKey);
}

/**
 * A profile is itself an object (kind `profile`, id the profile's own id): its body is sealed under the profile key directly, and the
 * key sealed under the account key travels as the object's wrapped key. A device that has the account key finds every profile this way.
 */
export const sealProfileRecord = (profileKey: Uint8Array, profileId: string, plaintext: Uint8Array) => seal(profileKey, plaintext, objectContext('profile', profileId));
export const openProfileRecord = (profileKey: Uint8Array, profileId: string, body: Uint8Array) => open(profileKey, body, objectContext('profile', profileId));

/** A random id for an object or a profile: 16 bytes, 22 characters. */
export async function newId(): Promise<string> {
  const s = await sodium();
  return toB64(s, s.randombytes_buf(16));
}

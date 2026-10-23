import { describe, it, expect } from 'vitest';
import { sodium, toB64 } from './sodium.js';
import { OpenError, open, seal } from './seal.js';
import {
  createAccountKeys, deriveFromPassword, lock, newProfileKey, newRecoveryKit, openObject, openProfileKey, resetWithRecovery, rewrapForPassword,
  sealObject, unlockWithMaster, unlockWithRecovery, type KdfParams,
} from './keys.js';
import { newRecoveryKey, readRecoveryKey, writeRecoveryKey } from './recovery-kit.js';

// The cheapest cost the server accepts, so the suite stays fast; the real default is DEFAULT_KDF.
const FAST: KdfParams = { alg: 'argon2id13', ops: 2, memKiB: 19456 };
const PASSWORD = 'correct horse battery staple 41';
const bytes = (text: string) => new TextEncoder().encode(text);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

describe('seal', () => {
  it('round-trips and uses a new nonce each time', async () => {
    const s = await sodium();
    const key = s.randombytes_buf(32);
    const a = await seal(key, bytes('hello'), 'ctx');
    const b = await seal(key, bytes('hello'), 'ctx');
    expect(a).not.toEqual(b);
    expect(text(await open(key, a, 'ctx'))).toBe('hello');
  });

  it('fails the same way for a wrong key, a wrong place and a changed byte', async () => {
    const s = await sodium();
    const key = s.randombytes_buf(32);
    const sealed = await seal(key, bytes('hello'), 'ctx');
    await expect(open(s.randombytes_buf(32), sealed, 'ctx')).rejects.toBeInstanceOf(OpenError);
    await expect(open(key, sealed, 'other')).rejects.toBeInstanceOf(OpenError);
    const changed = sealed.slice();
    changed[changed.length - 1] ^= 1;
    await expect(open(key, changed, 'ctx')).rejects.toBeInstanceOf(OpenError);
    await expect(open(key, sealed.slice(0, 10), 'ctx')).rejects.toBeInstanceOf(OpenError);
  });
});

describe('the recovery kit text', () => {
  it('writes fourteen groups and reads them back', async () => {
    const key = await newRecoveryKey();
    const kit = await writeRecoveryKey(key);
    expect(kit).toMatch(/^([0-9A-Z]{4}-){13}[0-9A-Z]{4}$/);
    const read = await readRecoveryKey(kit);
    expect(read.ok && read.key).toEqual(key);
  });

  it('reads it typed loosely: lower case, spaces, no dashes, O for 0, I or L for 1', async () => {
    const key = await newRecoveryKey();
    const kit = await writeRecoveryKey(key);
    const loose = kit.toLowerCase().replace(/-/g, ' ').replace(/0/g, 'o').replace(/1/g, 'l');
    const read = await readRecoveryKey(loose);
    expect(read.ok && read.key).toEqual(key);
  });

  it('catches a typing error, a short key and a wrong character', async () => {
    const kit = await writeRecoveryKey(await newRecoveryKey());
    const flip = (i: number) => kit.slice(0, i) + (kit[i] === 'A' ? 'B' : 'A') + kit.slice(i + 1);
    expect(await readRecoveryKey(flip(0))).toEqual({ ok: false, reason: 'check' });
    expect(await readRecoveryKey(flip(kit.length - 1))).toEqual({ ok: false, reason: 'check' });
    expect(await readRecoveryKey(kit.slice(0, -5))).toEqual({ ok: false, reason: 'length' });
    expect(await readRecoveryKey('U' + kit.slice(1))).toEqual({ ok: false, reason: 'characters' });
  });

  it('gives different keys different kits', async () => {
    expect(await writeRecoveryKey(await newRecoveryKey())).not.toBe(await writeRecoveryKey(await newRecoveryKey()));
  });
});

describe('the key hierarchy', () => {
  it('derives the same keys from the same password and salt, and different ones otherwise', async () => {
    const account = await createAccountKeys(PASSWORD, FAST);
    const again = await deriveFromPassword(PASSWORD, account.keys.kdf_salt, FAST);
    const other = await deriveFromPassword(PASSWORD + '!', account.keys.kdf_salt, FAST);
    expect(again.authValue).toBe(account.authValue);
    expect(other.authValue).not.toBe(account.authValue);
    expect(other.masterKey).not.toEqual(again.masterKey);
  });

  it('treats a composed and a decomposed letter as the same password', async () => {
    const a = await deriveFromPassword('café password long', 'AAAAAAAAAAAAAAAAAAAAAA', FAST);
    const b = await deriveFromPassword('café password long', 'AAAAAAAAAAAAAAAAAAAAAA', FAST);
    expect(a.authValue).toBe(b.authValue);
  });

  it('never sends anything the master key can be got from', async () => {
    const s = await sodium();
    const account = await createAccountKeys(PASSWORD, FAST);
    const { masterKey } = await deriveFromPassword(PASSWORD, account.keys.kdf_salt, FAST);
    const sent = JSON.stringify({ auth: account.authValue, keys: account.keys });
    expect(sent).not.toContain(toB64(s, masterKey));
    expect(sent).not.toContain(toB64(s, account.unlocked.accountKey));
    expect(sent).not.toContain(toB64(s, account.recoveryKey));
    expect(account.authValue).not.toBe(toB64(s, masterKey));
  });

  it('opens with the master key and not with a wrong password', async () => {
    const account = await createAccountKeys(PASSWORD, FAST);
    const { masterKey } = await deriveFromPassword(PASSWORD, account.keys.kdf_salt, FAST);
    const unlocked = await unlockWithMaster(masterKey, account.keys);
    expect(unlocked.accountKey).toEqual(account.unlocked.accountKey);
    expect(unlocked.privateKey).toEqual(account.unlocked.privateKey);
    const wrong = await deriveFromPassword('not the password at all', account.keys.kdf_salt, FAST);
    await expect(unlockWithMaster(wrong.masterKey, account.keys)).rejects.toBeInstanceOf(OpenError);
  });

  it('opens with the recovery key to the same account key', async () => {
    const account = await createAccountKeys(PASSWORD, FAST);
    const unlocked = await unlockWithRecovery(account.recoveryKey, account.keys);
    expect(unlocked.accountKey).toEqual(account.unlocked.accountKey);
    await expect(unlockWithRecovery(await newRecoveryKey(), account.keys)).rejects.toBeInstanceOf(OpenError);
  });

  it('keeps the data readable across a password change, and the old password stops opening it', async () => {
    const account = await createAccountKeys(PASSWORD, FAST);
    const profile = await newProfileKey(account.unlocked, 'profile-0001');
    const sealed = await sealObject(profile.profileKey, 'bundle', 'object-0001', bytes('a record'));

    const next = await rewrapForPassword(account.unlocked, account.keys, 'a different long password', FAST);
    expect(next.authValue).not.toBe(account.authValue);
    const { masterKey } = await deriveFromPassword('a different long password', next.keys.kdf_salt, FAST);
    const unlocked = await unlockWithMaster(masterKey, next.keys);
    const profileKey = await openProfileKey(unlocked, 'profile-0001', profile.wrapped);
    expect(text(await openObject(profileKey, 'bundle', 'object-0001', sealed.body, sealed.wrappedKey))).toBe('a record');

    const old = await deriveFromPassword(PASSWORD, account.keys.kdf_salt, FAST);
    await expect(unlockWithMaster(old.masterKey, next.keys)).rejects.toBeInstanceOf(OpenError);
  });

  it('resets a forgotten password with the kit and keeps the data', async () => {
    const account = await createAccountKeys(PASSWORD, FAST);
    const profile = await newProfileKey(account.unlocked, 'profile-0001');
    const sealed = await sealObject(profile.profileKey, 'bundle', 'object-0001', bytes('kept'));

    const reset = await resetWithRecovery(account.recoveryKey, account.keys, 'brand new long password', FAST);
    const { masterKey } = await deriveFromPassword('brand new long password', reset.keys.kdf_salt, FAST);
    const unlocked = await unlockWithMaster(masterKey, reset.keys);
    const profileKey = await openProfileKey(unlocked, 'profile-0001', profile.wrapped);
    expect(text(await openObject(profileKey, 'bundle', 'object-0001', sealed.body, sealed.wrappedKey))).toBe('kept');
    await expect(resetWithRecovery(await newRecoveryKey(), account.keys, 'x'.repeat(14), FAST)).rejects.toBeInstanceOf(OpenError);
  });

  it('makes a new kit that replaces the old one', async () => {
    const account = await createAccountKeys(PASSWORD, FAST);
    const fresh = await newRecoveryKit(account.unlocked, account.keys);
    expect((await unlockWithRecovery(fresh.recoveryKey, fresh.keys)).accountKey).toEqual(account.unlocked.accountKey);
    await expect(unlockWithRecovery(account.recoveryKey, fresh.keys)).rejects.toBeInstanceOf(OpenError);
  });

  it('forgets the keys it holds when locked', async () => {
    const account = await createAccountKeys(PASSWORD, FAST);
    await lock(account.unlocked);
    expect([...account.unlocked.accountKey].every(b => b === 0)).toBe(true);
  });
});

describe('sealed objects', () => {
  it('opens only under its own kind and id, and under its own profile', async () => {
    const account = await createAccountKeys(PASSWORD, FAST);
    const one = await newProfileKey(account.unlocked, 'profile-0001');
    const two = await newProfileKey(account.unlocked, 'profile-0002');
    const sealed = await sealObject(one.profileKey, 'bundle', 'object-0001', bytes('private'));
    expect(text(await openObject(one.profileKey, 'bundle', 'object-0001', sealed.body, sealed.wrappedKey))).toBe('private');
    await expect(openObject(one.profileKey, 'bundle', 'object-0002', sealed.body, sealed.wrappedKey)).rejects.toBeInstanceOf(OpenError);
    await expect(openObject(one.profileKey, 'blob', 'object-0001', sealed.body, sealed.wrappedKey)).rejects.toBeInstanceOf(OpenError);
    await expect(openObject(two.profileKey, 'bundle', 'object-0001', sealed.body, sealed.wrappedKey)).rejects.toBeInstanceOf(OpenError);
  });

  it('cannot take another object\'s key', async () => {
    const account = await createAccountKeys(PASSWORD, FAST);
    const profile = await newProfileKey(account.unlocked, 'profile-0001');
    const a = await sealObject(profile.profileKey, 'bundle', 'object-0001', bytes('a'));
    const b = await sealObject(profile.profileKey, 'bundle', 'object-0002', bytes('b'));
    await expect(openObject(profile.profileKey, 'bundle', 'object-0001', a.body, b.wrappedKey)).rejects.toBeInstanceOf(OpenError);
  });

  it('does not contain what it holds', async () => {
    const account = await createAccountKeys(PASSWORD, FAST);
    const profile = await newProfileKey(account.unlocked, 'profile-0001');
    const sealed = await sealObject(profile.profileKey, 'bundle', 'object-0001', bytes('hemoglobin 13.2 g/dL'));
    expect(text(sealed.body)).not.toContain('hemoglobin');
  });

  it('is only openable with the right profile key wrapped by this account', async () => {
    const account = await createAccountKeys(PASSWORD, FAST);
    const other = await createAccountKeys('some other long password', FAST);
    const profile = await newProfileKey(account.unlocked, 'profile-0001');
    await expect(openProfileKey(other.unlocked, 'profile-0001', profile.wrapped)).rejects.toBeInstanceOf(OpenError);
    await expect(openProfileKey(account.unlocked, 'profile-0002', profile.wrapped)).rejects.toBeInstanceOf(OpenError);
  });
});

describe('the shapes the server accepts', () => {
  it('matches the lengths the server checks', async () => {
    const account = await createAccountKeys(PASSWORD, FAST);
    expect(account.authValue).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(account.keys.kdf_salt).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(account.keys.public_key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    for (const wrapped of [account.keys.wrapped_by_master, account.keys.wrapped_by_recovery, account.keys.wrapped_private_key]) {
      expect(wrapped).toMatch(/^[A-Za-z0-9_-]{90,200}$/);
    }
    const profile = await newProfileKey(account.unlocked, 'profile-0001');
    const sealed = await sealObject(profile.profileKey, 'bundle', 'object-0001', bytes('x'));
    expect(profile.wrapped).toMatch(/^[A-Za-z0-9_-]{90,200}$/);
    expect(sealed.wrappedKey).toMatch(/^[A-Za-z0-9_-]{90,200}$/);
  });
});

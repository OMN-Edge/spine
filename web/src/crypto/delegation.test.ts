import { describe, it, expect } from 'vitest';
import { createAccountKeys } from './keys';
import { sodium, toB64, fromB64 } from './sodium';
import { seal } from './seal';
import {
  fromInviteCode, helloFor, inviteKeyFromBlob, makeInvite, openGrantKey, openInvite, openPin, readHello, sealGrantKey, sealPin, sealProfileKeyTo,
} from './delegation';

/**
 * SECURITY.md S-39 and S-41. Each side's key is bound to the other's through the invitation code, which never reaches the server, and a profile
 * key sealed to a delegate says who sealed it, so a server that lists a key of its own, or seals a key of its own, is refused.
 */
const FAST = { alg: 'argon2id13' as const, ops: 2, memKiB: 19456 };
const person = async () => (await createAccountKeys('a long enough master password', FAST)).unlocked;
const key = async () => (await sodium()).randombytes_buf(32);
const eq = (a: Uint8Array | null, b: Uint8Array) => !!a && a.length === b.length && a.every((v, i) => v === b[i]);

describe('what an invitation carries', () => {
  it('is the profile key and the owner’s public key, which the code alone opens', async () => {
    const owner = await person();
    const profileKey = await key();
    const made = await makeInvite(profileKey, owner.publicKey, owner.accountKey);
    const opened = await openInvite(await fromInviteCode(made.code), made.wrapped);
    expect(eq(opened.profileKey, profileKey)).toBe(true);
    expect(eq(opened.ownerPublicKey, owner.publicKey)).toBe(true);
    // another code opens nothing
    await expect(openInvite(await fromInviteCode((await makeInvite(await key(), owner.publicKey, owner.accountKey)).code), made.wrapped)).rejects.toThrow();
  });

  it('is still read from an invitation made before it carried the owner’s key', async () => {
    const owner = await person();
    const profileKey = await key();
    const made = await makeInvite(profileKey, owner.publicKey, owner.accountKey);
    const invite = await fromInviteCode(made.code);
    const old = toB64(await sodium(), await seal(invite.key, profileKey, `spine/v1/invite/${invite.id}`));
    const opened = await openInvite(invite, old);
    expect(eq(opened.profileKey, profileKey)).toBe(true);
    expect(opened.ownerPublicKey).toBeNull();
  });
});

describe('the delegate’s key, as the owner comes to know it', () => {
  it('goes from the delegate to the owner under a key only the code makes, and the owner’s devices open it from what they stored', async () => {
    const owner = await person();
    const delegate = await person();
    const made = await makeInvite(await key(), owner.publicKey, owner.accountKey);
    const hello = await helloFor(await fromInviteCode(made.code), delegate.publicKey);
    const inviteKey = (await inviteKeyFromBlob(owner.accountKey, made.ownerBlob))!;
    expect(eq(await readHello(inviteKey, hello), delegate.publicKey)).toBe(true);
  });

  it('cannot be made, or the key swapped, by whoever lacks the code', async () => {
    const owner = await person();
    const delegate = await person();
    const server = await person();
    const made = await makeInvite(await key(), owner.publicKey, owner.accountKey);
    const other = await makeInvite(await key(), owner.publicKey, owner.accountKey);
    const forged = await helloFor(await fromInviteCode(other.code), server.publicKey);
    const inviteKey = (await inviteKeyFromBlob(owner.accountKey, made.ownerBlob))!;
    expect(await readHello(inviteKey, forged)).toBeNull();
    expect(delegate).toBeTruthy();
  });

  it('is kept by the owner’s account key alone: another account cannot open the blob', async () => {
    const owner = await person();
    const made = await makeInvite(await key(), owner.publicKey, owner.accountKey);
    expect(await inviteKeyFromBlob((await person()).accountKey, made.ownerBlob)).toBeNull();
  });
});

describe('a pin of the other side’s key', () => {
  it('opens for the account that sealed it and the profile it is for, and for nothing else', async () => {
    const mine = await person();
    const theirs = await key();
    const pin = await sealPin(mine.accountKey, 'profile-0001', theirs);
    expect(eq(await openPin(mine.accountKey, 'profile-0001', pin), theirs)).toBe(true);
    expect(await openPin(mine.accountKey, 'profile-0002', pin)).toBeNull();
    expect(await openPin((await person()).accountKey, 'profile-0001', pin)).toBeNull();
  });
});

describe('a profile key sealed to a delegate', () => {
  it('opens when the owner sealed it and the delegate holds the owner’s key, and when the delegate sealed it to themselves', async () => {
    const owner = await person();
    const delegate = await person();
    const profileKey = await key();
    const fromOwner = await sealGrantKey(owner, delegate.publicKey, profileKey);
    expect(eq(await openGrantKey(delegate, fromOwner, [owner.publicKey, delegate.publicKey]), profileKey)).toBe(true);
    const own = await sealGrantKey(delegate, delegate.publicKey, profileKey);
    expect(eq(await openGrantKey(delegate, own, [owner.publicKey, delegate.publicKey]), profileKey)).toBe(true);
  });

  it('is refused when the server sealed it, whether as a box from a key of its own or as an anonymous sealed box', async () => {
    const owner = await person();
    const delegate = await person();
    const server = await person();
    const falseKey = await key();
    const senders = [owner.publicKey, delegate.publicKey];
    expect(await openGrantKey(delegate, await sealGrantKey(server, delegate.publicKey, falseKey), senders)).toBeNull();
    expect(await openGrantKey(delegate, await sealProfileKeyTo(toB64(await sodium(), delegate.publicKey), falseKey), senders)).toBeNull();
  });

  it('still opens the anonymous sealed box of a grant made before keys were bound, and only for such a grant', async () => {
    const delegate = await person();
    const profileKey = await key();
    const old = await sealProfileKeyTo(toB64(await sodium(), delegate.publicKey), profileKey);
    expect(eq(await openGrantKey(delegate, old, []), profileKey)).toBe(true);
    expect(await openGrantKey(delegate, old, [delegate.publicKey])).toBeNull();
  });

  it('is not opened by another account, or from a damaged copy', async () => {
    const owner = await person();
    const delegate = await person();
    const wrapped = await sealGrantKey(owner, delegate.publicKey, await key());
    expect(await openGrantKey(await person(), wrapped, [owner.publicKey])).toBeNull();
    const bytes = fromB64(await sodium(), wrapped);
    bytes[40] ^= 1;
    expect(await openGrantKey(delegate, toB64(await sodium(), bytes), [owner.publicKey])).toBeNull();
  });
});

describe('an account’s public key', () => {
  it('is made from its private key, not taken from what the server holds', async () => {
    const s = await sodium();
    const a = await createAccountKeys('a long enough master password', FAST);
    // the server's copy of the keys, changed to a key of its own
    const { unlockWithMaster } = await import('./keys');
    const { deriveFromPassword } = await import('./keys');
    const { masterKey } = await deriveFromPassword('a long enough master password', a.keys.kdf_salt, a.keys.kdf_params);
    const swapped = { ...a.keys, public_key: toB64(s, s.crypto_box_keypair().publicKey) };
    const opened = await unlockWithMaster(masterKey, swapped);
    expect(eq(opened.publicKey, a.unlocked.publicKey)).toBe(true);
  });
});

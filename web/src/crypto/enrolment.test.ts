import { describe, it, expect } from 'vitest';
import { OpenError } from './seal.js';
import { createAccountKeys, unlockWithPasskey, type KdfParams, type VaultKeyPayload } from './keys.js';
import { fromCode, makeOffer, newEnrolmentCode, readEnrolmentCode, showCode } from './enrolment.js';

const FAST: KdfParams = { alg: 'argon2id13', ops: 2, memKiB: 19456 };

/** What the new device does with the code and what the server held: the sign-in path of a passkey, with the code's key in place of the PRF output. */
async function openOffer(code: string, wrapped: string, payload: VaultKeyPayload) {
  const { id, key } = await fromCode(code);
  return unlockWithPasskey(key, `enrol:${id}`, wrapped, payload);
}

describe('the one-time code of a new device', () => {
  it('is eighteen characters in groups of four, and reads back from what was typed', async () => {
    const code = await newEnrolmentCode();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{18}$/);
    expect(showCode(code)).toMatch(/^([0-9A-Z]{4}-){4}[0-9A-Z]{2}$/);
    for (const typed of [showCode(code), code.toLowerCase(), ` ${showCode(code).replace(/-/g, ' ')} `, code.replace(/0/g, 'o').replace(/1/g, 'l')]) {
      expect(await readEnrolmentCode(typed)).toEqual({ ok: true, code });
    }
  });

  it('catches a typing error, a missing character and a character that is not in the alphabet', async () => {
    const code = await newEnrolmentCode();
    const other = code[0] === '2' ? '3' : '2';
    expect(await readEnrolmentCode(other + code.slice(1))).toEqual({ ok: false, reason: 'check' });
    expect(await readEnrolmentCode(code.slice(1))).toEqual({ ok: false, reason: 'length' });
    expect(await readEnrolmentCode(`U${code.slice(1)}`)).toEqual({ ok: false, reason: 'characters' });
  });

  it('makes the same id and key from the same code, and others from another', async () => {
    const code = await newEnrolmentCode();
    const a = await fromCode(code);
    const b = await fromCode(code);
    expect(a.id).toBe(b.id);
    expect(a.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.key).toEqual(b.key);
    const c = await fromCode(await newEnrolmentCode());
    expect(c.id).not.toBe(a.id);
    // the id is not the key, and does not contain it
    expect(Buffer.from(a.key).toString('base64url')).not.toBe(a.id);
  });

  it('lets a new device open the account key with the code, and nothing else does', async () => {
    const account = await createAccountKeys('correct horse battery staple 41', FAST);
    const unlocked = account.unlocked;
    const offer = await makeOffer(unlocked);
    expect(offer.wrapped.length).toBeGreaterThanOrEqual(90);
    expect(offer.wrapped.length).toBeLessThanOrEqual(200);
    expect(offer.wrapped).toMatch(/^[A-Za-z0-9_-]+$/);

    const opened = await openOffer(offer.code, offer.wrapped, account.keys);
    expect(opened.accountKey).toEqual(unlocked.accountKey);
    expect(opened.privateKey).toEqual(unlocked.privateKey);

    // another code, a changed byte, and a sealed key made for another offer
    await expect(openOffer(await newEnrolmentCode(), offer.wrapped, account.keys)).rejects.toBeInstanceOf(OpenError);
    const other = await makeOffer(unlocked);
    await expect(openOffer(offer.code, other.wrapped, account.keys)).rejects.toBeInstanceOf(OpenError);
    const changed = offer.wrapped.slice(0, -2) + (offer.wrapped.endsWith('AA') ? 'BB' : 'AA');
    await expect(openOffer(offer.code, changed, account.keys)).rejects.toBeInstanceOf(OpenError);
  });
});

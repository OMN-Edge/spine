import { sodium, toB64 } from './sodium.js';
import { ALPHABET, decode32, encode32 } from './recovery-kit.js';
import { wrapForPasskey, type UnlockedKeys } from './keys.js';

/**
 * Letting a new device in from one that is signed in (TR-CRY-05, SECURITY.md M-41). The signed-in device makes a one-time code: 80 random
 * bits in sixteen characters of the recovery key's alphabet, then two check characters so a typing error is caught on the spot. Two things
 * are made from it and the server is given neither the code nor the second:
 *
 *   code ──BLAKE2b──▶ root ──▶ id        (public: what the new device asks the server for; it cannot be run back to the code)
 *                          └──▶ key       (the account key is sealed under it, the way a passkey's PRF output seals it)
 *
 * The sealed account key is what the server keeps until the new device collects it. Eighty bits are out of reach of a guess in the ten
 * minutes an offer lasts, and of a server that tries every code against the id it holds. The account key is sealed with the same call as
 * a passkey's, under the context `enrol:<id>`, so the new device opens the vault through the path a passkey sign-in already uses.
 */
const SECRET_CHARS = 16;
const CHECK_CHARS = 2;
const CONTEXT = 'spine/v1/enrolment-code';

/** A code as it is shown: groups of four. */
export const showCode = (code: string): string => code.replace(/(.{4})(?=.)/g, '$1-');

async function checkOf(secret: string): Promise<string> {
  const s = await sodium();
  return encode32(s.crypto_generichash(16, s.from_string(`spine-enrol-check-v1${secret}`), null).subarray(0, 2)).slice(0, CHECK_CHARS);
}

/** A new code, to show to the person and to type into the new device. */
export async function newEnrolmentCode(): Promise<string> {
  const s = await sodium();
  const secret = encode32(s.randombytes_buf(10)).slice(0, SECRET_CHARS);
  return `${secret}${await checkOf(secret)}`;
}

export type CodeRead = { ok: true; code: string } | { ok: false; reason: 'length' | 'characters' | 'check' };

/** Reads what was typed: case, dashes and spaces do not matter, and O is taken for 0 and I or L for 1. */
export async function readEnrolmentCode(typed: string): Promise<CodeRead> {
  const text = typed.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (text.length !== SECRET_CHARS + CHECK_CHARS) return { ok: false, reason: 'length' };
  if ([...text].some(c => !ALPHABET.includes(c))) return { ok: false, reason: 'characters' };
  const secret = text.slice(0, SECRET_CHARS);
  return (await checkOf(secret)) === text.slice(SECRET_CHARS) ? { ok: true, code: text } : { ok: false, reason: 'check' };
}

/** What a code makes: the id the server is asked for, and the key the account key is sealed under. */
export async function fromCode(code: string): Promise<{ id: string; key: Uint8Array }> {
  const s = await sodium();
  const secret = decode32(code.slice(0, SECRET_CHARS));
  const root = s.crypto_generichash(32, secret, s.from_string(CONTEXT));
  const id = toB64(s, s.crypto_kdf_derive_from_key(32, 1, 'spineenl', root));
  const key = s.crypto_kdf_derive_from_key(32, 2, 'spineenk', root);
  s.memzero(root);
  return { id, key };
}

/** The signed-in device: a code, and what the server is given for it. */
export async function makeOffer(unlocked: UnlockedKeys): Promise<{ code: string; id: string; wrapped: string }> {
  const code = await newEnrolmentCode();
  const { id, key } = await fromCode(code);
  try {
    return { code, id, wrapped: await wrapForPasskey(unlocked, key, `enrol:${id}`) };
  } finally {
    (await sodium()).memzero(key);
  }
}

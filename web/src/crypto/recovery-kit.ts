import { sodium } from './sodium.js';

/**
 * The recovery key as a person keeps it: 256 bits written in 52 characters of a base-32 alphabet without the look-alikes (no I, L, O, U),
 * then four check characters, in groups of four. The check is part of the BLAKE2b hash of the key, so a typing error is caught on the
 * spot instead of becoming a key that opens nothing. Reading ignores case, dashes and spaces and takes O for 0 and I or L for 1.
 */
export const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const KEY_CHARS = 52;
const CHECK_CHARS = 4;

export function encode32(bytes: Uint8Array): string {
  let bits = 0;
  let acc = 0;
  let out = '';
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET[(acc << (5 - bits)) & 31];
  return out;
}

export function decode32(text: string): Uint8Array {
  const out: number[] = [];
  let bits = 0;
  let acc = 0;
  for (const ch of text) {
    const v = ALPHABET.indexOf(ch);
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((acc >>> (bits - 8)) & 255);
      bits -= 8;
    }
    acc &= (1 << bits) - 1;
  }
  return Uint8Array.from(out);
}

async function checkOf(key: Uint8Array): Promise<string> {
  const s = await sodium();
  const input = new Uint8Array([...s.from_string('spine-kit-v1'), ...key]);
  return encode32(s.crypto_generichash(16, input, null).subarray(0, 3)).slice(0, CHECK_CHARS);
}

export async function newRecoveryKey(): Promise<Uint8Array> {
  const s = await sodium();
  return s.randombytes_buf(32);
}

/** `XXXX-XXXX-…`, fourteen groups. */
export async function writeRecoveryKey(key: Uint8Array): Promise<string> {
  const text = encode32(key).slice(0, KEY_CHARS) + (await checkOf(key));
  return text.match(/.{1,4}/g)!.join('-');
}

export type RecoveryKeyRead = { ok: true; key: Uint8Array } | { ok: false; reason: 'length' | 'characters' | 'check' };

export async function readRecoveryKey(typed: string): Promise<RecoveryKeyRead> {
  const text = typed
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (text.length !== KEY_CHARS + CHECK_CHARS) return { ok: false, reason: 'length' };
  if ([...text].some(c => !ALPHABET.includes(c))) return { ok: false, reason: 'characters' };
  const key = decode32(text.slice(0, KEY_CHARS)).slice(0, 32);
  if ((await checkOf(key)) !== text.slice(KEY_CHARS)) return { ok: false, reason: 'check' };
  return { ok: true, key };
}

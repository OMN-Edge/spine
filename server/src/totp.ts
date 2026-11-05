import {
  createCipheriv,
  createDecipheriv,
  createHash,
  scrypt,
  createHmac,
  hkdfSync,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'crypto';

/**
 * The second factor (SECURITY.md M-12): RFC 6238 time-based codes, plus recovery codes.
 *
 * Written on `node:crypto` rather than a library. The algorithm is short, the RFC
 * publishes test vectors that pin it, and a Pi should not carry a dependency for it.
 * Nothing here touches the store; `second-factor.ts` joins the two.
 */

export const STEP_SECONDS = 30;
export const CODE_DIGITS = 6;
/** Steps accepted either side of now, for a phone clock that has drifted. */
export const DRIFT_STEPS = 1;
const SECRET_BYTES = 20;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of text.toUpperCase().replace(/[\s=-]/g, '')) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error('not base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function generateSecret(): Buffer {
  return randomBytes(SECRET_BYTES);
}

/** RFC 4226: HMAC-SHA1 over the 8-byte counter, dynamic truncation. */
export function hotp(secret: Buffer, counter: number, digits = CODE_DIGITS): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(message).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const binary =
    ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export function stepAt(nowMs: number): number {
  return Math.floor(nowMs / 1000 / STEP_SECONDS);
}

/** Digits only, spaces tolerated (apps display "123 456"). Null if it is not shaped like a code. */
export function normaliseCode(input: string): string | null {
  const code = input.replace(/\s/g, '');
  return /^\d{6}$/.test(code) ? code : null;
}

/**
 * The time step a code is valid for, or null.
 *
 * Only steps newer than `lastStep` count, so a code that has been used (or an older one)
 * is refused even though it is still inside the drift window. All three candidates are
 * compared every time, without stopping at the first match.
 */
export function matchTotp(secret: Buffer, input: string, nowMs: number, lastStep: number): number | null {
  const code = normaliseCode(input);
  if (!code) return null;

  const current = stepAt(nowMs);
  let matched: number | null = null;
  for (let step = current - DRIFT_STEPS; step <= current + DRIFT_STEPS; step++) {
    const expected = Buffer.from(hotp(secret, step));
    if (timingSafeEqual(expected, Buffer.from(code)) && step > lastStep) matched = step;
  }
  return matched;
}

/** The `otpauth://` URI authenticator apps read from a QR code. */
export function otpauthUri(secret: Buffer, account: string, issuer: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret: base32Encode(secret),
    issuer,
    algorithm: 'SHA1',
    digits: String(CODE_DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params}`;
}

// ---- The secret at rest -----------------------------------------------------------------
//
// A password is verified by hashing what is typed and comparing, so it can be stored
// unrecoverably (P13). A TOTP secret has to be read back to compute the expected code, so
// it cannot be hashed. It is encrypted instead, under a key derived from SESSION_SECRET:
// the database alone then yields nothing, and no second secret needs configuring.
// The cost is S-21: rotating SESSION_SECRET makes every enrolment unreadable.

function key(): Buffer {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET is not set'); // config.ts refuses to start without it
  return Buffer.from(hkdfSync('sha256', secret, 'spine', 'spine totp secret v1', 32));
}

/** `v1.` + base64(iv | tag | ciphertext). The user id is authenticated but not stored. */
export function encryptSecret(userId: string, secret: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  cipher.setAAD(Buffer.from(userId));
  const body = Buffer.concat([cipher.update(secret), cipher.final()]);
  return `v1.${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')}`;
}

/**
 * Throws if the value was written under another SESSION_SECRET, was altered, or belongs
 * to another user: the user id is part of what is authenticated, so a row copied between
 * accounts does not decrypt.
 */
export function decryptSecret(userId: string, stored: string): Buffer {
  if (!stored.startsWith('v1.')) throw new Error('unknown secret format');
  const raw = Buffer.from(stored.slice(3), 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key(), raw.subarray(0, 12), { authTagLength: 16 });
  decipher.setAAD(Buffer.from(userId));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
}

// ---- Recovery codes ---------------------------------------------------------------------

/** No 0/1/I/O, so a code read from paper is not misread. 32 letters is exactly 5 bits each. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const RECOVERY_LENGTH = 10;
export const RECOVERY_CODE_COUNT = 10;

/** `XXXXX-XXXXX`: 50 bits, which is why they are stored with a slow hash (`hashRecoveryCode`). */
export function generateRecoveryCode(): string {
  let code = '';
  for (let i = 0; i < RECOVERY_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

/** Upper case, no separators; null if it cannot be a recovery code. */
export function normaliseRecoveryCode(input: string): string | null {
  const code = input.toUpperCase().replace(/[\s-]/g, '');
  if (code.length !== RECOVERY_LENGTH) return null;
  for (const char of code) if (!CODE_ALPHABET.includes(char)) return null;
  return code;
}

/**
 * What is stored for a recovery code: scrypt over the code, salted with the account's id (SECURITY.md S-42). A code is 50 bits, and a plain
 * SHA-256 of 50 bits falls to one graphics card in about a day for anyone with a copy of the database, which finds one of an account's ten
 * and stands in for the authenticator at the second step; a slow hash makes each guess cost what a password's does. It does not depend on
 * `SESSION_SECRET`, so the codes still work if that changes (S-21).
 */
export async function hashRecoveryCode(normalised: string, userId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    scrypt(normalised, `spine/recovery-code/v1:${userId}`, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key.toString('hex'))));
  });
}

/** How a code was stored before it was stored slowly: still accepted, once, from a code made then, until the codes are made again. */
export function legacyHashRecoveryCode(normalised: string): string {
  return createHash('sha256').update(normalised).digest('hex');
}

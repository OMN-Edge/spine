import { describe, it, expect, beforeEach } from 'vitest';
import {
  base32Decode,
  base32Encode,
  decryptSecret,
  encryptSecret,
  generateRecoveryCode,
  generateSecret,
  hashRecoveryCode,
  hotp,
  matchTotp,
  normaliseCode,
  normaliseRecoveryCode,
  otpauthUri,
  stepAt,
} from '../totp.js';

beforeEach(() => {
  process.env.SESSION_SECRET = 'test-secret-must-be-at-least-32-chars-long!!';
});

/** RFC 4226 appendix D and RFC 6238 appendix B both use this key. */
const RFC_KEY = Buffer.from('12345678901234567890');

describe('hotp / totp against the RFCs', () => {
  it('matches the RFC 4226 test values for counters 0 to 9', () => {
    const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
    expect(expected.map((_, counter) => hotp(RFC_KEY, counter))).toEqual(expected);
  });

  it('matches the RFC 6238 SHA-1 test times (8 digits, as the RFC prints them)', () => {
    const vectors: Array<[number, string]> = [
      [59, '94287082'],
      [1111111109, '07081804'],
      [1111111111, '14050471'],
      [1234567890, '89005924'],
      [2000000000, '69279037'],
      [20000000000, '65353130'],
    ];
    for (const [seconds, code] of vectors) {
      expect(hotp(RFC_KEY, stepAt(seconds * 1000), 8), `T=${seconds}`).toBe(code);
    }
  });
});

describe('base32', () => {
  it('matches the RFC 4648 vectors (without padding)', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Encode(Buffer.from('fooba'))).toBe('MZXW6YTB');
    expect(base32Encode(Buffer.from('f'))).toBe('MY');
  });

  it('round-trips random secrets, and tolerates case, spaces and dashes', () => {
    for (let i = 0; i < 50; i++) {
      const secret = generateSecret();
      const text = base32Encode(secret);
      expect(base32Decode(text).equals(secret)).toBe(true);
      expect(base32Decode(text.toLowerCase().replace(/(.{4})/g, '$1 ')).equals(secret)).toBe(true);
    }
  });

  it('rejects text that is not base32', () => {
    expect(() => base32Decode('not*base32!')).toThrow();
  });

  it('makes 20-byte secrets of 32 characters, the length apps expect', () => {
    expect(generateSecret()).toHaveLength(20);
    expect(base32Encode(generateSecret())).toHaveLength(32);
  });
});

describe('matchTotp', () => {
  const now = 1_700_000_000_000;
  const step = stepAt(now);
  const codeFor = (s: number) => hotp(RFC_KEY, s);

  it('accepts the current step and returns which one it was', () => {
    expect(matchTotp(RFC_KEY, codeFor(step), now, 0)).toBe(step);
  });

  it('accepts one step either side, for clock drift, and no further', () => {
    expect(matchTotp(RFC_KEY, codeFor(step - 1), now, 0)).toBe(step - 1);
    expect(matchTotp(RFC_KEY, codeFor(step + 1), now, 0)).toBe(step + 1);
    expect(matchTotp(RFC_KEY, codeFor(step - 2), now, 0)).toBeNull();
    expect(matchTotp(RFC_KEY, codeFor(step + 2), now, 0)).toBeNull();
  });

  it('refuses a step that is not newer than the last accepted one (replay)', () => {
    expect(matchTotp(RFC_KEY, codeFor(step), now, step)).toBeNull();
    expect(matchTotp(RFC_KEY, codeFor(step - 1), now, step)).toBeNull();
    expect(matchTotp(RFC_KEY, codeFor(step + 1), now, step)).toBe(step + 1);
  });

  it('refuses a wrong code, a code for another key, and anything not six digits', () => {
    const other = Buffer.from('another key entirely');
    expect(matchTotp(RFC_KEY, hotp(other, step), now, 0)).toBeNull();
    expect(matchTotp(RFC_KEY, '000000', now, 0)).toBeNull();
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 34 5x', '١٢٣٤٥٦']) {
      expect(matchTotp(RFC_KEY, bad, now, 0), bad).toBeNull();
    }
  });

  it('accepts the spaces an authenticator app shows ("123 456")', () => {
    const code = codeFor(step);
    expect(matchTotp(RFC_KEY, `${code.slice(0, 3)} ${code.slice(3)}`, now, 0)).toBe(step);
    expect(normaliseCode(' 123456 ')).toBe('123456');
  });
});

describe('otpauth URI', () => {
  it('carries the secret, issuer and parameters apps need, with the account escaped', () => {
    const uri = otpauthUri(RFC_KEY, 'a+b@example.com', 'spine.example.com');
    const url = new URL(uri);
    expect(url.protocol).toBe('otpauth:');
    expect(url.host).toBe('totp');
    expect(decodeURIComponent(url.pathname)).toBe('/spine.example.com:a+b@example.com');
    expect(url.searchParams.get('secret')).toBe(base32Encode(RFC_KEY));
    expect(url.searchParams.get('issuer')).toBe('spine.example.com');
    expect(url.searchParams.get('digits')).toBe('6');
    expect(url.searchParams.get('period')).toBe('30');
  });
});

describe('the secret at rest', () => {
  it('round-trips, and the stored value does not contain the secret', () => {
    const secret = generateSecret();
    const stored = encryptSecret('user-1', secret);
    expect(stored.startsWith('v1.')).toBe(true);
    expect(stored).not.toContain(base32Encode(secret));
    expect(Buffer.from(stored.slice(3), 'base64').includes(secret)).toBe(false);
    expect(decryptSecret('user-1', stored).equals(secret)).toBe(true);
  });

  it('uses a new nonce each time', () => {
    const secret = generateSecret();
    expect(encryptSecret('u', secret)).not.toBe(encryptSecret('u', secret));
  });

  it('does not decrypt for another user, so a copied row is useless', () => {
    const stored = encryptSecret('user-1', generateSecret());
    expect(() => decryptSecret('user-2', stored)).toThrow();
  });

  it('does not decrypt if altered, or under another SESSION_SECRET (S-21)', () => {
    const stored = encryptSecret('user-1', generateSecret());
    const raw = Buffer.from(stored.slice(3), 'base64');
    raw[raw.length - 1] ^= 1;
    expect(() => decryptSecret('user-1', `v1.${raw.toString('base64')}`)).toThrow();

    process.env.SESSION_SECRET = 'a-different-secret-that-is-32-chars-or-more!!';
    expect(() => decryptSecret('user-1', stored)).toThrow();
  });

  it('refuses an unknown format rather than guessing', () => {
    expect(() => decryptSecret('u', 'v9.AAAA')).toThrow(/format/);
  });
});

describe('recovery codes', () => {
  it('are XXXXX-XXXXX from an alphabet with no look-alike characters', () => {
    for (let i = 0; i < 200; i++) {
      expect(generateRecoveryCode()).toMatch(/^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);
    }
  });

  it('are different each time', () => {
    expect(new Set(Array.from({ length: 200 }, generateRecoveryCode)).size).toBe(200);
  });

  it('normalise case, dashes and spaces, and reject the wrong shape', () => {
    expect(normaliseRecoveryCode('abcde-fghjk')).toBe('ABCDEFGHJK');
    expect(normaliseRecoveryCode(' ABCDE FGHJK ')).toBe('ABCDEFGHJK');
    expect(normaliseRecoveryCode('ABCDE-FGHJ')).toBeNull(); // short
    expect(normaliseRecoveryCode('ABCDE-FGHJKL')).toBeNull(); // long
    expect(normaliseRecoveryCode('ABCDE-FGHJ0')).toBeNull(); // 0 is not in the alphabet
    expect(normaliseRecoveryCode('123456')).toBeNull(); // an authenticator code is not one
  });

  it('are stored as a hash that does not reveal them', () => {
    const hash = hashRecoveryCode('ABCDEFGHJK');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain('ABCDEFGHJK');
    expect(hash).toBe(hashRecoveryCode('ABCDEFGHJK'));
  });
});

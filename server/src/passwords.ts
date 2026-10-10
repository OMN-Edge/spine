import { hash, verify, Algorithm } from '@node-rs/argon2';
import { randomInt } from 'crypto';

/**
 * Password handling (SECURITY.md P13): argon2id with a per-hash salt, nothing
 * reversible, and no password in a log or an error.
 *
 * The parameters are the OWASP minimum for argon2id (19 MiB, 2 passes, 1 lane).
 * About 30 ms on a laptop; a Pi will be several times that, which is the right
 * order of magnitude for a login and still leaves it responsive.
 */
const PARAMS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

export const MIN_PASSWORD_LENGTH = 12;
/** Argon2 hashes the whole input, so an unbounded one is a cheap way to burn CPU. */
export const MAX_PASSWORD_LENGTH = 256;

export function checkPasswordPolicy(password: unknown): string | null {
  if (typeof password !== 'string') return 'password is required';
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `password must be at most ${MAX_PASSWORD_LENGTH} characters`;
  }
  return null;
}

export function hashPassword(password: string): Promise<string> {
  return hash(password, PARAMS);
}

/** False for a wrong password and for a stored value that is not a valid hash. */
export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  try {
    return await verify(storedHash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | null = null;

/**
 * Burn the same time as a real verification, for a login that names no such
 * account. Without it the response is measurably faster for an unknown email,
 * which tells an attacker which addresses have accounts.
 */
export async function verifyAgainstDummy(password: string): Promise<false> {
  dummyHash ??= hashPassword('spine-dummy-password-for-timing-only');
  await verifyPassword(await dummyHash, password);
  return false;
}

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Deliberately loose: the real check is that mail reaches the address. */
export function isPlausibleEmail(email: string): boolean {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/** Without look-alike characters (l, o, 0, 1). 5 groups of 4 from 32 symbols, ~100 bits. */
export function generatePassword(): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  const group = () =>
    Array.from({ length: 4 }, () => alphabet[randomInt(alphabet.length)]).join('');
  return Array.from({ length: 5 }, group).join('-');
}

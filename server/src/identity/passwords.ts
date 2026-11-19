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

/**
 * Words that make up most passwords of the right length that are guessed first (SECURITY.md S-34;
 * OWASP A07:2025, NIST SP 800-63B). A password is refused when, with its digits and punctuation
 * taken off, it is one of these, a few of them joined, or one of them with a short tail ("Password2024!").
 * A short list, held in the source so nothing leaves the host to check it; a breach service would be egress (P8).
 */
const COMMON_BASES = [
  'password', 'passw0rd', 'passphrase', 'qwerty', 'qwertyuiop', 'qwertz', 'azerty', 'asdfgh', 'asdfghjkl', 'zxcvbn',
  'zxcvbnm', 'letmein', 'welcome', 'iloveyou', 'admin', 'administrator', 'root', 'login', 'master', 'monkey',
  'dragon', 'sunshine', 'princess', 'football', 'baseball', 'basketball', 'superman', 'batman', 'trustno',
  'starwars', 'whatever', 'freedom', 'shadow', 'michael', 'jordan', 'charlie', 'hunter', 'secret', 'changeme',
  'default', 'guest', 'test', 'testing', 'abc', 'abcdef', 'abcdefgh', 'spine', 'archive', 'medical', 'health',
  'doctor', 'family', 'summer', 'winter', 'spring', 'autumn', 'parola', 'bineai', 'salut', 'bonjour',
  'motdepasse', 'passwort', 'hallo', 'geheim', 'cheie', 'secretul',
];

const SEQUENCES = ['0123456789', '1234567890', 'abcdefghijklmnopqrstuvwxyz', 'qwertyuiopasdfghjklzxcvbnm'];

function isSequenceOrRepeat(lowered: string): boolean {
  if (new Set(lowered).size <= 2) return true; // aaaaaaaaaaaa, abababababab
  const run = lowered.replace(/[^a-z0-9]/g, '');
  if (run.length < 8) return false;
  return SEQUENCES.some(seq => (seq + seq).includes(run) || ([...seq].reverse().join('').repeat(2)).includes(run));
}

function isCommonShape(lowered: string): boolean {
  const letters = lowered.replace(/@/g, 'a').replace(/\$/g, 's').replace(/[03]/g, d => (d === '0' ? 'o' : 'e')).replace(/[^a-z]/g, '');
  if (!letters) return false;
  // The words joined, or one of them and a tail of at most three more letters ("passwordxyz").
  let rest = letters;
  let guard = 0;
  while (rest && guard++ < 6) {
    const word = COMMON_BASES.filter(w => rest.startsWith(w)).sort((a, b) => b.length - a.length)[0];
    if (!word) break;
    rest = rest.slice(word.length);
  }
  return rest.length <= 3 && rest.length < letters.length;
}

export interface PasswordContext {
  /** The account's address, so a password cannot be made of it. */
  email?: string;
}

export function checkPasswordPolicy(password: unknown, context: PasswordContext = {}): string | null {
  if (typeof password !== 'string') return 'password is required';
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `password must be at most ${MAX_PASSWORD_LENGTH} characters`;
  }
  const lowered = password.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  const local = context.email?.split('@')[0]?.toLowerCase();
  if (isSequenceOrRepeat(lowered) || isCommonShape(lowered) || (local && local.length >= 4 && lowered.includes(local))) {
    return 'password is too easy to guess: use a longer phrase that is not a common word, a pattern or part of your address';
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

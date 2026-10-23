/**
 * The master password's policy, checked on the device because the server never sees the password (SECURITY.md M-34). It is the same
 * rule the server used to apply to the password it received: at least 12 characters, not a common word or pattern, not part of the
 * address. A short list held in the source, so nothing leaves the device to check it.
 */
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

/** Null if the password is acceptable, otherwise why not (a code, so the page can say it in the person's language). */
export type PasswordProblem = 'short' | 'long' | 'easy';

export function checkPasswordPolicy(password: string, context: PasswordContext = {}): PasswordProblem | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return 'short';
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return 'long';
  }
  const lowered = password.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  const local = context.email?.split('@')[0]?.toLowerCase();
  if (isSequenceOrRepeat(lowered) || isCommonShape(lowered) || (local && local.length >= 4 && lowered.includes(local))) {
    return 'easy';
  }
  return null;
}


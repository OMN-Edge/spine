import { type UserRecord, getAccountsStore } from 'spine-core/store/index.js';
import { logger } from 'spine-core/logger.js';
import { verifyPassword } from './passwords.js';
import { emailSecondFactorRequired } from './email-code.js';
import {
  RECOVERY_CODE_COUNT,
  decryptSecret,
  generateRecoveryCode,
  hashRecoveryCode,
  matchTotp,
  normaliseCode,
  normaliseRecoveryCode,
} from './totp.js';

/** Whether this user must present a second factor to sign in. */
export async function hasSecondFactor(userId: string): Promise<boolean> {
  return (await getAccountsStore().users.getTotp(userId))?.confirmed_at != null;
}

/**
 * What the second step of a sign-in is for this account (SECURITY.md S-20): an authenticator app when one is enrolled, which takes precedence; else a code
 * sent to the address, when the owner chose it or the operator requires it (`SPINE_EMAIL_2FA`); else none.
 */
export type SecondFactorMethod = 'authenticator' | 'email';
export async function secondFactorMethod(user: Pick<UserRecord, 'id' | 'email_second_factor'>): Promise<SecondFactorMethod | null> {
  if (await hasSecondFactor(user.id)) return 'authenticator';
  return user.email_second_factor === 1 || emailSecondFactorRequired() ? 'email' : null;
}

/** Whether the password is the account's: asked again for anything that changes the second step. */
export async function passwordIsRight(userId: string, password: unknown): Promise<boolean> {
  if (typeof password !== 'string' || !password) return false;
  const user = await getAccountsStore().users.findById(userId);
  return !!user && (await verifyPassword(user.password_hash, password));
}

/**
 * Checks something typed at the second step: an authenticator code or a recovery code.
 * Spending is atomic either way, so one value cannot be used twice, including by two
 * requests at once.
 */
export async function checkSecondFactor(user: Pick<UserRecord, 'id'>, input: string, now = Date.now()): Promise<boolean> {
  const store = getAccountsStore();
  const totp = await store.users.getTotp(user.id);
  if (!totp?.confirmed_at) return false;

  if (normaliseCode(input)) {
    let secret: Buffer;
    try {
      secret = decryptSecret(user.id, totp.secret_enc);
    } catch {
      // Written under another SESSION_SECRET (S-21). Recovery codes do not depend on it.
      logger.warn('totp secret cannot be read; was SESSION_SECRET changed?', { userId: user.id });
      return false;
    }
    const step = matchTotp(secret, input, now, totp.last_step);
    return step !== null && (await store.users.claimTotpStep(user.id, step));
  }

  const code = normaliseRecoveryCode(input);
  if (!code) return false;
  const used = await store.users.useRecoveryCode(user.id, await hashRecoveryCode(code, user.id), new Date(now).toISOString());
  if (used) logger.warn('recovery code used', { userId: user.id });
  return used;
}

/** Fresh codes in the form shown to the user, and the hashes to store. */
export async function newRecoveryCodes(userId: string): Promise<{ codes: string[]; hashes: string[] }> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
  return { codes, hashes: await Promise.all(codes.map(code => hashRecoveryCode(normaliseRecoveryCode(code)!, userId))) };
}

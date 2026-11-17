import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { composeMail } from './mail/layout.js';
import { recipientLanguage, tm, type Recipient } from './mail/i18n.js';
import type { MailMessage } from './mail/types.js';

/**
 * The second step for an account with no authenticator, when the operator asks for one (`SPINE_EMAIL_2FA=required`): a six-digit code mailed to the
 * address after the password was right. It proves the mailbox as well as the password; it does not help against a stolen mailbox (SECURITY.md S-20).
 * The code is kept in the pending login, which is in the session and so in the accounts database, as a keyed hash: it never sits in the clear, and it
 * is good for the pending login's own few minutes and for the one session that asked for it.
 */
export const emailSecondFactorRequired = (env: NodeJS.ProcessEnv = process.env): boolean => (env.SPINE_EMAIL_2FA ?? '').trim().toLowerCase() === 'required';

export const newEmailCode = (): string => String(randomInt(0, 1_000_000)).padStart(6, '0');

const keyed = (userId: string, code: string): Buffer =>
  createHmac('sha256', process.env.SESSION_SECRET ?? '').update(`email-2fa\0${userId}\0${code}`, 'utf8').digest();

export const hashEmailCode = (userId: string, code: string): string => keyed(userId, code).toString('hex');

/** Whether what was typed is the code the hash was made from: spaces and dashes are ignored, as for the other codes. */
export function emailCodeMatches(userId: string, typed: string, hash: string): boolean {
  const digits = typed.replace(/[\s-]/g, '');
  if (!/^\d{6}$/.test(digits)) return false;
  const want = Buffer.from(hash, 'hex');
  const got = keyed(userId, digits);
  return want.length === got.length && timingSafeEqual(want, got);
}

export function signInCodeMail(to: Recipient, code: string): MailMessage {
  const lang = recipientLanguage(to);
  return composeMail({
    to,
    subject: tm(lang, 'Your sign-in code'),
    heading: tm(lang, 'Your sign-in code'),
    intro: [tm(lang, 'Type this code in the page where you just entered your password:')],
    details: [[tm(lang, 'Code'), code]],
    outro: [tm(lang, 'The code works once and expires in five minutes. If you did not just try to sign in, someone knows your password: reset it.')],
  });
}

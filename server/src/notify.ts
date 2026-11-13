import type { FastifyRequest } from 'fastify';
import { getMailer, type MailMessage } from './mail/index.js';
import { composeMail } from './mail/layout.js';
import { recipientLanguage, tm, type Recipient } from './mail/i18n.js';

/**
 * Mail about the account itself, sent after the response and only when a mailer exists. Never medical text
 * (SECURITY.md P8): what happened to the account and when, nothing about the records. A failure is logged with the
 * provider's status and never the message.
 */
export function mailAfter(req: FastifyRequest, userId: string, message: MailMessage, what: string): void {
  const mailer = getMailer();
  if (!mailer.enabled) return;
  void mailer.send(message).catch(err => {
    req.log.error({ userId, err: err instanceof Error ? err.message : String(err) }, `could not send ${what} mail`);
  });
}

export function newSignInMail(to: Recipient, at: string): MailMessage {
  const lang = recipientLanguage(to);
  return composeMail({
    to,
    subject: tm(lang, 'New sign-in to your account'),
    heading: tm(lang, 'New sign-in to your account'),
    intro: [tm(lang, 'Your account was signed in from a browser it had not been used from before, at {at} (UTC).', { at })],
    outro: [tm(lang, 'If that was you, there is nothing to do. If it was not, sign in, open Account, end the sign-ins you do not recognise and change your password.')],
  });
}

/**
 * What a security-change mail can say, by name: the English sentence is the source of its translation (mail/i18n.ts), and `{email}` is the
 * one value a sentence takes. Never a word about the records themselves.
 */
export const CHANGES = {
  emailRecoveryOn: 'Recovery of your account by email was turned on',
  emailRecoveryOff: 'Recovery of your account by email was turned off',
  wiped: 'Your records were erased and your account started over with a new password',
  seatRemoved: 'Your seat in a shared plan was ended by the account that pays for it: your records are untouched and your account has its own plan again',
  seatTaken: '{email} accepted your invitation and holds a seat in your plan',
  seatLeft: '{email} gave up its seat in your plan',
  delegationAccepted: "Someone accepted your invitation to a profile: their access starts when you confirm the code they read out to you, on that profile's page",
  promoted: 'The records of a person you looked after were taken over by that person, and your access to them is paused until they let you back in',
  deviceEnrolled: 'A device was let in to your account by one that was signed in',
  passwordChanged: 'Your password was changed',
  recoveryKitReplaced: 'Your recovery kit was replaced',
  passkeyAdded: 'A passkey was added to your account',
  passkeyClosedVault: 'A passkey can no longer open your records',
  passkeyOpensVault: 'A passkey can now open your records',
  passkeyRemoved: 'A passkey was removed from your account',
  twoFactorOn: 'Two-factor sign-in was turned on',
  twoFactorOff: 'Two-factor sign-in was turned off',
  resetByLink: 'Your password was reset with a link sent to this address',
  resetByLinkErased: 'Your password was reset with a link sent to this address, and your records were erased',
} as const;
export type Change = keyof typeof CHANGES;

export function securityChangeMail(to: Recipient, change: Change, at: string, values?: { email?: string }): MailMessage {
  const lang = recipientLanguage(to);
  return composeMail({
    to,
    subject: tm(lang, 'A security setting on your account changed'),
    heading: tm(lang, 'A security setting changed'),
    intro: [tm(lang, '{what} at {at} (UTC).', { what: tm(lang, CHANGES[change], values), at })],
    outro: [tm(lang, 'If that was you, there is nothing to do. If it was not, someone has your password: ask the person who runs this service to reset it and to turn off two-factor sign-in, then sign in and end the sign-ins you do not recognise.')],
  });
}

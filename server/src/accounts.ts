import { removeFromBackup } from './backup.js';
import { removeAllObjects } from './vault-files.js';
import { removeShare } from './shared-files.js';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { publicUrl, resolveBackupDir } from 'spine-core/config.js';
import { type UserTokenKind, getAccountsStore } from 'spine-core/store/index.js';
import type { VaultKeys } from 'spine-core/store/types.js';
import { createUserToken, hashUserToken } from './user-tokens.js';
import { hashPassword } from './passwords.js';
import type { MailMessage } from './mail/index.js';
import { composeMail } from './mail/layout.js';

/**
 * How long a link works. Verification can sit in an inbox overnight; a reset is
 * something the user is doing right now, and the shorter it lives the less a
 * forwarded or leaked one is worth.
 */
export const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
export const RESET_TTL_MS = 60 * 60 * 1000;

/**
 * Issue a token, replacing any unspent one of the same kind, and return it. This
 * is the only time the raw value exists on the server.
 */
export async function issueUserToken(
  userId: string,
  kind: UserTokenKind,
  ttlMs: number,
): Promise<string> {
  const store = getAccountsStore();
  await store.users.invalidateTokens(userId, kind);

  const token = createUserToken();
  const now = Date.now();
  await store.users.createToken({
    id: uuidv4(),
    userId,
    kind,
    tokenHash: hashUserToken(token),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
  });
  return token;
}

/**
 * The token goes in the URL **fragment**. A fragment is never sent to the server,
 * so it stays out of nginx's access log, and never in a Referer header. The page
 * reads it and posts it.
 */
export const verificationLink = (token: string) => publicUrl(`/verify#${token}`);
export const resetLink = (token: string) => publicUrl(`/reset#${token}`);
export const signInLink = () => publicUrl('/login');

/**
 * No medical content: nothing about records, documents or health. The subject and
 * sender are visible to the mail provider and to anyone who sees the inbox, so what
 * the sender is called is the operator's choice (SECURITY.md P8).
 */
export function verificationMail(to: string, link: string): MailMessage {
  return composeMail({
    to,
    subject: 'Confirm your email address',
    heading: 'Confirm your email address',
    intro: ['Confirm your email address to finish creating your account:'],
    action: { label: 'Confirm email address', url: link },
    outro: ['The link works once and expires in 24 hours. If you did not ask for this, ignore this message.'],
  });
}

/** Sent when the administrator approves an account (only when a mailer is set up). Neutral like the rest. */
export function approvedMail(to: string, link: string): MailMessage {
  return composeMail({
    to,
    subject: 'Your account is ready',
    heading: 'Your account is ready',
    intro: ['Your account has been approved. You can sign in now:'],
    action: { label: 'Sign in', url: link },
  });
}

export function resetMail(to: string, link: string): MailMessage {
  return composeMail({
    to,
    subject: 'Reset your password',
    heading: 'Reset your password',
    intro: ['Choose a new password:'],
    action: { label: 'Choose a new password', url: link },
    outro: ['The link works once and expires in one hour. If you did not ask for this, ignore this message — your password has not changed.'],
  });
}

/**
 * Tells the owner that a browser is waiting to open one of their share links. Neutral like the rest: no label, no
 * note, nothing about what is shared (the label is the owner's own words and may name a doctor or a condition, the
 * note is a stranger's). The link opens a page that asks them to sign in, so it grants nothing by itself.
 */
/** Said when someone opens the owner's card; the wording names no record, because the mail is the provider's to see (SECURITY.md P8). */
export function cardOpenedMail(to: string, at: string, country: string | null): MailMessage {
  return composeMail({
    to,
    subject: 'Your Spine card was opened',
    heading: 'Your Spine card was opened',
    intro: [`Your Spine card was opened at ${at} (UTC)${country ? `, from ${country}` : ''}.`],
    action: { label: 'Open Spine', url: signInLink() },
    outro: ['If you, or someone you showed it to, opened it, there is nothing to do. If not, sign in, open the card and turn it off.'],
  });
}

/** Once a year, for a card not looked at: it names nothing that is on it, and the mail is the provider's to see (SECURITY.md P8). */
export function cardReviewMail(to: string): MailMessage {
  return composeMail({
    to,
    subject: 'A reminder about your Spine card',
    heading: 'Is your Spine card still right?',
    intro: ['It has been a year since you last looked at your Spine card.'],
    action: { label: 'Open Spine', url: signInLink() },
    outro: ['Sign in, open the card and check that it is still right. If you do nothing it stays as it is, and we will write once more next year.'],
  });
}

/** A reminder is due. It says that and nothing of what it is for: no medical content ever goes by mail (SECURITY.md M-53). */
export function remindersDueMail(to: string, n: number): MailMessage {
  return composeMail({
    to,
    subject: n === 1 ? 'A reminder is due in Spine' : 'Reminders are due in Spine',
    heading: n === 1 ? 'A reminder is due' : `${n} reminders are due`,
    intro: [`${n === 1 ? 'A reminder you set in Spine is due' : `${n} reminders in Spine are due`}.`],
    action: { label: n === 1 ? 'See the reminder' : 'See the reminders', url: signInLink() },
    outro: [`Sign in to see ${n === 1 ? 'it' : 'them'}. This message does not say what ${n === 1 ? 'it is' : 'they are'} about.`],
  });
}

export function accessRequestMail(to: string, link: string, requestedAt: string, ip: string | null): MailMessage {
  return composeMail({
    to,
    subject: 'Someone is waiting for your approval',
    heading: 'Someone is waiting for your approval',
    intro: ['A link you shared was opened in a browser that is waiting for your approval:'],
    action: { label: 'Review the request', url: link },
    details: [['Requested at', `${requestedAt}${ip ? ` from ${ip}` : ''}`]],
    outro: ['Sign in to approve or deny it. If you do not expect this, deny it, or revoke the link from the Share links page.'],
  });
}

export interface DeletedAccount {
  /** Sealed objects in its vault. The server knows no more of what it holds: no uploads or documents. */
  objects: number;
}

/**
 * What deleting an account would remove, without removing it. Counted from the vault, the only thing of its records the server has,
 * so the CLI can show it before asking for confirmation.
 */
export async function describeAccount(userId: string): Promise<DeletedAccount> {
  const objects = await getAccountsStore().vault.list(userId, 0);
  return { objects: objects.filter(o => !o.deleted).length };
}

/**
 * Remove an account, its rows and its files, including the backup mirror's copy of its
 * vault, which would otherwise keep them for good. Database snapshots already taken still contain the rows until retention prunes
 * them (7 by default).
 *
 * Files first: if the process dies halfway, the account still exists and the
 * command can be run again, whereas rows deleted first would leave sealed files
 * nothing refers to. And the backup's copy before the live one: it is the step
 * most likely to fail (the backup is often on another disk, which the process
 * must be allowed to write to: `spine-web.service`), and when it does nothing is
 * gone yet. The other way round, an account was left signed in with no records.
 */
export async function deleteAccount(userId: string): Promise<DeletedAccount> {
  const summary = await describeAccount(userId);
  await removeFiles(userId);
  await getAccountsStore().users.delete(userId);
  return summary;
}

/**
 * Start over: everything the account holds goes, as `deleteAccount` removes it, but the account itself stays, with its address, second
 * factor, passkeys and plan (`users.wipe` says what goes), and a new, empty vault takes the old one's place. The new vault is made on the
 * device (a new master password and recovery kit) and installed here in the same step, because the master password is the account's
 * credential: with the old vault's keys gone and no new ones, the next sign-in would derive nothing and the account could not be entered.
 * The same order as a deletion, files first and the backup's copy first of all, so a failure there leaves everything as it was; the new
 * credential is checked and hashed before anything is removed. Every sign-in ends (setting the password moves its version).
 */
export async function wipeAccount(userId: string, fresh: { authValue: string; keys: VaultKeys }): Promise<DeletedAccount> {
  const store = getAccountsStore();
  const summary = await describeAccount(userId);
  const passwordHash = await hashPassword(fresh.authValue);
  await removeFiles(userId);
  await store.users.wipe(userId);
  await store.users.setPassword(userId, passwordHash);
  await store.vault.putKeys(userId, fresh.keys, new Date().toISOString());
  return summary;
}

/** The sealed vault, the backup's copy and then the live one, so no ciphertext of the account is left; then the sealed shares' files. */
async function removeFiles(userId: string): Promise<void> {
  removeFromBackup(userId, resolveBackupDir());
  await removeAllObjects(userId);
  for (const id of await getAccountsStore().shared.eraseFor(userId)) await removeShare(id);
}

/**
 * Accounts whose address was never confirmed end after a week (SECURITY.md S-51): open registration made a row for each sign-up, and a spread of
 * addresses filled the table with rows nobody would ever use. An account waiting for the operator's approval is not one of them, and neither is
 * one the operator made, which is confirmed at creation. Returns how many ended.
 */
export async function sweepUnverified(now = new Date(), days = 7): Promise<number> {
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
  let ended = 0;
  for (const user of await getAccountsStore().users.list()) {
    if (user.email_verified_at === null && user.approved !== 0 && user.created_at < cutoff) {
      await deleteAccount(user.id);
      ended++;
    }
  }
  return ended;
}

import { removeAllObjects } from './vault-files.js';
import { removeShare } from './shared-files.js';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { publicUrl, resolveBackupDir, resolveDataDir } from './config.js';
import { getStore, type UserTokenKind } from './store/index.js';
import { createUserToken, hashUserToken } from './user-tokens.js';
import type { MailMessage } from './mail/index.js';

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
  const store = getStore();
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

/**
 * No medical content: nothing about records, documents or health. The subject and
 * sender are visible to the mail provider and to anyone who sees the inbox, so what
 * the sender is called is the operator's choice (SECURITY.md P8).
 */
export function verificationMail(to: string, link: string): MailMessage {
  return {
    to,
    subject: 'Confirm your email address',
    text:
      `Confirm your email address to finish creating your account:\n\n${link}\n\n` +
      `The link works once and expires in 24 hours. If you did not ask for this, ignore this message.\n`,
  };
}

export function resetMail(to: string, link: string): MailMessage {
  return {
    to,
    subject: 'Reset your password',
    text:
      `Choose a new password:\n\n${link}\n\n` +
      `The link works once and expires in one hour. If you did not ask for this, ignore this message ` +
      `— your password has not changed.\n`,
  };
}

/**
 * Tells the owner that a browser is waiting to open one of their share links. Neutral like the rest: no label, no
 * note, nothing about what is shared (the label is the owner's own words and may name a doctor or a condition, the
 * note is a stranger's). The link opens a page that asks them to sign in, so it grants nothing by itself.
 */
export function accessRequestMail(to: string, link: string, requestedAt: string, ip: string | null): MailMessage {
  return {
    to,
    subject: 'Someone is waiting for your approval',
    text:
      `A link you shared was opened in a browser that is waiting for your approval:\n\n${link}\n\n` +
      `Requested at ${requestedAt}${ip ? ` from ${ip}` : ''}.\n\n` +
      `Sign in to approve or deny it. If you do not expect this, deny it, or revoke the link from the Share links page.\n`,
  };
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
  const objects = await getStore().vault.list(userId, 0);
  return { objects: objects.filter(o => !o.deleted).length };
}

/**
 * Remove an account, its rows and its files, including the copy of its originals in
 * the backup mirror, which is forward-only and would otherwise keep them for good.
 * Database snapshots already taken still contain the rows until retention prunes
 * them (7 by default).
 *
 * Files first: if the process dies halfway, the account still exists and the
 * command can be run again, whereas rows deleted first would leave originals
 * nothing refers to.
 */
export async function deleteAccount(userId: string): Promise<DeletedAccount> {
  const store = getStore();
  const summary = await describeAccount(userId);
  const dataDir = resolveDataDir();

  // Files an earlier build wrote in plaintext, if this data directory has any (the server writes none now, SECURITY.md M-37).
  fs.rmSync(path.join(dataDir, 'originals', userId), { recursive: true, force: true });
  fs.rmSync(path.join(resolveBackupDir(), 'originals', userId), { recursive: true, force: true });

  // The sealed vault: the live copy and the backup's, so no ciphertext of the account is left.
  removeAllObjects(userId);
  fs.rmSync(path.join(resolveBackupDir(), 'vault', userId), { recursive: true, force: true });
  // The sealed shares too (their rows go with the account's, below).
  for (const id of await store.shared.eraseFor(userId)) removeShare(id);
  await store.users.delete(userId);
  return summary;
}

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

export interface DeletedAccount {
  uploads: number;
  documents: number;
}

/**
 * What deleting an account would remove, without removing it. Counted from the
 * store so the CLI can show it before asking for confirmation.
 */
export async function describeAccount(userId: string): Promise<DeletedAccount> {
  const store = getStore();
  const uploads = await store.sourceFiles.listFor(userId);
  const documents = await store.documents.listFor(userId, { limit: 1_000_000, offset: 0 });
  return { uploads: uploads.length, documents: documents.length };
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

  for (const upload of await store.sourceFiles.listFor(userId)) {
    fs.rmSync(path.join(dataDir, 'pages', upload.id), { recursive: true, force: true });
  }
  fs.rmSync(path.join(dataDir, 'originals', userId), { recursive: true, force: true });
  fs.rmSync(path.join(resolveBackupDir(), 'originals', userId), { recursive: true, force: true });

  await store.users.delete(userId);
  return summary;
}

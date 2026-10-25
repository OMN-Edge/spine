/**
 * Telling an owner by mail that a browser asked to open their share, for the routes that do it themselves (the server's own tests of the
 * route files, where a link works without a device). The server registers one that sends through its mailer (`server/src/owner-notices.ts`);
 * the device registers none: it asks the server to mail the owner through its share host (`share-host.ts`, `mailsOwner`).
 */
export interface OwnerNotices {
  /** Whether a mailer is configured. */
  enabled(): boolean;
  /** Mails the owner. The caller does not wait for it and logs a failure. */
  accessRequested(owner: { email: string }, requestId: string, requestedAt: string, ip: string | null): Promise<void>;
}

let current: OwnerNotices | null = null;
export const useOwnerNotices = (notices: OwnerNotices | null): void => { current = notices; };
export const ownerNotices = (): OwnerNotices | null => current;

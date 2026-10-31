import type { ShareLinkSummary } from './store/types.js';

/**
 * What a device does for a share that the server's code cannot (docs/crypto-design.md, stage 4): make the sealed copy, send it to the
 * server, and answer a browser that asks to be let in. The route files call it; the device supplies it (`web/src/core/share-host.ts`), and a
 * process without one cannot make, change or revoke a share: the owner's share routes answer 503.
 */
export interface PublishInput {
  link: ShareLinkSummary;
  userId: string;
  /** The documents the link shares now. */
  documentIds: string[];
  /** A new key, so a copy made under the old one stops opening (the approval setting changed); otherwise the link's own is kept. */
  newKey: boolean;
  /** Send nothing if the copy would hold what the last one did (a link that follows the records looks again after each change). */
  unlessUnchanged?: boolean;
}

export interface ShareHost {
  /** Seals and sends the copy; gives the key (base64url) it was made with, and whether anything was sent. */
  publish(input: PublishInput): Promise<{ key: string; published: boolean; digest: string }>;
  /** A change of end time or approval that does not change what is in the copy. */
  update(link: { id: string; expiresAt: string; requireApproval: boolean }): Promise<void>;
  revoke(linkId: string): Promise<void>;
  /** What visitors did since the last time (requests, openings) is brought into the owner's records. */
  pull(userId: string): Promise<void>;
  /** An answer to a visitor's request: for an approval, the share key wrapped to that visitor's key. */
  answer(userId: string, request: { id: string; linkId: string; visitorKey: string }, decision: 'approve' | 'deny', shareKey: string | null): Promise<void>;
  /**
   * The emergency card: seals it under a key and sends it as a bundle of its own kind that opens with no approval and no end. With no id and
   * no key a new pair is made; with them the same card is replaced, so the address already printed keeps working.
   */
  publishCard(input: { id: string | null; key: string | null; content: string }): Promise<{ id: string; key: string }>;
  /** Turns the card off at the server: its sealed bytes are deleted and its address stops opening. */
  revokeCard(id: string): Promise<void>;
  /** Whether the server tells the owner by mail when a browser asks to be let in. */
  mailsOwner(): boolean;
  /** The address to give the recipient: the link's id and, for a link that needs no approval, its key after the #. */
  addressOf(linkId: string, key: string | null): string;
}

let current: ShareHost | null = null;
export const useShareHost = (host: ShareHost | null): void => { current = host; };
export const shareHost = (): ShareHost | null => current;

/** Whether the server tells the owner by mail when a browser asks to open a link. False if this process has no share host. */
export const ownerCanBeMailed = (): boolean => current?.mailsOwner() ?? false;

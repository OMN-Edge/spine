import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AccountsStore } from 'spine-core/store/types.js';
import { addExtraPages } from './addons.js';

/**
 * The invitation bonus (the marketing plan): when a person invited by a link makes an account, or takes a seat in a plan they were invited to, both sides get
 * 10 more pages, once for that person, and an inviting account is rewarded for at most 5 of them. The pages are the same as a top-up's (`addons.ts`): used
 * once the month's are, and they do not run out with the month.
 *
 * **Nothing records who invited whom.** The link carries the inviter's id and a signature only this server can make (`inviteToken`); on making the account the
 * server checks it, adds the pages to both and counts, on each account, that it happened (a number on the inviter, a yes on the invitee). The link is
 * not secret and can be passed on; what bounds it is the five and the once, which cost at most 50 pages for any one account.
 */
export const BONUS_PAGES = 10;
export const MAX_REWARDED = 5;
const RECEIVED = 'bonus:received';
const REWARDED = 'bonus:rewarded';

const mac = (userId: string) => createHmac('sha256', process.env.SESSION_SECRET ?? '').update(`invite\0${userId}`, 'utf8').digest('hex').slice(0, 24);
/** What an invitation link carries: the account that invites and a signature. */
export const inviteToken = (userId: string): string => `${userId}.${mac(userId)}`;
export function inviterOf(token: unknown): string | null {
  if (typeof token !== 'string' || token.length > 120) return null;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;
  const id = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1), 'utf8');
  const expected = Buffer.from(mac(id), 'utf8');
  return given.length === expected.length && timingSafeEqual(given, expected) ? id : null;
}

/** Gives both sides their pages, if the token is good, the inviter is another account that exists, the invitee has not had one and the inviter has not had five. Answers whether it did. */
export async function grantInvitation(store: AccountsStore, token: unknown, inviteeId: string): Promise<boolean> {
  const inviterId = inviterOf(token);
  if (!inviterId || inviterId === inviteeId || !(await store.users.findById(inviterId)) || !(await store.users.findById(inviteeId))) return false;
  if ((await store.usage.aiAdd(inviteeId, RECEIVED, 1)) !== 1) return false;
  if ((await store.usage.aiAdd(inviterId, REWARDED, 1)) > MAX_REWARDED) return false;
  await addExtraPages(store, inviteeId, BONUS_PAGES);
  await addExtraPages(store, inviterId, BONUS_PAGES);
  await store.metrics.bump('invitation_bonus', new Date().toISOString().slice(0, 10)).catch(() => undefined);
  return true;
}

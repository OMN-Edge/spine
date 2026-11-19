import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AccountsStore } from 'spine-core/store/types.js';
import { addExtraPages } from './addons.js';

/**
 * The invitation bonus (the marketing plan): a person invited by a link gets 10 more pages when they make an account, once, and the account that invited them gets 50
 * when that person first buys a plan (Essential, Premium, Family or the founding one: a top-up alone is not a plan), for at most 5 of them. The pages are the same as a top-up's
 * (`addons.ts`): used once the month's are, and they do not run out with the month; on the free plan they also raise the pages kept (`keptLimit`), so what they read can be kept.
 *
 * **Who invited whom is kept only until it is used.** The link carries the inviter's id and a signature only this server can make (`inviteToken`). On making the account the server
 * checks it, gives the invitee their pages and keeps the inviter's id on the invitee's account (`store.invitations`). The first time that account buys a plan the row is taken and
 * deleted, and the inviter is rewarded; a row is forgotten after 90 days, and with either account. Nobody is told who bought: the inviter's count only goes up. The link is not
 * secret and can be passed on; what bounds it is the once and the five, which cost at most 250 pages for one account and 10 for another.
 */
export const BONUS_PAGES = 10;
/** What the inviter gets when the person they invited buys a plan. */
export const REWARD_PAGES = 50;
export const MAX_REWARDED = 5;
/** How long a link waits for a purchase. */
export const LINK_DAYS = 90;
const RECEIVED = 'bonus:received';
const REWARDED = 'bonus:rewarded';
/** The pages the invitations gave an account, which the free plan keeps over its own limit. */
const KEPT = 'bonus:kept';

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

/** The pages an account may keep over its plan's limit, because of its invitations: the invitee's pages and what the inviter was rewarded. */
export const keptBonus = (store: AccountsStore, user: string): Promise<number> => store.usage.aiUsed(user, KEPT);

const daysBefore = (at: Date, days: number): string => new Date(at.getTime() - days * 86_400_000).toISOString();

/** Gives the invitee their pages, if the token is good, the inviter is another account that exists and the invitee has not had one, and keeps who invited them until they buy. Answers whether it did. */
export async function grantInvitation(store: AccountsStore, token: unknown, inviteeId: string, now: Date = new Date()): Promise<boolean> {
  const inviterId = inviterOf(token);
  if (!inviterId || inviterId === inviteeId || !(await store.users.findById(inviterId)) || !(await store.users.findById(inviteeId))) return false;
  if ((await store.usage.aiAdd(inviteeId, RECEIVED, 1)) !== 1) return false;
  await store.invitations.sweep(daysBefore(now, LINK_DAYS));
  await store.invitations.record(inviteeId, inviterId, now.toISOString());
  await addExtraPages(store, inviteeId, BONUS_PAGES);
  await store.usage.aiAdd(inviteeId, KEPT, BONUS_PAGES);
  await store.metrics.bump('invitation_bonus', now.toISOString().slice(0, 10)).catch(() => undefined);
  return true;
}

/** An account bought a plan: if someone invited it, they are rewarded, once, and the link is forgotten. Answers whether it rewarded. A fifth reward is the last. */
export async function rewardInviter(store: AccountsStore, buyerId: string, now: Date = new Date()): Promise<boolean> {
  const inviterId = await store.invitations.take(buyerId, daysBefore(now, LINK_DAYS));
  if (!inviterId || !(await store.users.findById(inviterId))) return false;
  if ((await store.usage.aiAdd(inviterId, REWARDED, 1)) > MAX_REWARDED) return false;
  await addExtraPages(store, inviterId, REWARD_PAGES);
  await store.usage.aiAdd(inviterId, KEPT, REWARD_PAGES);
  await store.metrics.bump('invitation_reward', now.toISOString().slice(0, 10)).catch(() => undefined);
  return true;
}

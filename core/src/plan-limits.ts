import { getStore } from './store/index.js';

/**
 * What a plan limits that only the app can count. The records are sealed on the device, so the server cannot count pages (it sees
 * sealed objects, not what is in them): the app is told the limit by the account's plan (`GET /api/billing`) and holds to it, before it spends
 * anything on a file. What costs money stays the server's to count and refuse (the relay's meters, storage
 * and links, SECURITY.md **M-45**), so a changed app can keep more pages than the plan says, and nothing more than the plan pays for.
 * Null: no limit (a plan with none, an instance with no plans, a process with no app to tell it, as the server's tests). Pages, not documents: a
 * document is only a grouping of pages, so splitting, merging and moving pages never change what a plan keeps.
 */
export interface PlanLimits { pages: number | null }
let limits: PlanLimits = { pages: null };

export function usePlanLimits(next: PlanLimits): void { limits = next; }
export const planLimits = (): PlanLimits => limits;

/** A change refused because the plan keeps no more: answered 402 `plan_required`, with words the screens know (`web/src/billing.ts`). */
export class PlanLimitError extends Error {
  readonly statusCode = 402;
  readonly code = 'plan_required';
  constructor(message = 'more pages are not part of the account’s plan') {
    super(message);
    this.name = 'PlanLimitError';
  }
}

/**
 * Refuses when keeping `additional` more pages would pass the plan's limit; nothing is ever deleted, only adding is held back. `replacing` is how many of the
 * pages kept are the ones `additional` replaces (an upload read again), so it does not count against itself.
 */
export async function requirePageRoom(userId: string, additional = 1, replacing = 0): Promise<void> {
  const max = limits.pages;
  if (max === null || additional <= 0) return;
  if ((await getStore().pages.count(userId)) - replacing + additional > max) throw new PlanLimitError();
}

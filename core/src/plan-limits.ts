import { getStore } from './store/index.js';

/**
 * What a plan limits that only the app can count. The records are sealed on the device, so the server cannot count documents (it sees
 * sealed objects, not what is in them): the app is told the limit by the account's plan (`GET /api/billing`) and holds to it, before it spends
 * anything on a file and before it makes the documents. What costs money stays the server's to count and refuse (the relay's meters, storage
 * and links, SECURITY.md **M-45**), so a changed app can keep more documents than the plan says, and nothing more than the plan pays for.
 * Null: no limit (a plan with none, an instance with no plans, a process with no app to tell it, as the server's tests).
 */
export interface PlanLimits { documents: number | null }
let limits: PlanLimits = { documents: null };

export function usePlanLimits(next: PlanLimits): void { limits = next; }
export const planLimits = (): PlanLimits => limits;

/** A change refused because the plan keeps no more: answered 402 `plan_required`, with words the screens know (`web/src/billing.ts`). */
export class PlanLimitError extends Error {
  readonly statusCode = 402;
  readonly code = 'plan_required';
  constructor(message = 'another document is not part of the account’s plan') {
    super(message);
    this.name = 'PlanLimitError';
  }
}

/** Refuses when keeping `additional` more documents would pass the plan's limit; nothing is ever deleted, only adding is held back. */
export async function requireDocumentRoom(userId: string, additional = 1): Promise<void> {
  const max = limits.documents;
  if (max === null || additional <= 0) return;
  if ((await getStore().documents.count(userId)) + additional > max) throw new PlanLimitError();
}

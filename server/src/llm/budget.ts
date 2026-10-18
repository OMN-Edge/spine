import { llmDailyCalls } from '../config.js';
import { logger } from '../logger.js';

/**
 * An instance-wide count of model calls for the current UTC day (SECURITY.md S-35). In memory: a restart starts the
 * count again, which an outsider cannot cause, and the provider's own budget alert is the second line.
 */
export class ModelBudgetError extends Error {
  constructor(readonly limit: number) {
    super(`the daily limit of ${limit} model calls is reached; it starts again at midnight UTC, or the operator can raise SPINE_LLM_DAILY_CALLS`);
    this.name = 'ModelBudgetError';
  }
}

let day = '';
let used = 0;
let warned = false;

/** Counts one call, or throws `ModelBudgetError` when the day's allowance is spent. Call before every model request. */
export function spendModelCall(now: Date = new Date(), limit: number = llmDailyCalls()): void {
  const today = now.toISOString().slice(0, 10);
  if (today !== day) { day = today; used = 0; warned = false; }
  if (limit === 0) return;
  if (used >= limit) {
    if (!warned) {
      warned = true;
      logger.warn('the daily model-call limit was reached; further calls are refused until midnight UTC', { limit });
    }
    throw new ModelBudgetError(limit);
  }
  used += 1;
  // One line as the day passes 80%, so a leaked link shows up before it is a bill.
  if (used === Math.ceil(limit * 0.8)) logger.warn('80% of the daily model-call limit is used', { used, limit });
}

/** Calls counted today, for tests and the startup log. */
export function modelCallsToday(): number {
  return day === new Date().toISOString().slice(0, 10) ? used : 0;
}

export function resetModelBudget(): void {
  day = ''; used = 0; warned = false;
}

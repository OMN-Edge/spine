import { llmDailyCalls } from '../config.js';
import { logger } from '../logger.js';
import { getAccountsStore } from '../store/index.js';

/**
 * An instance-wide count of model calls for the current UTC day (SECURITY.md S-35), kept in the store's `usage` under the reserved name
 * `instance`, as the relay keeps its per-account count: the store the environment names decides whether it survives a restart.
 */
export class ModelBudgetError extends Error {
  constructor(readonly limit: number) {
    super(`the daily limit of ${limit} model calls is reached; it starts again at midnight UTC, or the operator can raise SPINE_LLM_DAILY_CALLS`);
    this.name = 'ModelBudgetError';
  }
}

const INSTANCE = 'instance';
let warnedDay = '';

/** Counts one call, or throws `ModelBudgetError` when the day's allowance is spent. Call before every model request. */
export async function spendModelCall(now: Date = new Date(), limit: number = llmDailyCalls()): Promise<void> {
  if (limit === 0) return;
  const today = now.toISOString().slice(0, 10);
  const used = await getAccountsStore().usage.spend(INSTANCE, today, limit);
  if (used === null) {
    if (warnedDay !== today) {
      warnedDay = today;
      logger.warn('the daily model-call limit was reached; further calls are refused until midnight UTC', { limit });
    }
    throw new ModelBudgetError(limit);
  }
  // One line as the day passes 80%, so a leaked link shows up before it is a bill.
  if (used === Math.ceil(limit * 0.8)) logger.warn('80% of the daily model-call limit is used', { used, limit });
}

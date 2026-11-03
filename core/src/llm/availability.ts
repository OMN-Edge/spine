import { ModelBudgetError } from './budget.js';
import { LlmBlockedError } from './types.js';

/**
 * Whether a model call that failed can succeed later, and when to try. Reading an upload never gives up on a document because the model
 * could not be asked (a quota, an outage, a dropped connection): it waits and tries again. It gives up only on what asking again would not
 * change: the model refused these words, or the provider turned the request itself down.
 *
 * - `limit`: a daily allowance is used up (the device's own `SPINE_LLM_DAILY_CALLS`, the relay's, or the plan's); try after midnight UTC,
 *   when the day's count starts again.
 * - `unavailable`: the relay or the provider did not answer, or answered that it could not; try again soon, then less often.
 */
export interface ModelWait {
  reason: 'limit' | 'unavailable';
  /** The earliest time worth trying again (ms since the epoch), when the reason says; otherwise the caller backs off. */
  until?: number;
}

/** The relay could not be reached at all (no connection, DNS, a reset). Thrown by the relay adapter in place of fetch's own TypeError. */
export class ModelUnreachableError extends Error {
  constructor(cause: unknown) {
    super('the model service could not be reached', { cause });
    this.name = 'ModelUnreachableError';
  }
}

/** The relay's own codes (relay/protocol.ts): `rejected` is a provider that turned the request down, which asking again would not change. */
const FINAL_CODES = new Set(['blocked', 'rejected']);

export function modelWait(err: unknown, now: number = Date.now()): ModelWait | null {
  if (err instanceof LlmBlockedError) return null;
  if (err instanceof ModelBudgetError) return { reason: 'limit', until: nextUtcDay(now) };
  if (err instanceof ModelUnreachableError) return { reason: 'unavailable' };
  const { status, code } = (err ?? {}) as { status?: unknown; code?: unknown };
  if (typeof status !== 'number') return null;
  if (typeof code === 'string' && FINAL_CODES.has(code)) return null;
  // 429: the relay's daily allowance. 402: the plan's (its period may be longer than a day; one call a day to find out costs nothing).
  if (status === 429 || status === 402) return { reason: 'limit', until: nextUtcDay(now) };
  // 401: the relay's pass ran out, and the device fetches a new one with the next call. 408 and 5xx: the relay or the provider did not answer.
  if (status === 401 || status === 408 || status >= 500) return { reason: 'unavailable' };
  return null;
}

/** A few minutes past the next midnight UTC: the daily counts start again then, and not every device at the same second. */
function nextUtcDay(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 5);
}

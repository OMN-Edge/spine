import { modelWait, type ModelWait } from '../llm/availability.js';

/**
 * Work on an upload that the model could not be asked for is tried again by itself, not given up on (`llm/availability.ts` says which
 * failures those are): after midnight UTC for a daily limit, otherwise after 1, 5 and 15 minutes and then every hour, while this core runs.
 * A core that starts again picks the work up at once (`resumeStalledJobs`, `resumeUnreadDocuments`). In memory, by key: one plan per piece
 * of work, so asking again replaces the plan rather than adding a second.
 */
const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];

/** What the screens are told about work that waits: why, and when it is tried again. */
export interface ModelWaiting {
  reason: ModelWait['reason'];
  retry_at: string;
}

const plans = new Map<string, { attempts: number; timer: ReturnType<typeof setTimeout> }>();

/** Plans `again` for when the model can be asked, if `err` is a failure to wait out; null (and nothing planned) if it is not. */
export function waitForModel(key: string, err: unknown, again: () => void, now: number = Date.now()): ModelWaiting | null {
  const wait = modelWait(err, now);
  if (!wait) return null;
  const previous = plans.get(key);
  if (previous) clearTimeout(previous.timer);
  const attempts = (previous?.attempts ?? 0) + 1;
  const at = wait.until ?? now + BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length) - 1];
  plans.set(key, { attempts, timer: setTimeout(again, Math.max(0, at - now)) });
  return { reason: wait.reason, retry_at: new Date(at).toISOString() };
}

/** The work got its answer: the next failure starts the wait from the beginning. */
export function modelAnswered(key: string): void {
  const plan = plans.get(key);
  if (!plan) return;
  clearTimeout(plan.timer);
  plans.delete(key);
}

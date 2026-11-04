import { describe, it, expect, vi, afterEach } from 'vitest';
import { modelWait, ModelUnreachableError } from '../llm/availability.js';
import { LlmBlockedError } from '../llm/types.js';
import { modelAnswered, waitForModel } from '../ingestion/model-wait.js';

const NOW = Date.UTC(2026, 10, 2, 5, 59);
const relay = (status: number, code?: string) => Object.assign(new Error(`the model service answered ${status}`), { status, code });

describe('whether a model call that failed can succeed later', () => {
  it('waits for the next day when a daily allowance is used up: the relay’s or the plan’s', () => {
    const tomorrow = Date.UTC(2026, 10, 3, 0, 5);
    expect(modelWait(relay(429), NOW)).toEqual({ reason: 'limit', until: tomorrow });
    expect(modelWait(relay(402, 'allowance_used'), NOW)).toEqual({ reason: 'limit', until: tomorrow });
  });

  it('tries again soon when the relay or the provider did not answer', () => {
    for (const err of [relay(503, 'unavailable'), relay(502), relay(500), relay(504), relay(408), relay(401), new ModelUnreachableError(new TypeError('Failed to fetch'))]) {
      expect(modelWait(err, NOW)).toEqual({ reason: 'unavailable' });
    }
  });

  it('does not wait on what asking again would not change, nor on what is not a model call at all', () => {
    for (const err of [new LlmBlockedError('Prompt blocked: SAFETY'), relay(422, 'blocked'), relay(502, 'rejected'), relay(400), relay(413), relay(404), new Error('pdftoppm exited with 1'), null, 'x']) {
      expect(modelWait(err, NOW)).toBeNull();
    }
  });
});

describe('the plan to try again', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('backs off for an outage, waits for the day for a limit, starts again from the beginning once the model answered', () => {
    vi.useFakeTimers({ now: NOW });
    const again = vi.fn();
    const at = (ms: number) => new Date(NOW + ms).toISOString();

    expect(waitForModel('k', relay(503), again, NOW)?.retry_at).toBe(at(60_000));
    expect(waitForModel('k', relay(503), again, NOW)?.retry_at).toBe(at(5 * 60_000));
    expect(waitForModel('k', relay(503), again, NOW)?.retry_at).toBe(at(15 * 60_000));
    expect(waitForModel('k', relay(503), again, NOW)?.retry_at).toBe(at(60 * 60_000));
    expect(waitForModel('k', relay(503), again, NOW)?.retry_at).toBe(at(60 * 60_000));
    expect(waitForModel('k', relay(429), again, NOW)).toEqual({ reason: 'limit', retry_at: '2026-11-03T00:05:00.000Z' });
    // Each plan replaced the one before: one try is due, not six.
    vi.advanceTimersByTime(24 * 60 * 60_000);
    expect(again).toHaveBeenCalledTimes(1);

    modelAnswered('k');
    expect(waitForModel('k', relay(503), again, NOW)?.retry_at).toBe(at(60_000));
    expect(waitForModel('other', relay(400), again, NOW)).toBeNull();
  });
});

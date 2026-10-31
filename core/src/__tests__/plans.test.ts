import { describe, it, expect } from 'vitest';
import { PAGE, PAST_DUE_GRACE_DAYS, entitlementsOf, planOf, subscriptionEntitles, taskCost, trialEnd, usagePeriod } from '../billing/plans.js';
import type { SubscriptionRecord } from '../store/types.js';

const DAY = 86_400_000;
const sub = (over: Partial<SubscriptionRecord>): SubscriptionRecord => ({
  user_id: 'u', provider: 'paddle', customer_id: 'ctm', subscription_id: 'sub', interval: 'year', status: 'active', founding: false,
  current_period_end: null, cancel_scheduled: false, updated_at: '2026-01-01T00:00:00.000Z', ...over,
});
const now = new Date('2026-06-15T12:00:00.000Z');
const created = (daysAgo: number) => ({ created_at: new Date(now.getTime() - daysAgo * DAY).toISOString() });

describe('which plan an account has', () => {
  it('is the trial for six months from the account’s day, then the free plan', () => {
    expect(planOf(created(0), null, now)).toBe('trial');
    expect(planOf(created(150), null, now)).toBe('trial');
    expect(planOf(created(200), null, now)).toBe('free');
    expect(trialEnd('2026-01-31T00:00:00.000Z').slice(0, 10)).toBe('2026-07-31');
  });

  it('is Premium while a subscription runs, over the trial or the free plan', () => {
    expect(planOf(created(400), sub({ current_period_end: new Date(now.getTime() + 30 * DAY).toISOString() }), now)).toBe('premium');
    expect(planOf(created(10), sub({}), now)).toBe('premium');
  });

  it('keeps what was paid for after a cancellation, to the end of it', () => {
    const ending = (days: number) => sub({ status: 'canceled', current_period_end: new Date(now.getTime() + days * DAY).toISOString() });
    expect(subscriptionEntitles(ending(5), now)).toBe(true);
    expect(subscriptionEntitles(ending(-1), now)).toBe(false);
    expect(subscriptionEntitles(sub({ status: 'canceled', current_period_end: null }), now)).toBe(false);
  });

  it('gives a late payment a few days and no more', () => {
    const lateBy = (days: number) => sub({ status: 'past_due', current_period_end: new Date(now.getTime() - days * DAY).toISOString() });
    expect(subscriptionEntitles(lateBy(PAST_DUE_GRACE_DAYS - 1), now)).toBe(true);
    expect(subscriptionEntitles(lateBy(PAST_DUE_GRACE_DAYS + 1), now)).toBe(false);
  });

  it('does not trust an active subscription whose end passed more than a day ago', () => {
    expect(subscriptionEntitles(sub({ current_period_end: new Date(now.getTime() - 3 * DAY).toISOString() }), now)).toBe(false);
    expect(subscriptionEntitles(sub({ current_period_end: new Date(now.getTime() - 3600e3).toISOString() }), now)).toBe(true);
  });
});

describe('what a plan includes', () => {
  it('counts the trial once and the other plans by month', () => {
    const trial = entitlementsOf(created(1), null, now);
    expect(trial).toMatchObject({ plan: 'trial', aiAllowance: 150 * PAGE, translation: true, approvalMode: true });
    expect(usagePeriod(trial, now)).toBe('trial');
    const free = entitlementsOf(created(300), null, now);
    expect(free).toMatchObject({ plan: 'free', aiAllowance: 30 * PAGE, vaultBytes: 1024 ** 3, liveShares: 1, chat: false });
    expect(usagePeriod(free, now)).toBe('2026-06');
  });
});

describe('what a call costs', () => {
  it('grows with the request for reading and translating, and is flat for a page', () => {
    expect(taskCost('extraction', 0)).toBe(100);
    expect(taskCost('extraction', 8 * 1024)).toBe(1100);
    expect(taskCost('page', 500_000)).toBe(PAGE);
    expect(taskCost('translation', 2048)).toBe(300);
    expect(taskCost('embed', 100)).toBeGreaterThan(0);
  });
});

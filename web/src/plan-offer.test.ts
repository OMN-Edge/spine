import { describe, expect, it } from 'vitest';
import { offerPlans, trialDaysLeft } from './plan-offer';

/** The account page asks for money late in the trial, not on its first day (T-07). */
const now = new Date('2026-11-17T10:00:00Z');
const days = (n: number) => new Date(now.getTime() + n * 86_400_000).toISOString();

describe('when the plans are offered', () => {
  it('is not on the first day of the trial', () => {
    expect(offerPlans({ plan: 'trial', trialEndsAt: days(90), used: [0.12, 0.06, 0], now })).toBe(false);
  });

  it('comes when twenty-one days or fewer are left', () => {
    expect(offerPlans({ plan: 'trial', trialEndsAt: days(22), used: [0], now })).toBe(false);
    expect(offerPlans({ plan: 'trial', trialEndsAt: days(21), used: [0], now })).toBe(true);
    expect(offerPlans({ plan: 'trial', trialEndsAt: days(10), used: [0], now })).toBe(true);
  });

  it('comes when any total is four-fifths used, however early', () => {
    expect(offerPlans({ plan: 'trial', trialEndsAt: days(80), used: [0.1, 0.8, 0], now })).toBe(true);
    expect(offerPlans({ plan: 'trial', trialEndsAt: days(80), used: [0.79], now })).toBe(false);
  });

  it('is always where the account is not on the trial', () => {
    expect(offerPlans({ plan: 'free', trialEndsAt: null, used: [], now })).toBe(true);
    expect(offerPlans({ plan: 'premium', trialEndsAt: null, used: [], now })).toBe(true);
  });

  it('counts the days left, never below nought', () => {
    expect(trialDaysLeft(days(87), now)).toBe(87);
    expect(trialDaysLeft(days(-3), now)).toBe(0);
  });
});

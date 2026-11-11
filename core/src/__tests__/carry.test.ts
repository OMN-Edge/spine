import { describe, it, expect } from 'vitest';
import { carriedPages } from '../billing/carry.js';
import { CARRY_MONTHS, PLANS } from '../billing/plans.js';

const none = () => 0;

/** What a month does not use carries into the next, up to three months' worth (docs/billing.md). */
describe('pages that carry from month to month', () => {
  it('is the monthly allowance in the first month, and a month more for each month nothing was added, up to three', () => {
    expect(carriedPages(30, CARRY_MONTHS, '2027-01', '2027-01', none)).toBe(30);
    expect(carriedPages(30, CARRY_MONTHS, '2027-01', '2027-02', none)).toBe(60);
    expect(carriedPages(30, CARRY_MONTHS, '2027-01', '2027-03', none)).toBe(90);
    expect(carriedPages(30, CARRY_MONTHS, '2027-01', '2027-04', none)).toBe(90);
    expect(carriedPages(30, CARRY_MONTHS, '2027-01', '2028-06', none)).toBe(90);
  });

  it('keeps what a month leaves: ten used in January leaves twenty, and a month that uses all it has leaves nothing', () => {
    const used = (m: string) => ({ '2027-01': 10, '2027-02': 30 })[m] ?? 0;
    expect(carriedPages(30, CARRY_MONTHS, '2027-01', '2027-02', used)).toBe(50); // 20 left of January, and February's 30
    expect(carriedPages(30, CARRY_MONTHS, '2027-01', '2027-03', used)).toBe(50); // February used 30 of its 50, so 20 carry, and March adds 30
    expect(carriedPages(30, CARRY_MONTHS, '2027-01', '2027-04', used)).toBe(80); // nothing was added in March, so April has 50 and 30 more
  });

  it('lets a person who added nothing for three months add ninety in the fourth, and then starts again from what is left', () => {
    expect(carriedPages(30, CARRY_MONTHS, '2027-01', '2027-04', none)).toBe(90);
    const spike = (m: string) => (m === '2027-04' ? 90 : 0);
    expect(carriedPages(30, CARRY_MONTHS, '2027-01', '2027-05', spike)).toBe(30);
  });

  it('counts nothing before the plan began, and carries nothing where a plan has no carry', () => {
    expect(carriedPages(30, CARRY_MONTHS, '2027-06', '2027-06', none)).toBe(30);
    expect(carriedPages(10, 1, '2027-01', '2027-06', none)).toBe(10);
  });

  it('follows the plans: Premium 30 a month, Family 60 for all, each keeping three months’ worth, and Free and the trial none', () => {
    expect(PLANS.premium.allowance.pages).toBe(30);
    expect(PLANS.family.allowance.pages).toBe(60);
    expect(PLANS.family.memberCap?.pages).toBe(30);
    expect(PLANS.premium.carryMonths).toBe(3);
    expect(PLANS.family.carryMonths).toBe(3);
    expect(PLANS.free.carryMonths).toBe(1);
    expect(PLANS.trial.carryMonths).toBe(1);
  });
});

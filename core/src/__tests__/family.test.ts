import { describe, it, expect } from 'vitest';
import { ADULT_AGE, OWN_ACCOUNT_AGE, ageOn, isAdult, mayHaveOwnAccount, parseBorn } from '../family.js';

const day = (iso: string) => new Date(`${iso}T12:00:00.000Z`);

describe('a birth date', () => {
  it('is a real day, not in the future, written year-month-day', () => {
    expect(parseBorn('2012-03-09', day('2026-06-01'))).toBe('2012-03-09');
    for (const bad of ['2012-02-30', '2012-13-01', '12-03-2012', '2012-3-9', '', 'yesterday', '1899-12-31', '2026-06-02']) expect(parseBorn(bad, day('2026-06-01')), bad).toBeNull();
    expect(parseBorn('2026-06-01', day('2026-06-01'))).toBe('2026-06-01');
  });
});

describe('an age', () => {
  it('counts whole years, up to the birthday itself', () => {
    expect(ageOn('2010-06-15', day('2026-06-14'))).toBe(15);
    expect(ageOn('2010-06-15', day('2026-06-15'))).toBe(16);
    expect(ageOn('2008-02-29', day('2026-02-28'))).toBe(17);
    expect(ageOn('2008-02-29', day('2026-03-01'))).toBe(18);
    expect(ageOn(undefined, day('2026-06-14'))).toBeNull();
    expect(ageOn('not a date', day('2026-06-14'))).toBeNull();
  });

  it('allows an account of one’s own from sixteen, with a date to show it', () => {
    expect(OWN_ACCOUNT_AGE).toBe(16);
    expect(mayHaveOwnAccount('2010-06-16', day('2026-06-15'))).toBe(false);
    expect(mayHaveOwnAccount('2010-06-15', day('2026-06-15'))).toBe(true);
    expect(mayHaveOwnAccount(undefined)).toBe(false);
  });

  it('makes the records the person’s own at eighteen', () => {
    expect(ADULT_AGE).toBe(18);
    expect(isAdult('2008-06-16', day('2026-06-15'))).toBe(false);
    expect(isAdult('2008-06-15', day('2026-06-15'))).toBe(true);
    expect(isAdult(undefined)).toBe(false);
  });
});

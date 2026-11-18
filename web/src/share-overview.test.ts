import { describe, expect, it } from 'vitest';
import { buildOverview } from './share-overview';

/** What the owner chose to tell the doctor, as the link carries it (T-02, T-29). */
const CARD = { v: 1 as const, name: 'Ana Exemplu', born: '', blood_type: '', allergies: ['penicillin'], conditions: [], medications: ['Levothyroxine 50 µg, once a day'], contacts: [], details: [], notes: '', language: '', second: null };
const about = (over: Partial<Parameters<typeof buildOverview>[0]> = {}) => ({ showName: true, name: 'Ana Exemplu', note: '', includeNow: false, ...over });

describe('building the overview of a link', () => {
  it('has the name on by default and nothing from the card unless it was ticked', () => {
    expect(buildOverview(about(), CARD)).toEqual({ by: 'Ana Exemplu', note: null, now: null });
  });

  it('leaves the name out when the owner turns it off, for an anonymous second opinion', () => {
    expect(buildOverview(about({ showName: false, note: 'Thyroid' }), CARD)).toEqual({ by: null, note: 'Thyroid', now: null });
    expect(buildOverview(about({ showName: false }), CARD)).toBeNull();
  });

  it('takes what the owner takes now from their own card, with the day it was written, only when ticked', () => {
    expect(buildOverview(about({ includeNow: true }), CARD, '2026-11-17')?.now).toEqual({ medications: ['Levothyroxine 50 µg, once a day'], allergies: ['penicillin'], conditions: [], written_on: '2026-11-17' });
  });

  it('adds nothing where the card has nothing, even if the box was ticked', () => {
    expect(buildOverview(about({ showName: false, includeNow: true }), { ...CARD, allergies: [], medications: [] })).toBeNull();
    expect(buildOverview(about({ includeNow: true }), null)?.now ?? null).toBeNull();
  });

  it('trims the name and the note and says nothing for blanks', () => {
    expect(buildOverview(about({ name: '  Ana  ', note: '  for a visit ' }), CARD)).toEqual({ by: 'Ana', note: 'for a visit', now: null });
    expect(buildOverview(about({ name: '   ', note: '  ' }), CARD)).toBeNull();
  });
});

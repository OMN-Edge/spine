import { describe, expect, it } from 'vitest';
import { overviewText, parseOverview, readOverview } from '../share-overview.js';

/** What the owner tells the doctor about a share link (T-02): their own words, checked, kept as text with the link. */
describe('the overview of a link', () => {
  it('keeps whose records, a note and what the owner takes now, trimmed, with empty lines dropped', () => {
    const read = readOverview({ by: '  Ana Exemplu ', note: ' for a new endocrinologist ', now: { medications: ['Levothyroxine 50 µg, once a day', '  ', ''], allergies: ['penicillin'], conditions: [], written_on: '2026-11-17' } });
    expect('overview' in read && read.overview).toEqual({ by: 'Ana Exemplu', note: 'for a new endocrinologist', now: { medications: ['Levothyroxine 50 µg, once a day'], allergies: ['penicillin'], conditions: [], written_on: '2026-11-17' } });
  });

  it('says nothing where nothing is said: no overview, an empty one, or a name left out and an empty list of medicines', () => {
    expect(overviewText(null)).toBeNull();
    const empty = readOverview({ by: '', note: '', now: { medications: [], allergies: [], conditions: [], written_on: '' } });
    expect('overview' in empty && overviewText(empty.overview)).toBeNull();
    expect(readOverview(undefined)).toEqual({ overview: null });
    expect(readOverview(null)).toEqual({ overview: null });
  });

  it('refuses what is not its shape, and anything too long, instead of keeping it', () => {
    expect('error' in readOverview('a note')).toBe(true);
    expect('error' in readOverview({ by: 'x'.repeat(121) })).toBe(true);
    expect('error' in readOverview({ note: 'x'.repeat(301) })).toBe(true);
    expect('error' in readOverview({ now: { medications: Array.from({ length: 31 }, () => 'a') } })).toBe(true);
    expect('error' in readOverview({ by: 'Ana', other: 'a field nobody asked for' })).toBe(true);
  });

  it('is stored as text and read back, and an unreadable or earlier value is no overview', () => {
    const read = readOverview({ by: 'Ana Exemplu', now: { medications: ['Levothyroxine'], allergies: [], conditions: [], written_on: '2026-11-17' } });
    const text = 'overview' in read ? overviewText(read.overview) : null;
    expect(parseOverview(text)).toEqual({ by: 'Ana Exemplu', note: null, now: { medications: ['Levothyroxine'], allergies: [], conditions: [], written_on: '2026-11-17' } });
    expect(parseOverview(null)).toBeNull();
    expect(parseOverview('not json')).toBeNull();
    expect(parseOverview('{"unexpected":1}')).toBeNull();
  });
});

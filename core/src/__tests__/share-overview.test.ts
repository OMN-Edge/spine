import { describe, expect, it } from 'vitest';
import { overviewText, parseOverview, readOverview, resolveOverview, summaryOf } from '../share-overview.js';
import { EMPTY_CARD, normaliseCard } from '../emergency.js';

/** What the owner tells the doctor about a share link (T-02): their own words, checked, kept as text with the link. */
describe('the overview of a link', () => {
  it('keeps whose records, a note and what the owner takes now, trimmed, with empty lines dropped', () => {
    const read = readOverview({ by: '  Ana Exemplu ', note: ' for a new endocrinologist ', now: { medications: ['Levothyroxine 50 µg, once a day', '  ', ''], allergies: ['penicillin'], conditions: [], written_on: '2026-11-17' } });
    expect('overview' in read && read.overview).toEqual({ by: 'Ana Exemplu', note: 'for a new endocrinologist', now: { medications: ['Levothyroxine 50 µg, once a day'], allergies: ['penicillin'], conditions: [], blood_type: '', notes: '', written_on: '2026-11-17' }, summary: false });
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
    expect(parseOverview(text)).toEqual({ by: 'Ana Exemplu', note: null, now: { medications: ['Levothyroxine'], allergies: [], conditions: [], blood_type: '', notes: '', written_on: '2026-11-17' }, summary: false });
    expect(parseOverview(null)).toBeNull();
    expect(parseOverview('not json')).toBeNull();
    expect(parseOverview('{"unexpected":1}')).toBeNull();
  });
});

describe('the health summary of a link', () => {
  const card = normaliseCard({ ...EMPTY_CARD, allergies: ['penicillin'], medications: ['Levothyroxine 50 µg'], blood_type: 'A+', notes: 'Port stimulator', contacts: [{ name: 'Sam', relation: 'partner', phone: '+40 700 000 000' }], details: [{ kind: 'national_id', label: '', value: '1234567890123', on_card: true }] });

  it('is the lists, the blood type and the notes of the profile, with the day written, and nothing of the card\'s contacts or numbers', () => {
    const summary = summaryOf(card, '2026-11-20')!;
    expect(summary).toEqual({ medications: ['Levothyroxine 50 µg'], allergies: ['penicillin'], conditions: [], blood_type: 'A+', notes: 'Port stimulator', written_on: '2026-11-20' });
    expect(JSON.stringify(summary)).not.toContain('Sam');
    expect(JSON.stringify(summary)).not.toContain('1234567890123');
    expect(summaryOf(EMPTY_CARD, '2026-11-20')).toBeNull();
    expect(summaryOf(null)).toBeNull();
  });

  it('is kept by a link as a request for it, with no lists of its own, so they are never a copy that goes stale', () => {
    const read = readOverview({ by: 'Ana', note: null, now: summaryOf(card, '2026-11-20'), summary: true });
    const stored = overviewText('overview' in read ? read.overview : null)!;
    expect(JSON.parse(stored)).toEqual({ by: 'Ana', note: null, now: null, summary: true });
    expect(overviewText({ by: null, note: null, now: null, summary: true })).not.toBeNull();
  });

  it('is read from the profile each time the copy is made, so a change reaches a link that follows the records', () => {
    const stored = JSON.stringify({ by: 'Ana', note: null, now: null, summary: true });
    const first = JSON.parse(resolveOverview(stored, summaryOf(card, '2026-11-20'))!);
    expect(first).toMatchObject({ by: 'Ana', summary: true, now: { medications: ['Levothyroxine 50 µg'], blood_type: 'A+' } });
    const changed = normaliseCard({ ...card, medications: ['Levothyroxine 75 µg'] });
    expect(JSON.parse(resolveOverview(stored, summaryOf(changed, '2026-11-21'))!).now).toMatchObject({ medications: ['Levothyroxine 75 µg'], written_on: '2026-11-21' });
    // The stored text is the owner's and is not changed by it.
    expect(JSON.parse(stored).now).toBeNull();
  });

  it('leaves a link made before this as it was written, since it holds its own lists', () => {
    const old = JSON.stringify({ by: 'Ana', note: null, now: { medications: ['Old drug'], allergies: [], conditions: [], written_on: '2026-10-01' } });
    expect(resolveOverview(old, summaryOf(card, '2026-11-20'))).toBe(old);
    expect(parseOverview(old)!.now).toMatchObject({ medications: ['Old drug'], blood_type: '', notes: '' });
    expect(resolveOverview(null, summaryOf(card))).toBeNull();
  });
});

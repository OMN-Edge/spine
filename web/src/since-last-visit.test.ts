import { describe, expect, it } from 'vitest';
import { lastVisit, sinceLastVisit } from './since-last-visit';

/** What a doctor has not seen of the person since the last visit (T-28). */
const doc = (id: string, doc_date: string | null, doc_type: string | null = 'lab_result') => ({ id, doc_date, doc_type });

describe('the last visit to a doctor', () => {
  it('is the date of the newest document that names them', () => {
    expect(lastVisit([doc('a', '2026-01-10'), doc('b', '2026-05-02'), doc('c', null)])).toBe('2026-05-02');
    expect(lastVisit([])).toBeNull();
    expect(lastVisit([doc('a', null)])).toBeNull();
  });
});

describe('what came from others since', () => {
  const own = [doc('endo-1', '2026-03-04'), doc('endo-2', '2026-06-20')];
  const all = [...own, doc('lab-old', '2026-05-01'), doc('lab-new', '2026-08-15'), doc('ecg', '2026-10-02', 'imaging'), doc('undated', null), doc('same-day', '2026-06-20')];

  it('is every other document dated after the last visit, newest first', () => {
    const { since, documents } = sinceLastVisit(own, all);
    expect(since).toBe('2026-06-20');
    expect(documents.map(d => d.id)).toEqual(['ecg', 'lab-new']);
  });

  it('keeps a receipt and an unrelated consultation out of the first list, and offers them as the others', () => {
    const more = [...all, doc('receipt', '2026-09-01', 'other'), doc('derm', '2026-09-10', 'consultation_note'), doc('untyped', '2026-09-12', null)];
    const { documents, other } = sinceLastVisit(own, more);
    expect(documents.map(d => d.id)).toEqual(['ecg', 'lab-new']);
    expect(other.map(d => d.id)).toEqual(['untyped', 'derm', 'receipt']);
  });

  it('never lists the doctor’s own documents, nor one with no date, nor one of the day itself', () => {
    const { documents } = sinceLastVisit(own, all);
    for (const id of ['endo-1', 'endo-2', 'undated', 'same-day', 'lab-old']) expect(documents.map(d => d.id)).not.toContain(id);
  });

  it('is nothing for a doctor with no dated document: there is no visit to count from', () => {
    expect(sinceLastVisit([doc('x', null)], all)).toEqual({ since: null, documents: [], other: [] });
    expect(sinceLastVisit([], all)).toEqual({ since: null, documents: [], other: [] });
  });
});

import { describe, expect, it } from 'vitest';
import { copiesOf, isCopy, isLaterCopy } from '../linking/copies.js';
import type { Document } from '../types.js';

/** A document held twice is one document: never a relative of itself, and only the earliest carries links. */
const doc = (id: string, over: Partial<Document> = {}): Document => ({
  id, source_file_id: `f-${id}`, page_start: 1, page_end: 1, title: 'Certificat de concediu medical', doc_date: '2025-09-08', provider: 'Spitalul Județean Exemplu', doc_type: 'other',
  ai_summary: 'Certificat de concediu medical pentru pneumonie lobară, perioada 01.09.2025 – 17.09.2025, 17 zile, eliberat la externare.', user_notes: null, reviewed: false, language: 'ro', needs_reading: false, to_check: 0, ...over,
});

describe('a copy', () => {
  it('is the same date, kind, provider and title, with a summary that says the same', () => {
    expect(isCopy(doc('a'), doc('b', { ai_summary: 'Certificat de concediu medical pentru pneumonie lobară, perioada 01.09.2025 – 17.09.2025, 17 zile.' }))).toBe(true);
  });

  it('is told by how alike the embeddings are when that is known, whatever the summaries', () => {
    expect(isCopy(doc('a'), doc('b', { ai_summary: 'something else entirely' }), 0.99)).toBe(true);
    expect(isCopy(doc('a'), doc('b'), 0.6)).toBe(false);
  });

  it('is not a document that only shares a day, a clinic or a title: another date, kind, provider or title is not a copy', () => {
    expect(isCopy(doc('a'), doc('b', { doc_date: '2025-09-09' }), 0.99)).toBe(false);
    expect(isCopy(doc('a'), doc('b', { doc_type: 'lab_result' }), 0.99)).toBe(false);
    expect(isCopy(doc('a'), doc('b', { provider: 'Alt Spital' }), 0.99)).toBe(false);
    expect(isCopy(doc('a'), doc('b', { title: 'Alt titlu' }), 0.99)).toBe(false);
  });

  it('is not two reports of one lab on one day that say different things', () => {
    const a = doc('a', { title: 'Buletin de analize', doc_type: 'lab_result', ai_summary: 'Hematologie: hemoglobină 14.8, leucocite 6.1, trombocite 238, toate în limite normale.' });
    const b = doc('b', { title: 'Buletin de analize', doc_type: 'lab_result', ai_summary: 'Biochimie: colesterol total 5.9, LDL 3.8, trigliceride 1.9, valori crescute, glicemie normală.' });
    expect(isCopy(a, b)).toBe(false);
  });

  it('is not taken for one when a document has no summary yet and nothing else tells them apart', () => {
    expect(isCopy(doc('a', { ai_summary: null }), doc('b'))).toBe(false);
  });

  it('needs a kind, a provider and a title on both', () => {
    for (const missing of [{ doc_type: null }, { provider: null }, { title: null }] as Array<Partial<Document>>) expect(isCopy(doc('a', missing), doc('b', missing), 0.99)).toBe(false);
  });

  it('can be two documents with no date on them, when they say the same, and not when only one has a date', () => {
    expect(isCopy(doc('a', { doc_date: null }), doc('b', { doc_date: null }))).toBe(true);
    expect(isCopy(doc('a', { doc_date: null }), doc('b', { doc_date: null, ai_summary: 'something else' }))).toBe(false);
    expect(isCopy(doc('a', { doc_date: null }), doc('b'), 0.99)).toBe(false);
  });

  it('is never the document itself', () => {
    expect(isCopy(doc('a'), doc('a'), 1)).toBe(false);
  });

  it('is found among others, and only the earliest of two is not a later copy', () => {
    const [a, b, c] = [doc('a'), doc('b'), doc('c', { title: 'Alt titlu' })];
    expect(copiesOf(a, [b, c], new Map([['b', 0.99]])).map(d => d.id)).toEqual(['b']);
    expect(isLaterCopy(b, [a, c], new Map([['a', 0.99]]))).toBe(true);
    expect(isLaterCopy(a, [b, c], new Map([['b', 0.99]]))).toBe(false);
    expect(isLaterCopy(c, [a, b])).toBe(false);
  });
});

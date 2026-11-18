import { describe, expect, it } from 'vitest';
import { queueOf } from './fields-to-check';

/** The handwriting queue: every flagged value once, from documents not yet reviewed (T-26). */
const field = (id: string, needs_check: boolean, page_id = 'p1') => ({ id, document_id: 'x', page_id, label: 'dose', value: '5 mg', group_no: null, source_snippet: null, bbox_x0: 1, bbox_y0: 1, bbox_x1: 2, bbox_y1: 2, confidence: needs_check ? 0.4 : 0.95, needs_check });
const page = (id: string, n: number) => ({ id, page_number: n, rotation: 0, extraction_source: 'multimodal' as never });

describe('the queue of values to check', () => {
  it('holds each flagged value once, newest document first, with the page it stands on', () => {
    const q = queueOf([
      { id: 'a', title: 'Old letter', doc_date: '2024-01-01', fields: [field('f1', true), field('f2', false)], pages: [page('p1', 1)] },
      { id: 'b', title: 'New letter', doc_date: '2026-05-01', fields: [field('f3', true, 'p2'), field('f4', true)], pages: [page('p1', 1), page('p2', 2)] },
    ]);
    expect(q.map(i => i.field.id)).toEqual(['f3', 'f4', 'f1']);
    expect(q[0]!.page?.page_number).toBe(2);
    expect(q[2]!.documentTitle).toBe('Old letter');
  });

  it('never lists a value twice, nor one of a document the owner has reviewed, nor one that is not flagged', () => {
    const dup = field('same', true);
    const q = queueOf([
      { id: 'a', title: null, doc_date: null, fields: [dup, field('ok', false)], pages: [page('p1', 1)] },
      { id: 'b', title: null, doc_date: null, fields: [dup], pages: [] },
      { id: 'c', title: null, doc_date: '2026-01-01', reviewed: true, fields: [field('r', true)], pages: [] },
    ]);
    expect(q.map(i => i.field.id)).toEqual(['same']);
  });

  it('is empty when nothing is flagged, and still lists a value whose page is not known', () => {
    expect(queueOf([{ id: 'a', title: 't', doc_date: null, fields: [field('x', false)], pages: [] }])).toEqual([]);
    expect(queueOf([{ id: 'a', title: 't', doc_date: null, fields: [field('x', true, 'gone')], pages: [] }])[0]!.page).toBeNull();
  });
});

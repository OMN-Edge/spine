import { describe, expect, it } from 'vitest';
import { clusterDocuments, MAX_DOCUMENTS, MAX_GAP_DAYS, MAX_SPAN_DAYS, type EpisodeLink } from '../episodes/cluster.js';

/** Which documents may be one episode: a care cycle, never a year of follow-ups and never two things that only share a day or a clinic. */
const DAY = 86_400_000;
const date = (base: string, plus: number) => new Date(Date.parse(`${base}T00:00:00Z`) + plus * DAY).toISOString().slice(0, 10);
const doc = (id: string, doc_date: string | null) => ({ id, doc_date });
const link = (from: string, to: string, over: Partial<EpisodeLink> = {}): EpisodeLink => ({ from, to, kind: 'requests', state: 'proposed', source: 'auto', ...over });
const sorted = (groups: string[][]) => groups.map(g => [...g].sort()).sort((a, b) => a[0]!.localeCompare(b[0]!));

describe('an episode is joined by links', () => {
  it('joins two documents a link names, and leaves a document with no link out', () => {
    const docs = [doc('consult', '2026-03-01'), doc('lab', '2026-03-08'), doc('alone', '2026-03-09')];
    expect(sorted(clusterDocuments(docs, [link('consult', 'lab')]))).toEqual([['consult', 'lab']]);
  });

  it('makes nothing of the same clinic, the same day or the same words: with no link there is no episode', () => {
    const docs = Array.from({ length: 6 }, (_, i) => doc(`d${i}`, '2026-03-01'));
    expect(clusterDocuments(docs, [])).toEqual([]);
  });

  it('keeps the eye check and the blood tests of the same day apart when only the blood tests are linked to their visit', () => {
    const docs = [doc('thyroid-consult', '2025-05-26'), doc('blood', '2025-06-02'), doc('eye', '2025-06-02'), doc('glasses', '2025-06-02')];
    const groups = sorted(clusterDocuments(docs, [link('thyroid-consult', 'blood'), link('eye', 'glasses', { kind: 'same_episode' })]));
    expect(groups).toEqual([['blood', 'thyroid-consult'], ['eye', 'glasses']]);
  });

  it('ignores a link the owner dismissed', () => {
    expect(clusterDocuments([doc('a', '2026-03-01'), doc('b', '2026-03-02')], [link('a', 'b', { state: 'dismissed' })])).toEqual([]);
  });

  it('ignores a link to a document that is not among those given', () => {
    expect(clusterDocuments([doc('a', '2026-03-01'), doc('b', '2026-03-02')], [link('a', 'gone'), link('gone', 'b')])).toEqual([]);
  });
});

describe('an episode is a care cycle and not everything that is connected', () => {
  it('does not join two documents further apart than the gap, however firmly they are linked', () => {
    const docs = [doc('control', '2025-02-24'), doc('next-consult', date('2025-02-24', MAX_GAP_DAYS + 1))];
    expect(clusterDocuments(docs, [link('control', 'next-consult', { kind: 'follow_up', state: 'confirmed', source: 'owner' })])).toEqual([]);
    expect(clusterDocuments([doc('a', '2025-02-24'), doc('b', date('2025-02-24', MAX_GAP_DAYS))], [link('a', 'b')])).toEqual([['a', 'b']]);
  });

  it('turns three thyroid cycles joined by follow-up links into three episodes, not one a year long', () => {
    const docs = [
      doc('t1-consult', '2025-02-10'), doc('t1-lab', '2025-02-17'), doc('t1-control', '2025-02-24'), doc('t1-rx', '2025-02-24'),
      doc('t2-consult', '2025-05-26'), doc('t2-lab', '2025-06-02'), doc('t2-control', '2025-06-09'), doc('t2-rx', '2025-06-09'),
      doc('t3-consult', '2025-11-17'), doc('t3-lab', '2025-11-24'), doc('t3-control', '2025-12-01'),
    ];
    const links = [
      link('t1-consult', 't1-lab'), link('t1-consult', 't1-control', { kind: 'follow_up' }), link('t1-control', 't1-rx', { kind: 'same_episode' }),
      link('t2-consult', 't2-lab'), link('t2-consult', 't2-control', { kind: 'follow_up' }), link('t2-control', 't2-rx', { kind: 'same_episode' }),
      link('t3-consult', 't3-lab'), link('t3-consult', 't3-control', { kind: 'follow_up' }),
      link('t1-control', 't2-consult', { kind: 'follow_up' }), link('t2-control', 't3-consult', { kind: 'follow_up' }),
    ];
    expect(sorted(clusterDocuments(docs, links))).toEqual([
      ['t1-consult', 't1-control', 't1-lab', 't1-rx'], ['t2-consult', 't2-control', 't2-lab', 't2-rx'], ['t3-consult', 't3-control', 't3-lab'],
    ]);
  });

  it('never makes a group that spans more than the limit, though every document is linked to the next a few weeks on', () => {
    const docs = Array.from({ length: 13 }, (_, i) => doc(`v${i}`, date('2025-01-01', i * 30)));
    const links = docs.slice(1).map((d, i) => link(docs[i]!.id, d.id, { kind: 'follow_up' }));
    const groups = clusterDocuments(docs, links);
    expect(groups.length).toBeGreaterThanOrEqual(3);
    const when = new Map(docs.map(d => [d.id, Date.parse(`${d.doc_date}T00:00:00Z`) / DAY]));
    for (const g of groups) {
      const days = g.map(id => when.get(id)!);
      expect(Math.max(...days) - Math.min(...days), g.join(',')).toBeLessThanOrEqual(MAX_SPAN_DAYS);
    }
  });

  it('does not make an episode of a crowd: a group is never larger than the limit', () => {
    const docs = Array.from({ length: MAX_DOCUMENTS + 3 }, (_, i) => doc(`d${i}`, '2026-03-01'));
    const links = docs.slice(1).map((d, i) => link(docs[i]!.id, d.id, { kind: 'same_episode' }));
    for (const g of clusterDocuments(docs, links)) expect(g.length).toBeLessThanOrEqual(MAX_DOCUMENTS);
  });

  it('uses the nearest links first, so a cycle is whole before a follow-up reaches the next one', () => {
    // a-b-c within a month; c-d 55 days on; d-e within a week: the span limit falls between c and d, not through the middle of a cycle
    const docs = [doc('a', '2025-01-01'), doc('b', '2025-01-10'), doc('c', '2025-01-30'), doc('d', '2025-03-26'), doc('e', '2025-04-02'), doc('f', '2025-04-20')];
    const links = [link('a', 'b'), link('b', 'c'), link('c', 'd', { kind: 'follow_up' }), link('d', 'e'), link('e', 'f', { kind: 'follow_up' })];
    const groups = sorted(clusterDocuments(docs, links));
    expect(groups.flat().sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    for (const g of groups) expect(g.length).toBeGreaterThanOrEqual(2);
  });
});

describe('what has no date', () => {
  it('is joined only by a link the owner made or confirmed, not by a guess', () => {
    const docs = [doc('a', '2026-03-01'), doc('undated', null)];
    expect(clusterDocuments(docs, [link('a', 'undated')])).toEqual([]);
    expect(clusterDocuments(docs, [link('a', 'undated', { state: 'confirmed' })])).toEqual([['a', 'undated']]);
    expect(clusterDocuments(docs, [link('a', 'undated', { source: 'owner', state: 'confirmed' })])).toEqual([['a', 'undated']]);
  });
});

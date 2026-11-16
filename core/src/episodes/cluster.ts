import type { Document } from '../types.js';
import type { LinkKind } from '../store/types.js';

/**
 * Which documents may be one episode, from the links between them. An episode is a care cycle (a visit, what it asked for, what answered it, the visit that read the answers), not everything
 * that is connected: documents are joined one link at a time, the nearest in time first, and a link is not used when it would join two documents more than `MAX_GAP_DAYS` apart or make a group
 * that spans more than `MAX_SPAN_DAYS` or holds more than `MAX_DOCUMENTS`. So a chain of follow-ups, each a few weeks after the last, is a series of episodes joined by their follow-up links and
 * never one episode a year long, and a clinic that issued two unrelated documents the same day does not make them one (only a link does; the same provider alone says nothing). Pure.
 */
export const MAX_GAP_DAYS = 60;
export const MAX_SPAN_DAYS = 120;
export const MAX_DOCUMENTS = 12;
const DAY = 86_400_000;

export interface EpisodeLink {
  from: string;
  to: string;
  kind?: LinkKind;
  state?: 'proposed' | 'confirmed' | 'dismissed';
  source?: 'auto' | 'owner';
}

const dayOf = (date: string | null): number | null => {
  if (!date) return null;
  const t = Date.parse(`${date}T00:00:00Z`);
  return Number.isNaN(t) ? null : Math.floor(t / DAY);
};

const RANK: Record<LinkKind, number> = { requests: 0, follow_up: 1, same_episode: 2 };

/** The groups of two or more documents that may be one episode each. */
export function clusterDocuments(docs: Array<Pick<Document, 'id' | 'doc_date'>>, links: EpisodeLink[]): string[][] {
  const day = new Map(docs.map(d => [d.id, dayOf(d.doc_date)]));
  const parent = new Map(docs.map(d => [d.id, d.id]));
  const size = new Map(docs.map(d => [d.id, 1]));
  const first = new Map<string, number | null>(docs.map(d => [d.id, day.get(d.id) ?? null]));
  const last = new Map<string, number | null>(first);
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(id, root);
    return root;
  };

  const usable = links
    .filter(l => l.state !== 'dismissed' && day.has(l.from) && day.has(l.to) && l.from !== l.to)
    .map(l => {
      const a = day.get(l.from) ?? null, b = day.get(l.to) ?? null;
      return { l, gap: a !== null && b !== null ? Math.abs(a - b) : null };
    })
    // two documents far apart are not joined directly; an undated one is joined only to a dated or undated neighbour by a link the owner made or confirmed
    .filter(x => x.gap === null ? (x.l.source === 'owner' || x.l.state === 'confirmed') : x.gap <= MAX_GAP_DAYS);

  const strength = (l: EpisodeLink) => (l.source === 'owner' ? 0 : l.state === 'confirmed' ? 1 : 2);
  usable.sort((x, y) => strength(x.l) - strength(y.l) || (x.gap ?? MAX_GAP_DAYS) - (y.gap ?? MAX_GAP_DAYS) || RANK[x.l.kind ?? 'same_episode'] - RANK[y.l.kind ?? 'same_episode']);

  for (const { l } of usable) {
    const a = find(l.from), b = find(l.to);
    if (a === b) continue;
    if (size.get(a)! + size.get(b)! > MAX_DOCUMENTS) continue;
    const lo = [first.get(a), first.get(b)].filter((x): x is number => x !== null && x !== undefined);
    const hi = [last.get(a), last.get(b)].filter((x): x is number => x !== null && x !== undefined);
    const from = lo.length ? Math.min(...lo) : null, to = hi.length ? Math.max(...hi) : null;
    if (from !== null && to !== null && to - from > MAX_SPAN_DAYS) continue;
    parent.set(a, b);
    size.set(b, size.get(a)! + size.get(b)!);
    first.set(b, from); last.set(b, to);
  }

  const groups = new Map<string, string[]>();
  for (const d of docs) groups.set(find(d.id), [...(groups.get(find(d.id)) ?? []), d.id]);
  return [...groups.values()].filter(g => g.length >= 2);
}

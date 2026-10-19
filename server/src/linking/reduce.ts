import type { LinkKind } from '../store/types.js';

/**
 * Which links say nothing new. Every document is judged on its own, so a pair is judged from both sides (and may be given two kinds), and
 * "same episode" is found between every pair of a group: five documents of one hospital stay become ten of them. A link is redundant when
 *
 *  - the pair already has a link at least as informative (a request says more than a follow-up, and a follow-up more than the same episode), or
 *  - it is "same episode" and its two documents are already joined by other links of any kind: an episode is a group, and two documents
 *    that a consultation asked for are in it together without saying so a third time.
 *
 * What the owner made is never redundant (it is not hidden or removed), and what they confirmed is looked at before what is only suggested,
 * so a suggestion that repeats a confirmed link is the one that goes. Pure: it only sorts links into two lists.
 */
export interface ReducibleLink {
  from_document_id: string;
  to_document_id: string;
  kind: LinkKind;
  state: 'proposed' | 'confirmed' | 'dismissed';
  source: 'auto' | 'owner';
}

const RANK: Record<LinkKind, number> = { requests: 3, follow_up: 2, same_episode: 1 };

export function reduceLinks<T extends ReducibleLink>(links: T[]): { keep: T[]; redundant: T[] } {
  const live = links.filter(l => l.state !== 'dismissed');
  const group = (l: T) => (l.source === 'owner' ? 0 : l.state === 'confirmed' ? 1 : 2);
  const ordered = [...live].sort((a, b) => group(a) - group(b) || RANK[b.kind] - RANK[a.kind]);

  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = parent.get(x) ?? x;
    while ((parent.get(root) ?? root) !== root) root = parent.get(root)!;
    parent.set(x, root);
    return root;
  };
  const join = (a: string, b: string) => { parent.set(find(a), find(b)); };
  const bestOfPair = new Map<string, number>();
  const pairKey = (l: ReducibleLink) => [l.from_document_id, l.to_document_id].sort().join('|');

  // The stronger kinds first within a group, so the episode check sees everything they already join.
  const keep: T[] = [];
  const redundant: T[] = [];
  for (const l of ordered) {
    const key = pairKey(l);
    const covered = (bestOfPair.get(key) ?? 0) >= RANK[l.kind];
    const joined = l.kind === 'same_episode' && find(l.from_document_id) === find(l.to_document_id);
    if (l.source !== 'owner' && (covered || joined)) { redundant.push(l); continue; }
    keep.push(l);
    bestOfPair.set(key, Math.max(bestOfPair.get(key) ?? 0, RANK[l.kind]));
    join(l.from_document_id, l.to_document_id);
  }
  return { keep, redundant };
}

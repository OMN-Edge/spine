import { describe, it, expect } from 'vitest';
import { reduceLinks, type ReducibleLink } from '../linking/reduce.js';

/** Invented documents. A pair is one line; "same episode" is a group, not a clique (SECURITY.md M-16). */
const L = (from: string, to: string, kind: ReducibleLink['kind'], state: ReducibleLink['state'] = 'proposed', source: ReducibleLink['source'] = 'auto'): ReducibleLink => ({ from_document_id: from, to_document_id: to, kind, state, source });
const names = (links: ReducibleLink[]) => links.map(l => `${l.from_document_id}>${l.to_document_id}:${l.kind}`).sort();

describe('links that say nothing new', () => {
  it('keeps one line for a pair: the more informative kind', () => {
    const { keep, redundant } = reduceLinks([L('A', 'B', 'same_episode'), L('A', 'B', 'requests'), L('B', 'A', 'follow_up')]);
    expect(names(keep)).toEqual(['A>B:requests']);
    expect(names(redundant)).toEqual(['A>B:same_episode', 'B>A:follow_up']);
  });

  it('keeps a group of documents as a group: an episode link between two that others already join is dropped', () => {
    // A consultation asked for two reports; they are one episode with it and with each other, said once.
    const { keep } = reduceLinks([L('S', 'B1', 'requests'), L('S', 'B2', 'requests'), L('B1', 'B2', 'same_episode'), L('S', 'B1', 'same_episode'), L('S', 'B2', 'same_episode')]);
    expect(names(keep)).toEqual(['S>B1:requests', 'S>B2:requests']);
  });

  it('turns a clique of "same episode" into a chain of them', () => {
    const clique = [L('A', 'B', 'same_episode'), L('A', 'C', 'same_episode'), L('A', 'D', 'same_episode'), L('B', 'C', 'same_episode'), L('B', 'D', 'same_episode'), L('C', 'D', 'same_episode')];
    const { keep, redundant } = reduceLinks(clique);
    expect(keep).toHaveLength(3); // four documents, one group
    expect(redundant).toHaveLength(3);
  });

  it('does not join two groups that nothing joins', () => {
    const { keep } = reduceLinks([L('A', 'B', 'same_episode'), L('C', 'D', 'same_episode')]);
    expect(keep).toHaveLength(2);
  });

  it('never drops what the owner made, and looks at what they confirmed before what is only suggested', () => {
    const mine = L('A', 'B', 'same_episode', 'confirmed', 'owner');
    const stronger = L('A', 'B', 'requests', 'confirmed');
    expect(reduceLinks([stronger, mine]).keep).toHaveLength(2); // the owner's stays beside a stronger one
    // A suggestion that repeats a confirmed link is the one that goes, whatever its kind.
    const { keep, redundant } = reduceLinks([L('A', 'B', 'requests', 'proposed'), L('A', 'B', 'requests', 'confirmed'), L('A', 'B', 'same_episode', 'confirmed')]);
    expect(keep.map(l => [l.kind, l.state])).toEqual([['requests', 'confirmed']]);
    expect(redundant).toHaveLength(2);
  });

  it('a suggestion with a kind the confirmed link lacks is kept: they say different things', () => {
    const { keep } = reduceLinks([L('A', 'B', 'same_episode', 'confirmed'), L('A', 'B', 'requests', 'proposed')]);
    expect(names(keep)).toEqual(['A>B:requests', 'A>B:same_episode']);
  });

  it('ignores dismissed links', () => {
    const { keep, redundant } = reduceLinks([L('A', 'B', 'requests', 'dismissed'), L('A', 'B', 'same_episode')]);
    expect(names(keep)).toEqual(['A>B:same_episode']);
    expect(redundant).toEqual([]);
  });
});

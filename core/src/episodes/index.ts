import { v4 as uuidv4 } from 'uuid';
import { getStore } from '../store/index.js';
import type { Document } from '../types.js';
import { logger } from '../logger.js';
import { describeError } from '../failure.js';
import { linkingEnabled } from '../config.js';
import { clusterDocuments, type EpisodeLink } from './cluster.js';

/**
 * Proposing episodes (FR-ORG-01): which documents may belong together, from the data and from nothing else. No model is asked and no
 * title is written: an episode the app proposes has an empty title, which the pages show as the provider and the dates the documents
 * themselves give, so nothing in a title can be a clinical inference (FR-ORG-08). The owner confirms, renames or dismisses.
 *
 * Documents are joined by the links between them (suggested or confirmed; not one the owner dismissed), one link at a time, nearest in time first, and never into a group that
 * spans more than a care cycle (`cluster.ts`): a year of follow-ups is a series of episodes, not one. The same provider alone joins nothing, since a clinic issues unrelated documents
 * the same day; it is used only where no links are looked for at all (`SPINE_LINKING` off), as a first guess with the same limits. A group has two to `MAX_DOCUMENTS` documents.
 */
const NEAR_DAYS = 14;
const DAY = 86_400_000;

const dayOf = (date: string | null): number | null => {
  if (!date) return null;
  const t = Date.parse(`${date}T00:00:00Z`);
  return Number.isNaN(t) ? null : Math.floor(t / DAY);
};
const providerKey = (p: string | null): string | null => {
  const key = p?.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return key || null;
};

/**
 * The groups of documents that may belong together. Pure; the caller keeps out what is already placed. With `providerFallback`, two documents of one provider within `NEAR_DAYS` of each
 * other are taken as linked too (for an archive nothing has looked for links in).
 */
export function groupDocuments(docs: Document[], links: EpisodeLink[], options: { providerFallback?: boolean } = {}): string[][] {
  const all: EpisodeLink[] = [...links];
  if (options.providerFallback) {
    for (let i = 0; i < docs.length; i++) {
      const a = docs[i]!;
      const ka = providerKey(a.provider); const da = dayOf(a.doc_date);
      if (!ka || da === null) continue;
      for (let j = i + 1; j < docs.length; j++) {
        const b = docs[j]!;
        const db = dayOf(b.doc_date);
        if (db !== null && providerKey(b.provider) === ka && Math.abs(da - db) <= NEAR_DAYS) all.push({ from: a.id, to: b.id, kind: 'same_episode', state: 'proposed', source: 'auto' });
      }
    }
  }
  return clusterDocuments(docs, all);
}

/**
 * Brings the app's proposals up to date for documents not yet in an episode: one for the same documents stays (same id), the rest are replaced. A confirmed episode keeps its
 * documents, and a group the owner dismissed is not proposed again. Returns how many were proposed.
 */
export async function proposeEpisodes(userId: string): Promise<number> {
  const store = getStore();
  const [visible, links, held] = await Promise.all([
    store.documents.listFor(userId, { limit: 1_000_000, offset: 0 }),
    store.links.all(userId),
    store.episodes.list(userId),
  ]);
  const shown = new Set(visible.map(d => d.id));
  const placed = new Set(held.filter(e => e.state === 'confirmed').flatMap(e => e.document_ids));
  const dismissed = held.filter(e => e.state === 'dismissed').map(e => new Set(e.document_ids));

  const free = visible.filter(d => !placed.has(d.id));
  const groups = groupDocuments(
    free,
    links.filter(l => l.state !== 'dismissed' && shown.has(l.from_document_id) && shown.has(l.to_document_id)).map(l => ({ from: l.from_document_id, to: l.to_document_id, kind: l.kind, state: l.state, source: l.source })),
    { providerFallback: !linkingEnabled() },
  ).filter(g => !dismissed.some(set => g.every(id => set.has(id))));

  const now = new Date().toISOString();
  const keyOf = (ids: string[]) => [...ids].sort().join('|');
  await store.transaction(async tx => {
    // A proposal for the same documents stays as it is (the page may be showing it); the others go and the new ones come.
    const standing = new Map(held.filter(e => e.state === 'proposed' && e.source === 'auto').map(e => [keyOf(e.document_ids), e.id]));
    const wanted = new Set(groups.map(keyOf));
    for (const [key, id] of standing) if (!wanted.has(key)) await tx.episodes.remove(userId, id);
    for (const ids of groups) {
      if (standing.has(keyOf(ids))) continue;
      await tx.episodes.create(userId, { id: uuidv4(), title: '', state: 'proposed', source: 'auto', documentIds: ids }, now);
    }
  });
  return groups.length;
}

const timers = new Map<string, NodeJS.Timeout>();

/** Looks for episodes soon, once, whatever changed in between. Never throws and never blocks the request that changed something. */
export function scheduleEpisodes(userId: string, delayMs = 5000): void {
  clearTimeout(timers.get(userId));
  const timer = setTimeout(() => {
    timers.delete(userId);
    proposeEpisodes(userId).catch(err => logger.warn('could not look for episodes', { error: describeError(err) }));
  }, delayMs);
  timer.unref?.(); // a browser timer has no unref (this runs on the device too)
  timers.set(userId, timer);
}

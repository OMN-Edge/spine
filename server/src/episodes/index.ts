import { v4 as uuidv4 } from 'uuid';
import { getStore } from '../store/index.js';
import type { Document } from '../types.js';
import { logger } from '../logger.js';
import { describeError } from '../failure.js';

/**
 * Proposing episodes (FR-ORG-01): which documents may belong together, from the data and from nothing else. No model is asked and no
 * title is written: an episode the app proposes has an empty title, which the pages show as the provider and the dates the documents
 * themselves give, so nothing in a title can be a clinical inference (FR-ORG-08). The owner confirms, renames or dismisses.
 *
 * Two documents are joined when a link joins them (suggested or confirmed; not one the owner dismissed), or when the same provider
 * issued both within `NEAR_DAYS` of each other. A group is proposed when it has two to `MAX_DOCUMENTS` documents. First guesses.
 */
const NEAR_DAYS = 14;
const MAX_DOCUMENTS = 12;
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

/** The groups of documents that may belong together. Pure; the caller keeps out what is already placed. */
export function groupDocuments(docs: Document[], links: Array<{ from: string; to: string }>): string[][] {
  const parent = new Map(docs.map(d => [d.id, d.id]));
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(id, root);
    return root;
  };
  const join = (a: string, b: string) => { if (parent.has(a) && parent.has(b)) parent.set(find(a), find(b)); };

  for (const l of links) join(l.from, l.to);
  for (let i = 0; i < docs.length; i++) {
    const a = docs[i];
    const ka = providerKey(a.provider); const da = dayOf(a.doc_date);
    if (!ka || da === null) continue;
    for (let j = i + 1; j < docs.length; j++) {
      const b = docs[j];
      const db = dayOf(b.doc_date);
      if (db !== null && providerKey(b.provider) === ka && Math.abs(da - db) <= NEAR_DAYS) join(a.id, b.id);
    }
  }

  const groups = new Map<string, string[]>();
  for (const d of docs) {
    const root = find(d.id);
    groups.set(root, [...(groups.get(root) ?? []), d.id]);
  }
  return [...groups.values()].filter(g => g.length >= 2 && g.length <= MAX_DOCUMENTS);
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
    links.filter(l => l.state !== 'dismissed' && shown.has(l.from_document_id) && shown.has(l.to_document_id)).map(l => ({ from: l.from_document_id, to: l.to_document_id })),
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
  timer.unref();
  timers.set(userId, timer);
}

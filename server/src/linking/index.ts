import { getStore } from '../store/index.js';
import { getChatLlm } from '../llm/index.js';
import { linkingEnabled } from '../config.js';
import { logger } from '../logger.js';
import { describeError } from '../failure.js';
import { cardOf } from '../similarity/card.js';
import { reduceLinks } from './reduce.js';
import { scheduleEpisodes } from '../episodes/index.js';
import { buildWhy, parseWhy, serializeWhy, type LinkWhy } from './why.js';
import { similarTo, similarityEnabled } from '../similarity/index.js';
import type { Store } from '../store/index.js';
import type { Document, DocType } from '../types.js';
import type { LinkKind } from '../store/types.js';
import type { LinkJudgement, LinkRelation } from '../llm/types.js';

/**
 * Care chains: which documents ask for, follow up, or belong with which. Finding them is two steps. The first is cheap
 * and needs no model: score the person's other documents by what the data already says (a shared test or doctor,
 * likeness in meaning, how near in time a consultation and an examination are). With no candidate the model is not
 * called. The second is one model call per document, over the summary cards of the target and at most `MAX_CANDIDATES`
 * candidates; it only judges, and code turns its answer into links and refuses the ones that run backwards in time.
 *
 * Automatic links are `proposed`; the owner confirms or dismisses them, and a dismissed pair is never proposed again.
 */
const MAX_CANDIDATES = 6;
const MAX_TEMPORAL = 3;
const NOTES_MAX = 600;
const WINDOW_DAYS = 730;
const NEAR_DAYS = 90;
const MANY = 1_000_000;
const DAY = 86_400_000;

/** Documents that ask for or follow up things, and the ones that answer them. */
const ASKS: ReadonlySet<DocType> = new Set(['consultation_note', 'prescription', 'discharge_note']);
const ANSWERS: ReadonlySet<DocType> = new Set(['lab_result', 'imaging']);

const dayOf = (date: string | null): number | null => {
  if (!date) return null;
  const t = Date.parse(`${date}T00:00:00Z`);
  return Number.isNaN(t) ? null : Math.floor(t / DAY);
};

interface Candidate { doc: Document; score: number }

/** Who in the archive might be linked to this document, best first. Pure reading; no model. */
export async function candidatesFor(store: Store, userId: string, target: Document, visible: Document[]): Promise<Document[]> {
  const others = new Map(visible.filter(d => d.id !== target.id).map(d => [d.id, d]));
  const [signals, similar, dismissed] = await Promise.all([
    store.documents.relatedSignals(userId, target.id),
    similarityEnabled() ? similarTo(userId, target.id, 10).catch(() => []) : Promise.resolve([]),
    store.links.dismissedPairs(userId, target.id),
  ]);
  const t0 = dayOf(target.doc_date);
  const scored = new Map<string, Candidate>();
  const add = (id: string, points: number) => {
    const doc = others.get(id);
    if (!doc || dismissed.has(id)) return;
    // Two dated documents far apart are not one chain.
    const d0 = dayOf(doc.doc_date);
    if (t0 !== null && d0 !== null && Math.abs(t0 - d0) > WINDOW_DAYS) return;
    const entry = scored.get(id) ?? { doc, score: 0 };
    entry.score += points;
    scored.set(id, entry);
  };

  for (const s of signals) {
    add(s.document_id, Math.min(s.shared_tests.length, 3) + Math.min(s.shared_doctors.length, 2) * 0.8 + Math.min(s.shared_tags.length, 3) * 0.2);
  }
  for (const s of similar) add(s.id, (s.score - 0.5) * 6);

  // Nearest examinations after a consultation, or the consultation before an examination, whatever else is known.
  if (t0 !== null && target.doc_type) {
    const wants = ASKS.has(target.doc_type) ? ANSWERS : ANSWERS.has(target.doc_type) ? ASKS : null;
    if (wants) {
      const near = [...others.values()]
        .filter(d => d.doc_type && wants.has(d.doc_type))
        .map(d => ({ d, gap: ASKS.has(target.doc_type!) ? (dayOf(d.doc_date) ?? NaN) - t0 : t0 - (dayOf(d.doc_date) ?? NaN) }))
        .filter(x => x.gap >= 0 && x.gap <= NEAR_DAYS)
        .sort((a, b) => a.gap - b.gap)
        .slice(0, MAX_TEMPORAL);
      for (const { d, gap } of near) add(d.id, 1 + (NEAR_DAYS - gap) / NEAR_DAYS);
    }
  }

  return [...scored.values()].sort((a, b) => b.score - a.score).slice(0, MAX_CANDIDATES).map(c => c.doc);
}

/**
 * The signals behind each candidate, for the owner to see why it was suggested: what the data shares with the target, how far
 * apart in time they are, and how close in meaning when that search is on. Code, not the model.
 */
export async function whyFor(store: Store, userId: string, target: Document, candidates: Document[]): Promise<Map<string, LinkWhy | null>> {
  const [signals, similar] = await Promise.all([
    store.documents.relatedSignals(userId, target.id),
    similarityEnabled() ? similarTo(userId, target.id, 20).catch(() => []) : Promise.resolve([]),
  ]);
  const signalOf = new Map(signals.map(s => [s.document_id, s]));
  const scoreOf = new Map(similar.map(s => [s.id, s.score]));
  const t0 = dayOf(target.doc_date);
  return new Map(candidates.map(c => {
    const d0 = dayOf(c.doc_date);
    return [c.id, buildWhy(signalOf.get(c.id), { daysApart: t0 !== null && d0 !== null ? Math.abs(t0 - d0) : null, similarity: scoreOf.get(c.id) ?? null })];
  }));
}

/** What the model is shown about one document: its summary card, and who acted in which role (a referrer says "requested by"). */
async function linkCard(store: Store, userId: string, doc: Document): Promise<string> {
  const [card, doctors] = await Promise.all([cardOf(store, userId, doc), store.doctors.forDocument(userId, doc.id)]);
  const roles = doctors.slice(0, 6).map(d => `${d.role}: ${d.name}`).join('; ');
  // The owner's own words about a document are the best hint of how it connects ("after the March visit"), so they go too.
  const notes = doc.user_notes?.replace(/\s+/g, ' ').trim();
  return [card, roles && `roles — ${roles}`, notes && `owner's notes: ${notes.length > NOTES_MAX ? `${notes.slice(0, NOTES_MAX)}…` : notes}`].filter(Boolean).join('\n');
}

/** Turns a judgement into a link between the earlier and the later document, or nothing if the dates contradict it. */
export function linkFromRelation(relation: LinkRelation, target: Document, candidate: Document): { from: Document; to: Document; kind: LinkKind } | null {
  const [from, to, kind]: [Document, Document, LinkKind] =
    relation === 'candidate_requested_target' ? [candidate, target, 'requests']
    : relation === 'target_requested_candidate' ? [target, candidate, 'requests']
    : relation === 'target_follows_up_candidate' ? [candidate, target, 'follow_up']
    : relation === 'candidate_follows_up_target' ? [target, candidate, 'follow_up']
    : [target, candidate, 'same_episode'];
  const a = dayOf(from.doc_date); const b = dayOf(to.doc_date);
  if (kind === 'same_episode') {
    // Stored once, earlier first; undated ones fall back to a fixed order so the same pair is never stored twice.
    const swap = a !== null && b !== null ? a > b : from.id > to.id;
    return swap ? { from: to, to: from, kind } : { from, to, kind };
  }
  if (a !== null && b !== null && a > b) return null; // a request or a follow-up never points back in time
  return { from, to, kind };
}

/**
 * Looks for the links of one document and records them as proposals, replacing the earlier proposals for the pairs it
 * judged again. Nothing is replaced if the model could not answer. Returns how many links were proposed.
 */
export async function findLinks(userId: string, documentId: string): Promise<number> {
  if (!linkingEnabled()) return 0;
  const store = getStore();
  const visible = await store.documents.listFor(userId, { limit: MANY, offset: 0 });
  const target = visible.find(d => d.id === documentId);
  if (!target) return 0;

  const candidates = await candidatesFor(store, userId, target, visible);
  // Nothing to judge: nothing is asked, and nothing already suggested or decided is touched.
  if (candidates.length === 0) return 0;

  const labelled = candidates.map((doc, i) => ({ doc, label: String(i + 1) }));
  const [targetCard, ...cards] = await Promise.all([linkCard(store, userId, target), ...labelled.map(c => linkCard(store, userId, c.doc))]);
  const judgements: LinkJudgement[] | null = await getChatLlm().link(
    { id: 'target', text: targetCard },
    labelled.map((c, i) => ({ id: c.label, text: cards[i] })),
  );
  if (!judgements) return 0;

  const byLabel = new Map(labelled.map(c => [c.label, c.doc]));
  const whyOf = await whyFor(store, userId, target, candidates);
  const now = new Date().toISOString();
  let proposed = 0;
  await store.transaction(async tx => {
    // Only the pairs judged again are replaced: a suggestion made from the other document's side, about a pair this
    // search did not look at, stays, and what the owner confirmed or dismissed is never touched.
    await tx.links.clearProposedBetween(userId, documentId, candidates.map(c => c.id));
    // What a suggestion would add must not repeat what is already there (or what this same search just suggested):
    // the same pair under another kind, or another "same episode" inside a group that is one already.
    const standing = (await tx.links.among(userId, [documentId, ...candidates.map(c => c.id)])).filter(l => l.state !== 'dismissed');
    const fresh: Array<{ from_document_id: string; to_document_id: string; kind: LinkKind; state: 'proposed'; source: 'auto'; reason: string | null }> = [];
    const seen = new Set<string>();
    for (const j of judgements) {
      const candidate = byLabel.get(j.candidate);
      const link = candidate && linkFromRelation(j.relation, target, candidate);
      if (!link) continue;
      const key = `${link.from.id}|${link.to.id}|${link.kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      fresh.push({ from_document_id: link.from.id, to_document_id: link.to.id, kind: link.kind, state: 'proposed', source: 'auto', reason: serializeWhy(whyOf.get(candidate!.id) ?? null) });
    }
    const { keep } = reduceLinks([...standing, ...fresh]);
    for (const f of fresh) {
      if (!keep.includes(f)) continue;
      if (await tx.links.add(userId, f, now)) proposed++;
    }
  });
  return proposed;
}

const pending = new Map<string, Set<string>>();
const running = new Set<string>();
const timers = new Map<string, NodeJS.Timeout>();

async function drain(userId: string): Promise<void> {
  running.add(userId);
  try {
    for (;;) {
      const queue = pending.get(userId);
      const next = queue?.values().next();
      if (!queue || !next || next.done) break;
      queue.delete(next.value);
      try { await findLinks(userId, next.value); }
      catch (err) { logger.warn('could not look for links', { error: describeError(err) }); }
    }
    await tidyLinks(userId).catch(err => logger.warn('could not tidy links', { error: describeError(err) }));
    // New suggestions are new evidence for which documents belong together.
    scheduleEpisodes(userId, 1000);
  } finally {
    pending.delete(userId);
    running.delete(userId);
  }
}

/**
 * Looks for links for these documents in the background, soon, one person's documents one at a time. Never throws and never
 * blocks the request that changed something; a failure is logged and the owner can ask again from the document.
 */
export function scheduleLinking(userId: string, documentIds: string[], delayMs = 3000): void {
  if (!linkingEnabled() || documentIds.length === 0) return;
  const queue = pending.get(userId) ?? new Set<string>();
  documentIds.forEach(id => queue.add(id));
  pending.set(userId, queue);
  clearTimeout(timers.get(userId));
  timers.set(userId, setTimeout(() => {
    timers.delete(userId);
    if (!running.has(userId)) void drain(userId);
  }, delayMs));
  timers.get(userId)?.unref();
}

/** Whether a person's documents are being looked at or waiting to be. */
export const isLinking = (userId: string): boolean => running.has(userId) || pending.has(userId);

/** Tests: waits for the work a schedule started. */
export async function settleLinking(userId: string): Promise<void> {
  clearTimeout(timers.get(userId));
  timers.delete(userId);
  while (running.has(userId)) await new Promise(r => setTimeout(r, 5));
  if (pending.has(userId)) await drain(userId);
}

export interface ChainNode { id: string; title: string | null; doc_type: Document['doc_type']; doc_date: string | null; provider: string | null }
export interface ChainEdge { from: string; to: string; kind: LinkKind; state: 'proposed' | 'confirmed'; source: 'auto' | 'owner'; why: LinkWhy | null }

const MAX_NODES = 30;

/**
 * The chain around a document: the documents connected to it through links the owner has not dismissed, nearest first,
 * capped, ordered by date with the document itself marked by the caller. Every lookup goes through the store as the user.
 */
export async function chainOf(userId: string, documentId: string): Promise<{ nodes: ChainNode[]; edges: ChainEdge[] } | null> {
  const store = getStore();
  const start = await store.documents.findFor(userId, documentId);
  if (!start) return null;

  const included = new Set<string>([documentId]);
  let frontier = [documentId];
  while (frontier.length > 0 && included.size < MAX_NODES) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const l of await store.links.forDocument(userId, id)) {
        if (l.state === 'dismissed') continue;
        for (const other of [l.from_document_id, l.to_document_id]) {
          if (included.size < MAX_NODES && !included.has(other)) { included.add(other); next.push(other); }
        }
      }
    }
    frontier = next;
  }

  const ids = [...included];
  // Shown without what repeats itself: one line for a pair, and no "same episode" between documents a group already joins.
  const edges = reduceLinks(await store.links.among(userId, ids)).keep
    .filter((l): l is typeof l & { state: 'proposed' | 'confirmed' } => l.state !== 'dismissed')
    .map(l => ({ from: l.from_document_id, to: l.to_document_id, kind: l.kind, state: l.state, source: l.source, why: parseWhy(l.reason) }));
  const nodes: ChainNode[] = [];
  for (const id of ids) {
    const doc = id === documentId ? start : await store.documents.findFor(userId, id);
    if (doc) nodes.push({ id: doc.id, title: doc.title, doc_type: doc.doc_type, doc_date: doc.doc_date, provider: doc.provider });
  }
  nodes.sort((a, b) => (a.doc_date ?? '9999').localeCompare(b.doc_date ?? '9999') || a.id.localeCompare(b.id));
  return { nodes, edges };
}

export interface SharedChain {
  nodes: Array<{ id: string; title: string | null; doc_type: ChainNode['doc_type']; doc_date: string | null; provider: string | null }>;
  /** Direction and kind only: not who made the link, not why, not whether it was ever a suggestion. */
  edges: Array<{ from: string; to: string; kind: ChainEdge['kind'] }>;
}

/**
 * The chain around a document as a share recipient may see it: only links the owner has confirmed, and only between documents the
 * link shares (`shared`, from `listForShare`). A link to a document outside the share is not followed, so it neither appears nor
 * leads anywhere. Reads only.
 */
export async function sharedChainOf(userId: string, documentId: string, shared: ReadonlyMap<string, ChainNode>): Promise<SharedChain | null> {
  if (!shared.has(documentId)) return null;
  const store = getStore();
  const included = new Set<string>([documentId]);
  let frontier = [documentId];
  while (frontier.length > 0 && included.size < MAX_NODES) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const l of await store.links.forDocument(userId, id)) {
        if (l.state !== 'confirmed' || !shared.has(l.from_document_id) || !shared.has(l.to_document_id)) continue;
        for (const other of [l.from_document_id, l.to_document_id]) {
          if (included.size < MAX_NODES && !included.has(other)) { included.add(other); next.push(other); }
        }
      }
    }
    frontier = next;
  }
  const ids = [...included];
  const edges = (await store.links.among(userId, ids))
    .filter(l => l.state === 'confirmed' && shared.has(l.from_document_id) && shared.has(l.to_document_id))
    .map(l => ({ from: l.from_document_id, to: l.to_document_id, kind: l.kind }));
  const nodes = ids.map(id => shared.get(id)!).map(d => ({ id: d.id, title: d.title, doc_type: d.doc_type, doc_date: d.doc_date, provider: d.provider }));
  nodes.sort((a, b) => (a.doc_date ?? '9999').localeCompare(b.doc_date ?? '9999') || a.id.localeCompare(b.id));
  return { nodes, edges };
}

/**
 * Deletes the automatic links that repeat others (see `reduceLinks`): never an owner's link and never a dismissed one. What the owner
 * confirmed from a suggestion goes only when a link they have at least as strong already says it. How many were removed.
 */
export async function tidyLinks(userId: string): Promise<number> {
  const store = getStore();
  const shown = new Set((await store.documents.listFor(userId, { limit: MANY, offset: 0 })).map(d => d.id));
  const live = (await store.links.all(userId)).filter(l => shown.has(l.from_document_id) && shown.has(l.to_document_id));
  let removed = 0;
  for (const l of reduceLinks(live).redundant) {
    if (await store.links.removeAuto(userId, l.from_document_id, l.to_document_id, l.kind)) removed++;
  }
  if (removed > 0) logger.info('redundant links removed', { removed });
  return removed;
}

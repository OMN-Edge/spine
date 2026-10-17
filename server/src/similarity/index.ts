import { getStore } from '../store/index.js';
import { getEmbedder } from '../embedding/index.js';
import { logger } from '../logger.js';
import { describeError } from '../failure.js';
import { cardHash, cardOf } from './card.js';
import type { Document } from '../types.js';

/**
 * Similarity by meaning, and the documents related to one.
 *
 * Vectors are kept per document and per model (`document_embeddings`) and compared only within one model. A vector is
 * current while the document's card still hashes to the digest stored with it, so nothing has to remember to invalidate
 * anything: after a document changes the next sync finds the mismatch and embeds it again. Comparing is a dot product over
 * all of one person's vectors, which for an archive of hundreds or thousands of documents takes milliseconds, so there is
 * no vector index to keep in step. Documents the owner set aside are neither embedded nor found.
 */
const BATCH = 16;
/** First guess for "this reads like that" on a cosine; tune from real archives. */
const MEANING_MIN = 0.65;
/** A query is matched against documents more loosely than two documents are: a floor, and a band below the best hit. */
const QUERY_MIN = 0.45;
const QUERY_BAND = 0.12;
const MANY = 1_000_000;

export function similarityEnabled(): boolean {
  return getEmbedder().enabled;
}

const toBytes = (v: Float32Array): Buffer => Buffer.from(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
const fromBytes = (b: Buffer, dims: number): Float32Array | null => {
  if (b.length !== dims * 4) return null;
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};
const dot = (a: Float32Array, b: Float32Array): number => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

/** How far along the person's archive is: documents that can be found by meaning, of those that could be. */
export async function embeddingStatus(userId: string): Promise<{ enabled: boolean; model: string | null; documents: number; embedded: number }> {
  const embedder = getEmbedder();
  if (!embedder.enabled) return { enabled: false, model: null, documents: 0, embedded: 0 };
  const store = getStore();
  const documents = (await store.documents.listFor(userId, { limit: MANY, offset: 0 })).length;
  const embedded = (await store.embeddings.hashesFor(userId, embedder.id)).size;
  return { enabled: true, model: embedder.id, documents, embedded: Math.min(embedded, documents) };
}

/**
 * Embeds every document whose card differs from what is stored (new, edited, read again, moved). Once the archive is
 * complete in the current model, vectors from other models are removed. Safe to run twice at once only in the sense of
 * writing the same thing; `scheduleSync` keeps it to one at a time.
 */
export async function syncEmbeddings(userId: string): Promise<{ embedded: number }> {
  const embedder = getEmbedder();
  if (!embedder.enabled) return { embedded: 0 };
  const store = getStore();
  const documents = await store.documents.listFor(userId, { limit: MANY, offset: 0 });
  const stored = await store.embeddings.hashesFor(userId, embedder.id);

  const stale: Array<{ doc: Document; card: string; hash: string }> = [];
  for (const doc of documents) {
    const card = await cardOf(store, userId, doc);
    const hash = cardHash(card, embedder.id);
    if (card.trim() && stored.get(doc.id) !== hash) stale.push({ doc, card, hash });
  }
  for (let i = 0; i < stale.length; i += BATCH) {
    const batch = stale.slice(i, i + BATCH);
    const vectors = await embedder.embed(batch.map(b => b.card), 'document');
    const now = new Date().toISOString();
    for (const [j, b] of batch.entries()) {
      await store.embeddings.put(userId, { documentId: b.doc.id, model: embedder.id, dims: embedder.dims, textHash: b.hash, vector: toBytes(vectors[j]) }, now);
    }
  }
  await store.embeddings.pruneOtherModels(userId, embedder.id);
  return { embedded: stale.length };
}

const syncing = new Set<string>();
const again = new Set<string>();
const timers = new Map<string, NodeJS.Timeout>();

/**
 * Brings a person's vectors up to date in the background, soon, once however many changes ask. Never throws and never
 * blocks the request that changed something; a failure is logged and the next change tries again.
 */
export function scheduleSync(userId: string): void {
  if (!similarityEnabled()) return;
  clearTimeout(timers.get(userId));
  timers.set(userId, setTimeout(() => {
    timers.delete(userId);
    if (syncing.has(userId)) { again.add(userId); return; }
    syncing.add(userId);
    syncEmbeddings(userId)
      .catch(err => logger.warn('could not update the embeddings', { error: describeError(err) }))
      .finally(() => {
        syncing.delete(userId);
        if (again.delete(userId)) scheduleSync(userId);
      });
  }, 2000));
  timers.get(userId)?.unref();
}

/** Tests: waits for the work a schedule started. */
export async function settleSync(userId: string): Promise<void> {
  clearTimeout(timers.get(userId));
  timers.delete(userId);
  while (syncing.has(userId)) await new Promise(r => setTimeout(r, 5));
  await syncEmbeddings(userId);
}

async function vectorsOf(userId: string): Promise<Map<string, Float32Array>> {
  const embedder = getEmbedder();
  const out = new Map<string, Float32Array>();
  for (const e of await getStore().embeddings.listFor(userId, embedder.id)) {
    const v = fromBytes(e.vector, e.dims);
    if (v && e.dims === embedder.dims) out.set(e.documentId, v);
  }
  return out;
}

export interface Scored { id: string; score: number }

/** Documents whose meaning is closest to this one's, best first. Empty if it has no vector yet. */
export async function similarTo(userId: string, documentId: string, k: number): Promise<Scored[]> {
  if (!similarityEnabled()) return [];
  const all = await vectorsOf(userId);
  const mine = all.get(documentId);
  if (!mine) return [];
  const scored: Scored[] = [];
  for (const [id, v] of all) if (id !== documentId) scored.push({ id, score: dot(mine, v) });
  return scored.filter(s => s.score >= MEANING_MIN).sort((a, b) => b.score - a.score).slice(0, k);
}

/** Documents closest in meaning to some words, best first. */
export async function searchByMeaning(userId: string, query: string, k: number): Promise<Scored[]> {
  if (!similarityEnabled() || !query.trim()) return [];
  const [q] = await getEmbedder().embed([query.trim().slice(0, 1000)], 'query');
  const scored: Scored[] = [];
  for (const [id, v] of await vectorsOf(userId)) scored.push({ id, score: dot(q, v) });
  scored.sort((a, b) => b.score - a.score);
  // Everything has some cosine to everything: keep what is near the best and not far below any real likeness.
  const best = scored[0]?.score ?? 0;
  return scored.filter(s => s.score >= Math.max(QUERY_MIN, best - QUERY_BAND)).slice(0, k);
}

export type RelatedReason =
  | { kind: 'tests' | 'doctors' | 'tags'; names: string[] }
  | { kind: 'provider' }
  | { kind: 'meaning'; score: number };

export interface RelatedDocument {
  id: string; title: string | null; doc_type: Document['doc_type']; doc_date: string | null; provider: string | null;
  score: number; reasons: RelatedReason[];
}

/**
 * Documents related to this one, with why. The reasons from the data (the same test, the same doctor, tags, provider) come
 * first because they are exact and never drift; meaning, when embeddings are on, adds documents that read alike and
 * strengthens the others.
 */
export async function relatedTo(userId: string, documentId: string, k = 8): Promise<RelatedDocument[]> {
  const store = getStore();
  const [signals, similar] = await Promise.all([store.documents.relatedSignals(userId, documentId), similarTo(userId, documentId, 20)]);
  const byId = new Map<string, { score: number; reasons: RelatedReason[] }>();
  const at = (id: string) => { let e = byId.get(id); if (!e) { e = { score: 0, reasons: [] }; byId.set(id, e); } return e; };

  for (const s of signals) {
    const e = at(s.document_id);
    if (s.shared_tests.length) { e.score += Math.min(s.shared_tests.length, 3); e.reasons.push({ kind: 'tests', names: s.shared_tests }); }
    if (s.shared_doctors.length) { e.score += Math.min(s.shared_doctors.length, 2) * 0.8; e.reasons.push({ kind: 'doctors', names: s.shared_doctors }); }
    if (s.shared_tags.length) { e.score += Math.min(s.shared_tags.length, 3) * 0.3; e.reasons.push({ kind: 'tags', names: s.shared_tags }); }
    if (s.same_provider) { e.score += 0.3; e.reasons.push({ kind: 'provider' }); }
  }
  for (const s of similar) {
    const e = at(s.id);
    e.score += (s.score - 0.5) * 6;
    e.reasons.push({ kind: 'meaning', score: Number(s.score.toFixed(3)) });
  }

  const ranked = [...byId.entries()]
    // A tag or a provider alone says little: a test, a doctor or a likeness is what makes two documents related.
    .filter(([, e]) => e.reasons.some(r => r.kind === 'tests' || r.kind === 'doctors' || r.kind === 'meaning'))
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, k);
  const out: RelatedDocument[] = [];
  for (const [id, e] of ranked) {
    const doc = await store.documents.findFor(userId, id);
    if (doc) out.push({ id, title: doc.title, doc_type: doc.doc_type, doc_date: doc.doc_date, provider: doc.provider, score: Number(e.score.toFixed(3)), reasons: e.reasons });
  }
  return out;
}

export interface HybridHit { doc: Document; via: Array<'words' | 'meaning'> }

/**
 * Search by words (the full-text index) and by meaning together, merged by rank (reciprocal rank fusion): a document that
 * both find rises, one that only one finds still appears. Exact codes and values come from the words; paraphrases and
 * another language from the meaning.
 */
export async function hybridSearch(userId: string, query: string, k: number): Promise<HybridHit[]> {
  const store = getStore();
  const [lexical, semantic] = await Promise.all([
    store.documents.listFor(userId, { q: query, limit: 40, offset: 0 }),
    searchByMeaning(userId, query, 40).catch(err => { logger.warn('search by meaning failed', { error: describeError(err) }); return [] as Scored[]; }),
  ]);
  const K = 60;
  const fused = new Map<string, { score: number; via: Set<'words' | 'meaning'>; doc?: Document }>();
  const take = (id: string) => { let e = fused.get(id); if (!e) { e = { score: 0, via: new Set() }; fused.set(id, e); } return e; };
  lexical.forEach((doc, rank) => { const e = take(doc.id); e.score += 1 / (K + rank); e.via.add('words'); e.doc = doc; });
  semantic.forEach((s, rank) => { const e = take(s.id); e.score += 1 / (K + rank); e.via.add('meaning'); });
  const out: HybridHit[] = [];
  for (const [id, e] of [...fused.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, k)) {
    const doc = e.doc ?? (await store.documents.findFor(userId, id));
    if (doc) out.push({ doc, via: [...e.via] });
  }
  return out;
}

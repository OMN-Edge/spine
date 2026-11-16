import type { Document } from '../types.js';

/**
 * Whether two documents are one document held twice (a report scanned and sent again, a certificate on file from two visits): the same date (or both without one), kind, provider and title, and either read the same
 * (how alike their embeddings are, when that is known) or, without that, with summaries that share most of their words. A copy is not linked to the document it copies and does not carry links of
 * its own: only the earliest of a set of copies is looked at for links, so a pair of copies does not double every suggestion. Pure; two lab reports of one day from one lab with different results
 * are not copies, because their summaries and embeddings differ.
 */
const SAME_SCORE = 0.95;
const SAME_WORDS = 0.7;

const key = (s: string | null): string | null => {
  const k = s?.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return k || null;
};
const words = (s: string | null): Set<string> => new Set((key(s) ?? '').split(' ').filter(w => w.length > 3));

function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / Math.min(a.size, b.size);
}

export function isCopy(a: Document, b: Document, similarity: number | null = null): boolean {
  if (a.id === b.id) return false;
  // the same date, or both undated (a form with no date on it): then only what they say can tell a copy from another document
  if (a.doc_date !== b.doc_date) return false;
  if (!a.doc_type || a.doc_type !== b.doc_type) return false;
  const provider = key(a.provider);
  if (!provider || provider !== key(b.provider)) return false;
  const title = key(a.title);
  if (!title || title !== key(b.title)) return false;
  if (similarity !== null) return similarity >= SAME_SCORE;
  // no embeddings: the summaries must say the same things (a document with no summary yet cannot be told from a copy, so it is not taken for one)
  return !!a.ai_summary && !!b.ai_summary && overlap(words(a.ai_summary), words(b.ai_summary)) >= SAME_WORDS;
}

/** The documents among `others` that are copies of `target`, given how alike each is to it (by id) where that is known. */
export function copiesOf(target: Document, others: Document[], scoreOf: ReadonlyMap<string, number> = new Map()): Document[] {
  return others.filter(d => isCopy(target, d, scoreOf.get(d.id) ?? null));
}

/** Whether `target` is a later copy of a document that is held: the earliest (by id, which is stable) carries the links. */
export function isLaterCopy(target: Document, others: Document[], scoreOf: ReadonlyMap<string, number> = new Map()): boolean {
  return copiesOf(target, others, scoreOf).some(d => d.id < target.id);
}

import { getStore } from '../store/index.js';
import { searchByMeaning } from '../similarity/index.js';
import { logger } from '../logger.js';
import { describeError } from '../failure.js';
import type { Document } from '../types.js';

/**
 * Which documents a question is about. Typed search needs every word to match, which suits a few keywords and fails a
 * sentence: "what was my haemoglobin in March?" has no document containing all of that. So the question is cut to its
 * keywords (filler words dropped, in the four languages of the app), each keyword is searched on its own, and documents are
 * ranked by how many keywords find them and how high; where embeddings are on, a search by meaning of the whole question is
 * fused in the same way (reciprocal rank), which also finds a paraphrase or the other language.
 */
const FILLER = new Set((
  // en
  'a an the and or but if of to in on at by for with from as is are was were be been am do does did have has had i me my mine we our you your it its this that these those ' +
  'what which who whom when where why how can could would should will shall may might any some all about there their them they he she his her not no yes ' +
  'tell show give find list please also last latest first before after between over since during again then than so just ' +
  // ro
  'si sau dar daca de la in pe cu din pentru ca ce care cine cand unde cum de ce este sunt era au am ai are fost fi mai mult foarte imi meu mea mele mei ' +
  'ultimul ultima care arata spune despre intre dupa inainte ' +
  // fr
  'le la les un une des du de et ou mais si dans sur avec pour par que qui quand ou comment quel quelle quels quelles est sont etait ai as avons ont mon ma mes ton ta tes ' +
  // de
  'der die das ein eine und oder aber wenn von zu in auf mit fur als ist sind war waren habe hat haben mein meine was wer wann wo wie welche welcher ' +
  'ich mir mich du dir wir uns'
).split(/\s+/));

const KEYWORDS = 8;
const PER_KEYWORD = 20;
const PER_KEYWORD_SHARED = 500;
const K = 60;
const stripAccents = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function keywordsOf(question: string): string[] {
  const words = question.normalize('NFKC').match(/[\p{L}\p{N}]+/gu) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const word of words) {
    const key = stripAccents(word);
    if (seen.has(key) || FILLER.has(key)) continue;
    // A one- or two-letter word matches too much; a number (a year, a value) is worth keeping.
    if (key.length < 3 && !/^\d+$/.test(key)) continue;
    seen.add(key);
    out.push(word);
  }
  return out.slice(0, KEYWORDS);
}

/**
 * `allowed`: only these documents may be returned. A share recipient's question is held to the link's documents here, before
 * the ranking is cut, so the shared ones are not crowded out by the owner's others; a keyword is searched deeper then, because
 * the search itself cannot be limited to a set.
 */
export async function documentsForQuestion(userId: string, question: string, k: number, allowed?: Set<string>): Promise<Document[]> {
  const store = getStore();
  const fused = new Map<string, { score: number; doc?: Document }>();
  const take = (id: string) => { let e = fused.get(id); if (!e) { e = { score: 0 }; fused.set(id, e); } return e; };

  for (const keyword of keywordsOf(question)) {
    const found = (await store.documents.listFor(userId, { q: keyword, limit: allowed ? PER_KEYWORD_SHARED : PER_KEYWORD, offset: 0 })).filter(d => !allowed || allowed.has(d.id));
    found.forEach((doc, rank) => { const e = take(doc.id); e.score += 1 / (K + rank); e.doc = doc; });
  }
  const meaning = await searchByMeaning(userId, question, 40).catch(err => {
    logger.warn('search by meaning failed', { error: describeError(err) });
    return [];
  });
  meaning.filter(s => !allowed || allowed.has(s.id)).forEach((s, rank) => { take(s.id).score += 1 / (K + rank); });

  const out: Document[] = [];
  for (const [id, e] of [...fused.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, k)) {
    const doc = e.doc ?? await store.documents.findFor(userId, id);
    if (doc) out.push(doc);
  }
  return out;
}

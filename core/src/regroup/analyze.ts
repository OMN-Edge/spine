import { clusterPages, meanSimilarity, readingOrder } from './cluster.js';
import { featuresOf, MIN_TEXT, similarityMatrix, type PageFeatures } from './features.js';
import type { GroupingJudgement, GroupingPage } from '../llm/types.js';

/**
 * Which pages belong together, for an upload whose pages came out mixed (a bulk export). Three steps, none of which changes anything:
 *
 *  1. **Signals, no model**: words, reference numbers, dates, "page 2 of 4" markers, and embeddings where they are on, make a
 *     similarity for every pair of pages (`features.ts`), and average-linkage clustering proposes groups (`cluster.ts`), generously.
 *  2. **A model validates every group**: do these pages form one coherent document? If not, how do they divide? Its answer replaces
 *     the clustering's wherever they differ, so the clustering only has to find candidates, not be right.
 *  3. **Left-over pages are offered to the nearest group**, and the model is asked whether the page belongs.
 *
 * What comes out is a plan: groups of pages, each with how sure the model was and one sentence on why. It is proposed to the owner
 * (`chat/actions.ts`) and applied only on their Confirm (`ingestion/regroup.ts`).
 */
export type Judge = (pages: GroupingPage[]) => Promise<GroupingJudgement | null>;

export interface PlanGroup {
  /** In reading order. */
  page_ids: string[];
  page_numbers: number[];
  /** `validated`: the model said they hold together. `uncertain`: it said so without conviction. `unchecked`: no verdict (the budget ran out, or the answer was unusable). */
  status: 'validated' | 'uncertain' | 'unchecked';
  confidence: number;
  title: string | null;
  reason: string;
  /** The documents these pages are in now. */
  from_documents: string[];
}

export interface RegroupPlan {
  created_at: string;
  pages_considered: number;
  /** Pages with too little text to place: left where they are. */
  pages_unreadable: number;
  /** Groups that would change something. A group the upload already has is not listed. */
  groups: PlanGroup[];
  unchanged_groups: number;
  model_calls: number;
  embeddings: boolean;
}

export const CLUSTER_THRESHOLD = 0.3;
export const MAX_GROUP = 8;
export const ATTACH_THRESHOLD = 0.18;
export const MAX_CALLS = 60;
const CONCURRENCY = 4;
const CONFIDENT = 0.6;

export interface GroupOptions {
  threshold?: number;
  maxGroup?: number;
  maxCalls?: number;
  /** How much text of one page the model is shown. */
  pageChars?: number;
  progress?: (done: number, total: number) => void;
}

interface Settled { pages: number[]; status: PlanGroup['status']; confidence: number; title: string | null; reason: string }

const label = (f: PageFeatures) => `P${f.number}`;

/** Runs `work` over `items` at most `limit` at a time, keeping their order. */
async function pool<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const at = next++; out[at] = await work(items[at]); }
  }));
  return out;
}

/** The groups of pages the evidence and the model agree on. Pure but for the judge it is given. */
export async function groupPages(features: PageFeatures[], sim: number[][], judge: Judge, options: GroupOptions = {}): Promise<{ groups: Settled[]; calls: number }> {
  const maxGroup = options.maxGroup ?? MAX_GROUP;
  const pageChars = options.pageChars ?? 1400;
  let calls = 0;
  const budget = options.maxCalls ?? MAX_CALLS;

  const ask = async (indices: number[]): Promise<GroupingJudgement | null> => {
    if (calls >= budget) return null;
    calls++;
    const pages = indices.map(i => ({ id: label(features[i]), text: features[i].text.slice(0, pageChars) }));
    try { return await judge(pages); } catch { return null; }
  };
  const byLabel = new Map(features.map((f, i) => [label(f), i]));
  const toIndices = (labels: string[]) => labels.map(l => byLabel.get(l)).filter((i): i is number => i !== undefined);

  const candidates = clusterPages(sim, options.threshold ?? CLUSTER_THRESHOLD, maxGroup);
  const multi = candidates.filter(c => c.length >= 2);
  let done = 0;
  const verdicts = await pool(multi, CONCURRENCY, async cluster => {
    const verdict = await ask(cluster);
    options.progress?.(++done, multi.length);
    return { cluster, verdict };
  });

  const settled: Settled[] = [];
  const alone = new Set<number>(candidates.filter(c => c.length === 1).map(c => c[0]));
  for (const { cluster, verdict } of verdicts) {
    if (!verdict) { settled.push({ pages: readingOrder(cluster, features), status: 'unchecked', confidence: 0, title: null, reason: '' }); continue; }
    if (verdict.coherent) {
      const order = toIndices(verdict.order);
      settled.push({
        pages: order.length === cluster.length ? order : readingOrder(cluster, features),
        status: verdict.confidence >= CONFIDENT ? 'validated' : 'uncertain', confidence: verdict.confidence, title: verdict.title, reason: verdict.reason,
      });
      continue;
    }
    // The model divided them: its division replaces the clustering's. Each part with several pages is its own group.
    for (const part of verdict.groups.map(toIndices)) {
      if (part.length >= 2) settled.push({ pages: readingOrder(part, features), status: 'validated', confidence: verdict.confidence, title: null, reason: verdict.reason });
      else for (const i of part) alone.add(i);
    }
  }

  // A page left alone is offered to the group it resembles most, and the model says whether it belongs.
  for (const page of [...alone].sort((a, b) => a - b)) {
    const ranked = settled
      .map((g, at) => ({ at, mean: meanSimilarity(sim, page, g.pages) }))
      .filter(r => r.mean >= ATTACH_THRESHOLD && settled[r.at].pages.length < maxGroup && settled[r.at].status !== 'unchecked')
      .sort((a, b) => b.mean - a.mean);
    if (ranked.length === 0) continue;
    const target = settled[ranked[0].at];
    const verdict = await ask([...target.pages, page]);
    if (verdict?.coherent && verdict.confidence >= CONFIDENT) {
      const order = toIndices(verdict.order);
      target.pages = order.length === target.pages.length + 1 ? order : readingOrder([...target.pages, page], features);
      target.confidence = Math.min(target.confidence, verdict.confidence);
      alone.delete(page);
    }
  }
  return { groups: settled, calls };
}

export interface CurrentDocument { id: string; page_ids: string[] }

/**
 * The plan for an upload: the pages, the documents they are in, a judge and (optionally) their embeddings. Groups the upload
 * already has are counted and left out, so what is proposed is only what would change.
 */
export async function planRegrouping(
  pages: Array<{ id: string; page_number: number; raw_text: string | null; hidden?: boolean | number }>,
  documents: CurrentDocument[],
  judge: Judge,
  embeddings: ((texts: string[]) => Promise<Float32Array[]>) | null,
  options: GroupOptions = {},
): Promise<RegroupPlan> {
  const readable = pages.filter(p => !p.hidden && (p.raw_text ?? '').trim().length >= MIN_TEXT);
  const features = readable.map(featuresOf);
  const empty: RegroupPlan = { created_at: new Date().toISOString(), pages_considered: readable.length, pages_unreadable: pages.length - readable.length, groups: [], unchanged_groups: 0, model_calls: 0, embeddings: false };
  if (features.length < 2) return empty;

  let vectors: Float32Array[] | null = null;
  if (embeddings) {
    try { vectors = await embeddings(features.map(f => f.text.slice(0, 2000))); } catch { vectors = null; }
  }
  const sim = similarityMatrix(features, { embeddings: vectors });
  const { groups, calls } = await groupPages(features, sim, judge, options);

  const docOf = new Map<string, string>();
  for (const d of documents) for (const id of d.page_ids) docOf.set(id, d.id);
  const readableIds = new Set(features.map(f => f.id));
  let unchanged = 0;
  const changed: PlanGroup[] = [];
  for (const g of groups) {
    const ids = g.pages.map(i => features[i].id);
    const from = [...new Set(ids.map(id => docOf.get(id)).filter((d): d is string => !!d))];
    // A group that is exactly the readable pages of one document is what the upload already has.
    const same = from.length === 1 && (() => {
      const doc = documents.find(d => d.id === from[0])!;
      const docReadable = doc.page_ids.filter(id => readableIds.has(id));
      return docReadable.length === ids.length && docReadable.every(id => ids.includes(id));
    })();
    if (same) { unchanged++; continue; }
    changed.push({ page_ids: ids, page_numbers: g.pages.map(i => features[i].number), status: g.status, confidence: Math.round(g.confidence * 100) / 100, title: g.title, reason: g.reason, from_documents: from });
  }
  changed.sort((a, b) => Math.min(...a.page_numbers) - Math.min(...b.page_numbers));
  return { ...empty, groups: changed, unchanged_groups: unchanged, model_calls: calls, embeddings: vectors !== null };
}

/**
 * A quick look, with no model and nothing sent anywhere, at whether an upload's documents seem to have been cut from mixed pages:
 * pages that read alike (a candidate group by the signals alone) but sit in different documents. It decides nothing; it only lets the app
 * say "this may be worth checking" without anyone having to ask, and the real answer is the model-validated analysis.
 */
export function looksMixed(
  pages: Array<{ id: string; page_number: number; raw_text: string | null; hidden?: boolean | number }>,
  documents: CurrentDocument[],
): { mixed: boolean; spanning_groups: number } {
  const readable = pages.filter(p => !p.hidden && (p.raw_text ?? '').trim().length >= MIN_TEXT);
  if (readable.length < 3 || documents.length < 2) return { mixed: false, spanning_groups: 0 };
  const features = readable.map(featuresOf);
  const clusters = clusterPages(similarityMatrix(features), CLUSTER_THRESHOLD, MAX_GROUP);
  const docOf = new Map<string, string>();
  for (const d of documents) for (const id of d.page_ids) docOf.set(id, d.id);
  const spanning = clusters.filter(c => c.length >= 2 && new Set(c.map(i => docOf.get(features[i].id))).size > 1).length;
  return { mixed: spanning > 0, spanning_groups: spanning };
}

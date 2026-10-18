/**
 * What can be told about a page from its text alone, with no model: its words (weighted by how few pages share them), the
 * reference numbers and dates printed on it, and a "page 2 of 4" marker if it has one. From these `similarityMatrix` says how likely
 * two pages are to belong to one document. Nothing here leaves the host and nothing is stored: it is computed for one analysis.
 *
 * The weights and thresholds are first guesses, written before any real export was run through them; the analysis logs how the
 * similarities fall so they can be tuned, and the model validates every group before anything is proposed.
 */
export interface PageInput { id: string; page_number: number; raw_text: string | null }

export interface PageFeatures {
  id: string;
  number: number;
  text: string;
  /** Word weights (sublinear term frequency), before the inverse document frequency is applied. */
  terms: Map<string, number>;
  /** Reference-number-like tokens: an accession, a case or a report number. */
  refs: Set<string>;
  /** Dates printed on the page, as YYYY-MM-DD. */
  dates: Set<string>;
  /** "Page 2 of 4": which page of how many, if the page says. */
  marker: { index: number; total: number } | null;
}

/** A page with less text than this cannot be placed by its words; it stays where it is. */
export const MIN_TEXT = 40;

const stripAccents = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '');

const DATE = /\b(\d{1,2})[./-](\d{1,2})[./-](\d{4})\b|\b(\d{4})-(\d{2})-(\d{2})\b/g;
const pad = (n: string) => n.padStart(2, '0');

export function datesIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(DATE)) {
    const iso = m[4] ? `${m[4]}-${m[5]}-${m[6]}` : `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
    // A real day: 31.02 and 99.99 are numbers that look like a date.
    const parsed = new Date(`${iso}T00:00:00Z`);
    if (!Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === iso) out.add(iso);
  }
  return out;
}

/** Tokens that look like a reference number: they mix letters and digits, or are a long run of digits. Dates are taken out first. */
export function refsIn(text: string): Set<string> {
  const out = new Set<string>();
  const bare = text.replace(DATE, ' ');
  for (const m of bare.matchAll(/\b[A-Za-z0-9][A-Za-z0-9/-]{5,24}\b/g)) {
    const token = m[0].toUpperCase();
    const digits = (token.match(/\d/g) ?? []).length;
    const letters = (token.match(/[A-Z]/g) ?? []).length;
    if (digits >= 4 && (letters > 0 || digits >= 7)) out.add(token);
  }
  return out;
}

const MARKER = /\b(?:pagina|page|pag|seite|p)\.?\s*(\d{1,3})\s*(?:din|of|\/|de|von|sur)\s*(\d{1,3})\b/i;

export function markerIn(text: string): PageFeatures['marker'] {
  const m = MARKER.exec(stripAccents(text));
  if (!m) return null;
  const index = Number(m[1]); const total = Number(m[2]);
  return index >= 1 && index <= total && total <= 200 ? { index, total } : null;
}

export function termsIn(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const word of stripAccents(text).toLowerCase().split(/[^a-z0-9]+/)) {
    // A one- or two-letter word says nothing; a number of two or more digits is worth keeping (a value, a year).
    if (word.length < 3 && !/^\d{2}$/.test(word)) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return new Map([...counts].map(([w, c]) => [w, 1 + Math.log(c)]));
}

export function featuresOf(page: PageInput): PageFeatures {
  const text = (page.raw_text ?? '').trim();
  return { id: page.id, number: page.page_number, text, terms: termsIn(text), refs: refsIn(text), dates: datesIn(text), marker: markerIn(text) };
}

/** Cosine of two unit vectors (or any vectors of one length). */
export function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

export interface SimilarityOptions {
  /** One unit vector per page, in the same order, when embeddings are on. */
  embeddings?: Float32Array[] | null;
}

/**
 * How alike each pair of pages is, 0 to 1 (or below 0 for a pair that cannot be one document). The words count most (rare words
 * more), embeddings add meaning where they are on, and printed evidence moves it: a reference number only a few pages carry, a
 * date in common, page markers that fit (the same total, different numbers) or clash (the same number twice, or different totals).
 */
export function similarityMatrix(features: PageFeatures[], options: SimilarityOptions = {}): number[][] {
  const n = features.length;
  const df = new Map<string, number>();
  for (const f of features) for (const t of f.terms.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const idf = (t: string) => Math.log(1 + n / (df.get(t) ?? 1));
  const vectors = features.map(f => {
    const v = new Map<string, number>();
    let norm = 0;
    for (const [t, w] of f.terms) { const x = w * idf(t); v.set(t, x); norm += x * x; }
    return { v, norm: Math.sqrt(norm) || 1 };
  });
  const refPages = new Map<string, number>();
  for (const f of features) for (const r of f.refs) refPages.set(r, (refPages.get(r) ?? 0) + 1);

  const sim = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    sim[i][i] = 1;
    for (let j = i + 1; j < n; j++) {
      let cos = 0;
      const [small, large] = vectors[i].v.size <= vectors[j].v.size ? [vectors[i], vectors[j]] : [vectors[j], vectors[i]];
      for (const [t, x] of small.v) { const y = large.v.get(t); if (y) cos += x * y; }
      cos /= vectors[i].norm * vectors[j].norm;
      // Words alone run low between two pages of one document (a table and a signature page share little); scale them up.
      let s = Math.min(1, cos * 1.6);
      if (options.embeddings) s = 0.45 * s + 0.55 * Math.max(0, dot(options.embeddings[i], options.embeddings[j]));

      const a = features[i]; const b = features[j];
      // A reference number carried by only a few pages ties them together; one on every page is a letterhead.
      const sharedRefs = [...a.refs].filter(r => b.refs.has(r) && (refPages.get(r) ?? 0) <= 4).length;
      if (sharedRefs > 0) s += Math.min(0.35, 0.25 + 0.05 * (sharedRefs - 1));
      if ([...a.dates].some(d => b.dates.has(d))) s += 0.08;
      if (a.marker && b.marker) {
        if (a.marker.total !== b.marker.total) s -= 0.15;
        else if (a.marker.index === b.marker.index) s = -1; // the same page number of the same document twice: two documents
        else s += 0.2;
      }
      sim[i][j] = sim[j][i] = Math.max(-1, Math.min(1, s));
    }
  }
  return sim;
}

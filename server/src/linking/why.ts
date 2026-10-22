/**
 * Why two documents are suggested as connected (FR-ORG-07, FR-ORG-08): the signals the data gave, written by code. A model
 * judges whether two documents are connected, but never writes the explanation; what is shown is what was measured, and it
 * states no clinical inference. Stored as JSON in `document_links.reason`; anything that is not this shape (an older free-text
 * reason) reads as no reason at all.
 */
export interface LinkWhy {
  /** Tests (canonical names) both have results for. */
  tests?: string[];
  /** Doctors who appear on both. */
  doctors?: string[];
  tags?: string[];
  /** Both come from the same provider (facility). */
  same_provider?: true;
  /** Days between the two documents' dates, when both have one. */
  days_apart?: number;
  /** How close in meaning the two summaries are, 0 to 1, when meaning search is on. */
  similarity?: number;
}

const MAX_LIST = 5;
const cut = (names: string[]) => names.slice(0, MAX_LIST).map(n => n.slice(0, 80));

export function buildWhy(signal: { shared_tests: string[]; shared_doctors: string[]; shared_tags: string[]; same_provider: boolean } | undefined, extra: { daysApart: number | null; similarity: number | null }): LinkWhy | null {
  const why: LinkWhy = {};
  if (signal?.shared_tests.length) why.tests = cut(signal.shared_tests);
  if (signal?.shared_doctors.length) why.doctors = cut(signal.shared_doctors);
  if (signal?.shared_tags.length) why.tags = cut(signal.shared_tags);
  if (signal?.same_provider) why.same_provider = true;
  if (extra.daysApart !== null) why.days_apart = Math.round(extra.daysApart);
  if (extra.similarity !== null) why.similarity = Math.round(extra.similarity * 100) / 100;
  return Object.keys(why).length > 0 ? why : null;
}

export const serializeWhy = (why: LinkWhy | null): string | null => (why ? JSON.stringify(why) : null);

const strings = (v: unknown): string[] | undefined => (Array.isArray(v) && v.every(x => typeof x === 'string') && v.length > 0 ? v.slice(0, MAX_LIST).map(x => x.slice(0, 80)) : undefined);

/** Reads what `serializeWhy` wrote; null for nothing, for free text and for anything of another shape. */
export function parseWhy(stored: string | null): LinkWhy | null {
  if (!stored || stored[0] !== '{') return null;
  let raw: unknown;
  try { raw = JSON.parse(stored); } catch { return null; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const why: LinkWhy = {};
  const tests = strings(r.tests); if (tests) why.tests = tests;
  const doctors = strings(r.doctors); if (doctors) why.doctors = doctors;
  const tags = strings(r.tags); if (tags) why.tags = tags;
  if (r.same_provider === true) why.same_provider = true;
  if (typeof r.days_apart === 'number' && Number.isFinite(r.days_apart)) why.days_apart = r.days_apart;
  if (typeof r.similarity === 'number' && r.similarity >= 0 && r.similarity <= 1) why.similarity = r.similarity;
  return Object.keys(why).length > 0 ? why : null;
}

/** The same signals in one plain English line, for the assistant to relay. They are names and numbers, not a conclusion. */
export function whyText(why: LinkWhy | null): string {
  if (!why) return '';
  return [
    why.tests && `results for the same tests (${why.tests.join(', ')})`,
    why.doctors && `the same doctor (${why.doctors.join(', ')})`,
    why.same_provider && 'the same provider',
    why.tags && `the same tags (${why.tags.join(', ')})`,
    why.days_apart !== undefined && `${why.days_apart} days apart`,
    why.similarity !== undefined && `similar wording (score ${why.similarity})`,
  ].filter(Boolean).join('; ');
}

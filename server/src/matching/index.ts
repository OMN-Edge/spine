import { getStore } from '../store/index.js';
import { doctorSuggestion, nameSuggestion, type Reason, type Suggestion } from './similar.js';

/**
 * What reading an upload introduced that may be the same as something the archive already has, put to the owner as questions. An entry
 * is "new" if this upload made it (a doctor made while it was read; a test, tag or provider that no other document carries), and
 * is compared with everything else. Questions the owner already answered "different" are not asked again, and a pair that has been merged
 * is gone from the lists, so the questions shown are always the ones still open. Nothing here changes anything: the answers do, through
 * the ordinary merge routes, when the owner gives them.
 */
export type MatchKind = 'doctor' | 'test' | 'tag' | 'provider' | 'code';

export interface MatchEntry {
  name: string;
  /** What helps decide: specialty, clinic and code for a doctor; the units for a test. */
  detail: string | null;
  count: number;
  /** What the merge route needs. */
  doctor_id?: string;
  tag_id?: number;
  canonical?: string;
  /** Distinct units the values of a test carry. */
  units?: string[];
}

export interface MatchQuestion {
  id: string;
  kind: MatchKind;
  /** What this upload brought, and what the archive already had. For a code clash: the doctor (new) and nothing. */
  new: MatchEntry;
  existing: MatchEntry | null;
  /** Which of the two survives a merge: the fuller doctor name, otherwise the one the archive already had. */
  keep: 'new' | 'existing';
  reason: Reason | 'different_code';
  strength: 'likely' | 'unsure' | 'clash';
  /** For a code clash: the code in the directory and the one the document printed. */
  codes?: { directory: string; printed: string; documents: number };
  /** Tests whose values carry different units are shown with a warning: merging them would mix the values. */
  unit_mismatch?: boolean;
}

const MAX_QUESTIONS = 12;
export const pairKey = (a: string, b: string) => [a, b].sort().join('|');

export async function openQuestions(userId: string, sourceFileId: string): Promise<MatchQuestion[]> {
  const store = getStore();
  const file = await store.sourceFiles.findFor(userId, sourceFileId);
  if (!file) return [];
  const docs = await store.documents.listFor(userId, { sourceFileId, includeUnconfirmed: true, limit: 1000, offset: 0 });
  const out: MatchQuestion[] = [];

  // --- doctors -----------------------------------------------------------------------------------------------------------------
  const decidedDoctors = await store.matchDecisions.list(userId, 'doctor');
  const directory = await store.doctors.listFor(userId);
  const linked = new Set<string>();
  for (const d of docs) for (const doctor of await store.doctors.forDocument(userId, d.id)) if (doctor.created_at >= file.uploaded_at) linked.add(doctor.id);
  const detailOf = (d: { specialty: string | null; clinic: string | null; license_code: string | null }) => [d.specialty, d.clinic, d.license_code && `code ${d.license_code}`].filter(Boolean).join(' · ') || null;
  const doctorEntry = (d: (typeof directory)[number]): MatchEntry => ({ name: d.name, detail: detailOf(d), count: d.document_count, doctor_id: d.id });
  const seenPairs = new Set<string>();
  for (const fresh of directory.filter(d => linked.has(d.id))) {
    for (const other of directory) {
      if (other.id === fresh.id) continue;
      const key = pairKey(fresh.id, other.id);
      if (seenPairs.has(key) || decidedDoctors.has(key)) continue;
      const suggestion = doctorSuggestion(fresh, other);
      if (!suggestion) continue;
      seenPairs.add(key);
      // The fuller name survives; when they are as full, the one with more documents.
      const words = (n: string) => n.split(/\s+/).length;
      const keepNew = words(fresh.name) !== words(other.name) ? words(fresh.name) > words(other.name) : fresh.document_count > other.document_count;
      out.push({ id: `doctor:${key}`, kind: 'doctor', new: doctorEntry(fresh), existing: doctorEntry(other), keep: keepNew ? 'new' : 'existing', reason: suggestion.reason, strength: suggestion.strength });
    }
  }

  // --- a code the document printed that is not the directory's ----------------------------------------------------------------
  const decidedCodes = await store.matchDecisions.list(userId, 'code');
  for (const c of await store.doctors.codeClashes(userId, docs.map(d => d.id))) {
    const key = `${c.doctor_id}|${c.printed_code}`;
    if (decidedCodes.has(key)) continue;
    const entry = directory.find(d => d.id === c.doctor_id);
    if (!entry) continue;
    out.push({ id: `code:${key}`, kind: 'code', new: doctorEntry(entry), existing: null, keep: 'existing', reason: 'different_code', strength: 'clash', codes: { directory: c.directory_code, printed: c.printed_code, documents: c.document_ids.length } });
  }

  // --- tests -------------------------------------------------------------------------------------------------------------------
  // The archive-wide test list holds back an upload whose grouping is not confirmed, which is exactly when this is asked: so what this
  // upload brought is read from its own documents, and what the archive already had from the list (less this upload, once confirmed).
  const decidedTests = await store.matchDecisions.list(userId, 'test');
  const brought = await testsIntroduced(userId, file, docs);
  const archive = await store.measurements.names(userId);
  const unitsOf = async (canonical: string) => [...new Set((await store.measurements.series(userId, canonical)).map(p => p.unit?.trim()).filter((u): u is string => !!u))].slice(0, 5);
  for (const fresh of brought.introduced) {
    const others = [
      ...archive.filter(t => t.canonical !== fresh.canonical).map(t => ({ canonical: t.canonical, name: t.name, count: t.count, units: null as string[] | null })),
      ...brought.introduced.filter(t => t.canonical !== fresh.canonical).map(t => ({ canonical: t.canonical, name: t.name, count: t.count, units: t.units })),
    ];
    for (const other of others) {
      if (brought.together.get(fresh.canonical)?.has(other.canonical)) continue; // side by side in one document: two tests
      const key = pairKey(fresh.canonical, other.canonical);
      if (seenPairs.has(`t:${key}`) || decidedTests.has(key)) continue;
      const suggestion = nameSuggestion('test', fresh.canonical, other.canonical);
      if (!suggestion) continue;
      seenPairs.add(`t:${key}`);
      const otherUnits = other.units ?? await unitsOf(other.canonical);
      out.push({
        id: `test:${key}`, kind: 'test',
        new: { name: fresh.name, detail: null, count: fresh.count, canonical: fresh.canonical, units: fresh.units },
        existing: { name: other.name, detail: null, count: other.count, canonical: other.canonical, units: otherUnits },
        keep: 'existing', reason: suggestion.reason, strength: suggestion.strength,
        unit_mismatch: fresh.units.length > 0 && otherUnits.length > 0 && !fresh.units.some(u => otherUnits.includes(u)),
      });
    }
  }

  // --- tags --------------------------------------------------------------------------------------------------------------------
  const decidedTags = await store.matchDecisions.list(userId, 'tag');
  const tagCounts = new Map<string, number>();
  for (const d of docs) for (const t of await store.tags.namesForDocument(userId, d.id)) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
  const tags = await store.tags.listWithCounts(userId);
  for (const fresh of tags.filter(t => tagCounts.get(t.name) === t.document_count)) {
    for (const other of tags) {
      if (other.id === fresh.id) continue;
      const key = pairKey(String(fresh.id), String(other.id));
      if (seenPairs.has(`g:${key}`) || decidedTags.has(key)) continue;
      const suggestion = nameSuggestion('tag', fresh.name, other.name);
      if (!suggestion) continue;
      seenPairs.add(`g:${key}`);
      out.push({ id: `tag:${key}`, kind: 'tag', new: { name: fresh.name, detail: null, count: fresh.document_count, tag_id: fresh.id }, existing: { name: other.name, detail: null, count: other.document_count, tag_id: other.id }, keep: 'existing', reason: suggestion.reason, strength: suggestion.strength });
    }
  }

  // --- providers ---------------------------------------------------------------------------------------------------------------
  const decidedProviders = await store.matchDecisions.list(userId, 'provider');
  const providerCounts = new Map<string, number>();
  for (const d of docs) if (d.provider) providerCounts.set(d.provider, (providerCounts.get(d.provider) ?? 0) + 1);
  const providers = await store.documents.providers(userId);
  for (const fresh of providers.filter(p => providerCounts.get(p.name) === p.document_count)) {
    for (const other of providers) {
      if (other.name === fresh.name) continue;
      const key = pairKey(fresh.name.toLowerCase(), other.name.toLowerCase());
      if (seenPairs.has(`p:${key}`) || decidedProviders.has(key)) continue;
      const suggestion = nameSuggestion('provider', fresh.name, other.name);
      if (!suggestion) continue;
      seenPairs.add(`p:${key}`);
      out.push({ id: `provider:${key}`, kind: 'provider', new: { name: fresh.name, detail: null, count: fresh.document_count }, existing: { name: other.name, detail: null, count: other.document_count }, keep: 'existing', reason: suggestion.reason, strength: suggestion.strength });
    }
  }

  // Clashes first, then what is likely, then what is not sure.
  const rank = { clash: 0, likely: 1, unsure: 2 } as const;
  return out.sort((a, b) => rank[a.strength] - rank[b.strength]).slice(0, MAX_QUESTIONS);
}

export type { Reason, Suggestion };

/**
 * The tests an upload brought that no other document has, and which tests sit side by side in one of its documents. Worked out from
 * the upload's own documents; the archive-wide list only says whether another document has the test.
 */
export async function testsIntroduced(userId: string, file: { grouping_confirmed: boolean }, docs: Array<{ id: string }>) {
  const store = getStore();
  const here = new Map<string, { name: string; count: number; units: Set<string> }>();
  const together = new Map<string, Set<string>>();
  for (const d of docs) {
    const inDocument = new Set<string>();
    for (const m of await store.measurements.listForDocument(userId, d.id)) {
      const held = here.get(m.canonical) ?? { name: m.name, count: 0, units: new Set<string>() };
      held.count++;
      if (m.unit?.trim()) held.units.add(m.unit.trim());
      here.set(m.canonical, held);
      inDocument.add(m.canonical);
    }
    for (const c of inDocument) together.set(c, new Set([...(together.get(c) ?? []), ...inDocument]));
  }
  const archive = new Map((await store.measurements.names(userId)).map(t => [t.canonical, t.count]));
  const introduced = [...here]
    // The list counts every visible value: once the upload is confirmed that includes its own.
    .filter(([canonical, h]) => (archive.get(canonical) ?? 0) - (file.grouping_confirmed ? h.count : 0) <= 0)
    .map(([canonical, h]) => ({ canonical, name: h.name, count: h.count, units: [...h.units].slice(0, 5) }));
  return { introduced, together };
}

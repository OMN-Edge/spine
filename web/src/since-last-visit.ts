/**
 * Before a visit (T-28): what this doctor last saw of the person, and what has come from others since. The last visit is the date of the newest document that names the doctor;
 * "from others" is every other document dated after it, so it is what the doctor has not seen, newest first. The owner can send exactly those with one tap.
 */
export interface Dated { id: string; doc_date: string | null; doc_type?: string | null }

/** What any doctor wants to see whoever wrote it: results, images, a discharge, a vaccination, a prescription. A consultation with someone else, a receipt or "other" is behind a toggle. */
export const FOR_ANY_DOCTOR: ReadonlySet<string> = new Set(['lab_result', 'imaging', 'discharge_note', 'vaccination', 'prescription']);

export function lastVisit(own: Dated[]): string | null {
  const dates = own.map(d => d.doc_date).filter((d): d is string => !!d).sort();
  return dates.at(-1) ?? null;
}

export function sinceLastVisit<T extends Dated>(own: Dated[], all: T[]): { since: string | null; documents: T[]; other: T[] } {
  const since = lastVisit(own);
  if (!since) return { since: null, documents: [], other: [] };
  const mine = new Set(own.map(d => d.id));
  const newer = all.filter(d => !mine.has(d.id) && !!d.doc_date && d.doc_date > since).sort((a, b) => (b.doc_date ?? '').localeCompare(a.doc_date ?? ''));
  const wanted = (d: T) => !!d.doc_type && FOR_ANY_DOCTOR.has(d.doc_type);
  return { since, documents: newer.filter(wanted), other: newer.filter(d => !wanted(d)) };
}

/**
 * Before a visit (T-28): what this doctor last saw of the person, and what has come from others since. The last visit is the date of the newest document that names the doctor;
 * "from others" is every other document dated after it, so it is what the doctor has not seen, newest first. The owner can send exactly those with one tap.
 */
export interface Dated { id: string; doc_date: string | null }

export function lastVisit(own: Dated[]): string | null {
  const dates = own.map(d => d.doc_date).filter((d): d is string => !!d).sort();
  return dates.at(-1) ?? null;
}

export function sinceLastVisit<T extends Dated>(own: Dated[], all: T[]): { since: string | null; documents: T[] } {
  const since = lastVisit(own);
  if (!since) return { since: null, documents: [] };
  const mine = new Set(own.map(d => d.id));
  return { since, documents: all.filter(d => !mine.has(d.id) && !!d.doc_date && d.doc_date > since).sort((a, b) => (b.doc_date ?? '').localeCompare(a.doc_date ?? '')) };
}

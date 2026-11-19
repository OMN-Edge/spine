import type { Document, Episode, ExtractedField } from './api';

/**
 * What the emergency card could start from, found in the person's own records and offered, never filled in (T-20): the medicines on prescriptions of the last twelve months, and the names the
 * owner gave to confirmed episodes. Each is a line the owner reads, ticks and may change; nothing reaches the card unless they add it. A medicine is a prescription line's drug, dose and
 * frequency as written, newest first, once.
 */
export const MONTHS = 12;

export interface Proposals { medications: string[]; conditions: string[] }

const norm = (text: string): string => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

/** The lines a prescription holds: one per group of drug, dose and frequency. */
export function prescriptionLines(fields: Array<Pick<ExtractedField, 'label' | 'value' | 'group_no'>>): string[] {
  const groups = new Map<number, Record<string, string>>();
  for (const f of fields) {
    if (f.group_no === null || f.group_no === undefined) continue;
    groups.set(f.group_no, { ...(groups.get(f.group_no) ?? {}), [f.label]: f.value });
  }
  return [...groups.values()]
    .filter(g => g.drug)
    .map(g => [g.drug, [g.dose, g.frequency].filter(Boolean).join(', ')].filter(Boolean).join(' '));
}

export function proposalsFrom(
  prescriptions: Array<Pick<Document, 'doc_date'> & { fields?: Array<Pick<ExtractedField, 'label' | 'value' | 'group_no'>> }>,
  episodes: Array<Pick<Episode, 'title'>>,
  already: { medications: string[]; conditions: string[] },
  now: Date = new Date(),
): Proposals {
  const cutoff = new Date(now.getTime());
  cutoff.setMonth(cutoff.getMonth() - MONTHS);
  const have = (list: string[]) => new Set(list.map(norm));
  const takenMeds = have(already.medications);
  const takenConditions = have(already.conditions);
  const medications: string[] = [];
  const seen = new Set<string>();
  for (const doc of [...prescriptions].sort((a, b) => (b.doc_date ?? '').localeCompare(a.doc_date ?? ''))) {
    if (!doc.doc_date || new Date(doc.doc_date) < cutoff) continue;
    for (const line of prescriptionLines(doc.fields ?? [])) {
      const key = norm(line.split(' ')[0] ?? line);
      if (seen.has(key) || takenMeds.has(norm(line))) continue;
      seen.add(key);
      medications.push(line);
    }
  }
  const conditions = [...new Set(episodes.map(e => e.title?.trim()).filter((title): title is string => !!title))].filter(title => !takenConditions.has(norm(title)));
  return { medications, conditions };
}

export const BLOOD_TYPES = ['A+', 'A−', 'B+', 'B−', 'AB+', 'AB−', '0+', '0−'] as const;

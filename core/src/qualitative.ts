/**
 * Values that are words, not numbers: the susceptibility of an antibiogram (sensitive, intermediate, resistant) and the plain results of a test (positive, negative, absent, present). A lab prints
 * them in its own language, and a reader in another sees "Sensibil" in the middle of an English page; a small fixed map, not a model, says which word each is. The words are written without
 * accents and in lower case, since that is how they are looked up. Anything not in the map is not a qualitative value here and is shown as printed.
 */
export const QUALITATIVE = ['sensitive', 'intermediate', 'resistant', 'positive', 'negative', 'absent', 'present'] as const;
export type Qualitative = (typeof QUALITATIVE)[number];

const WORDS: Record<Qualitative, string[]> = {
  sensitive: ['sensibil', 'sensibila', 'sensitive', 'susceptible', 'sensible', 'empfindlich', 'sensibel'],
  intermediate: ['intermediar', 'intermediara', 'intermediate', 'intermediaire', 'intermediar', 'intermediaer'],
  resistant: ['rezistent', 'rezistenta', 'resistant', 'resistante', 'resistent'],
  positive: ['pozitiv', 'pozitiva', 'positive', 'positif', 'positiv'],
  negative: ['negativ', 'negativa', 'negative', 'negatif'],
  absent: ['absent', 'absenta', 'absente', 'abwesend'],
  present: ['prezent', 'prezenta', 'present', 'presente', 'vorhanden'],
};

const fold = (text: string): string => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim().replace(/\.$/, '');
const LOOKUP = new Map<string, Qualitative>(QUALITATIVE.flatMap(key => WORDS[key].map(word => [word, key] as const)));

/** Which qualitative value a printed word is, in any of the four languages, or null. */
export function qualitativeOf(text: string | null | undefined): Qualitative | null {
  return text ? LOOKUP.get(fold(text)) ?? null : null;
}

/** The three that make an antibiogram's result: a test whose values are these is a susceptibility test, not a trend. */
export const isSusceptibility = (key: Qualitative | null): boolean => key === 'sensitive' || key === 'intermediate' || key === 'resistant';

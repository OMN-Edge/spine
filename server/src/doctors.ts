/**
 * Who a doctor is, across documents. The same person is written "Dr. Popescu Ion", "Popescu Ion",
 * "Ion Popescu" and "POPESCU ION" on different documents, and the directory should hold one entry.
 */

export const TITLES = new Set([
  'dr', 'doctor', 'prof', 'profesor', 'conf', 'asist', 'sef', 'medic', 'primar', 'specialist',
  'dna', 'dl', 'md', 'phd', 'univ', 'lector', 'rezident', 'dr.',
]);

const stripAccents = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '');

/**
 * The name with titles, accents, case, punctuation and word order removed. Two names with the same key are
 * the same doctor. Initials are kept ("popescu i" is not "popescu ion": that needs a person to say so),
 * which is what merging two directory entries is for.
 */
export function doctorKey(name: string): string {
  const tokens = stripAccents(name)
    .toLowerCase()
    // A hyphen is a space: "Ioana-Maria" and "Ioana Maria" are one given name written two ways.
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(token => token && !TITLES.has(token));
  return tokens.sort().join(' ');
}

/** The name as it will be shown: as printed, without leading titles and stray punctuation. */
export function doctorDisplayName(name: string): string {
  // "Dr.DUMITRESCU": a title with a full stop and no space after it.
  const glued = new RegExp(`^(?:${[...TITLES].filter(t => !t.endsWith('.')).join('|')})\\.\\s*(?=\\S)`, 'i');
  let rest = name.trim();
  while (glued.test(rest)) rest = rest.replace(glued, ''); // "Prof.Dr.Ion": more than one
  let words = rest.replace(/\s+/g, ' ').split(' ');
  while (words.length > 1 && TITLES.has(stripAccents(words[0]).toLowerCase().replace(/[^a-z]/g, ''))) words = words.slice(1);
  return words.join(' ').replace(/^[,;:\s]+|[,;:\s]+$/g, '') || name.trim();
}

/**
 * A professional code as it is stored: upper case, letters and digits only ("Cod. X-12345" is "X12345").
 * Null for anything too short to identify a person, so a stray "1" is not a match for everyone.
 */
export function normaliseLicenseCode(code: string | null | undefined): string | null {
  // "Cod. X12345", "Cod parafa X12345": the label is not part of the code.
  const cleaned = (code ?? '').toUpperCase().replace(/^\s*COD(UL)?(\s+PARAF[AĂ])?\b\.?:?/, '').replace(/[^A-Z0-9]/g, '');
  return cleaned.length >= 4 ? cleaned : null;
}

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
/** What a doctor's fields may hold. They come from documents anyone can send you, so none is unbounded. */
export const MAX_DOCTOR_TEXT = 120;
export const MAX_CODE_LENGTH = 24;

export function normaliseLicenseCode(code: string | null | undefined): string | null {
  // "Cod. X12345", "Cod parafa X12345": the label is not part of the code.
  const cleaned = (code ?? '').toUpperCase().replace(/^\s*COD(UL)?(\s+PARAF[AĂ])?\b\.?:?/, '').replace(/[^A-Z0-9]/g, '');
  return cleaned.length >= 4 && cleaned.length <= MAX_CODE_LENGTH ? cleaned : null;
}

export interface DoctorForSuggestion {
  id: string;
  name: string;
  specialty: string | null;
  document_count: number;
}

const norm = (text: string | null | undefined) => (text ?? '').trim().toLowerCase();

/** Whether a word of one name could be the same word in another: equal, or a single letter that starts it. */
const sameWord = (a: string, b: string) => a === b || (a.length === 1 && b.startsWith(a)) || (b.length === 1 && a.startsWith(b));

/**
 * Whether two names could be one person written two ways, by their words (see `doctorKey`). The shorter
 * name's words must each be found in the longer, as the same word or as an initial of it, with at least
 * one whole word in common and at least two words in the shorter, so a bare "Ana" is never a match. This
 * only *suggests*: it cannot know "Popescu Ana" and "Popescu Ana Maria" are one person, which is why the
 * owner confirms, and why two names are never merged on this basis automatically.
 */
export function couldBeSamePerson(a: string, b: string): boolean {
  const [short, long] = [doctorKey(a).split(' ').filter(Boolean), doctorKey(b).split(' ').filter(Boolean)]
    .sort((x, y) => x.length - y.length);
  if (short.length < 2) return false;
  const free = [...long];
  let whole = 0;
  for (const word of short) {
    // An exact word first, so "ion" takes "ion" and not the initial-compatible "i...".
    let at = free.indexOf(word);
    if (at >= 0) whole++;
    else at = free.findIndex(candidate => sameWord(word, candidate));
    if (at < 0) return false;
    free.splice(at, 1);
  }
  return whole >= 1;
}

/**
 * Pairs of directory entries that are probably one person, for the owner to confirm: names that could
 * be the same person, and not two different specialties. `keep` is the fuller name (more words, then more
 * documents); `other` is the one that would be merged into it.
 */
export function suggestDuplicates<T extends DoctorForSuggestion>(doctors: T[]): Array<{ keep: T; other: T }> {
  const out: Array<{ keep: T; other: T }> = [];
  const words = (d: T) => doctorKey(d.name).split(' ').filter(Boolean).length;
  for (let i = 0; i < doctors.length; i++) {
    for (let j = i + 1; j < doctors.length; j++) {
      const a = doctors[i], b = doctors[j];
      if (norm(a.specialty) && norm(b.specialty) && norm(a.specialty) !== norm(b.specialty)) continue;
      if (!couldBeSamePerson(a.name, b.name)) continue;
      const aKeeps = words(a) !== words(b) ? words(a) > words(b) : a.document_count !== b.document_count ? a.document_count > b.document_count : a.id < b.id;
      out.push(aKeeps ? { keep: a, other: b } : { keep: b, other: a });
    }
  }
  return out;
}

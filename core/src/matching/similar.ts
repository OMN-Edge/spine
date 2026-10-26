import { couldBeSamePerson, doctorKey } from '../doctors.js';

/**
 * Could these two be the same thing written two ways? Judged from the names alone, with no model, so it is cheap to run on
 * everything one upload introduced. It only *suggests*: a suggestion is put to the owner as a question, and nothing is merged because
 * of it. What is obvious (the same name once case, accents, titles and word order are ignored; the same professional code; a test
 * name remembered as an alias) was already merged when the upload was read; this is for what is not.
 */
export type Reason = 'initial' | 'fuller_name' | 'punctuation' | 'legal_suffix' | 'contained' | 'spelling' | 'prefix';
export interface Suggestion { reason: Reason; strength: 'likely' | 'unsure' }

const stripAccents = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '');
const words = (text: string) => stripAccents(text).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const squash = (text: string) => words(text).join('');

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    previous = row;
  }
  return previous[b.length];
}

const LEGAL = new Set(['srl', 'sa', 'sc', 'spa', 'sas', 'snc', 'scs', 'llc', 'ltd', 'gmbh', 'ag', 'inc', 'sarl', 'pfa', 'srld', 's', 'r', 'l']);
const withoutLegal = (text: string) => words(text).filter(w => !LEGAL.has(w));

/** A test, a tag or a provider written two ways, or null if nothing suggests it. */
export function nameSuggestion(kind: 'test' | 'tag' | 'provider', a: string, b: string): Suggestion | null {
  const [sa, sb] = [squash(a), squash(b)];
  if (!sa || !sb) return null;
  if (sa === sb) return { reason: 'punctuation', strength: 'likely' };

  if (kind === 'provider') {
    const [wa, wb] = [withoutLegal(a), withoutLegal(b)];
    if (wa.length > 0 && wa.join('') === wb.join('')) return { reason: 'legal_suffix', strength: 'likely' };
    const [short, long] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
    // "Clinica Aurora" in "Clinica Aurora Policlinica Nord": one name inside the other, which may be the same clinic or a branch.
    if (short.length >= 2 && short.every(w => long.includes(w))) return { reason: 'contained', strength: 'unsure' };
  }

  // "Spital A" and "Spital B", "Ward 1" and "Ward 2", "Vitamin B6" and "Vitamin B12": a name told apart by a number or a lone letter is two things.
  const [ra, rb] = [words(a), words(b)];
  if (ra.length === rb.length) {
    const differing = ra.map((w, i) => [w, rb[i]]).filter(([x, y]) => x !== y);
    if (differing.length === 1 && differing[0].every(w => w.length <= 2 || /\d/.test(w))) return null;
  }

  const [short, long] = sa.length <= sb.length ? [sa, sb] : [sb, sa];
  const distance = levenshtein(sa, sb);
  if (short.length >= 6 && distance <= 1) return { reason: 'spelling', strength: 'likely' };
  if (short.length >= 8 && distance <= 2) return { reason: 'spelling', strength: 'unsure' };
  if (short.length >= 4 && long.startsWith(short) && short.length / long.length >= 0.6) return { reason: 'prefix', strength: 'unsure' };
  return null;
}

export interface DoctorLike { name: string; specialty: string | null; clinic: string | null; license_code: string | null }

const same = (a: string | null, b: string | null) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

/** Two directory entries that may be one person. Two different professional codes mean two people, and are never suggested. */
export function doctorSuggestion(a: DoctorLike, b: DoctorLike): Suggestion | null {
  if (a.license_code && b.license_code && a.license_code !== b.license_code) return null;
  if (a.specialty && b.specialty && a.specialty.trim().toLowerCase() !== b.specialty.trim().toLowerCase()) return null;
  if (!couldBeSamePerson(a.name, b.name)) return null;
  const [short, long] = [doctorKey(a.name).split(' '), doctorKey(b.name).split(' ')].sort((x, y) => x.length - y.length);
  const fuller = short.every(w => long.includes(w)) && long.length > short.length;
  const strong = same(a.specialty, b.specialty) || same(a.clinic, b.clinic) || (!!a.license_code && a.license_code === b.license_code);
  return { reason: fuller ? 'fuller_name' : 'initial', strength: strong ? 'likely' : 'unsure' };
}

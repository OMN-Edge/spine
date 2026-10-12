import { TITLES } from './doctors.js';

/**
 * What a person types into search, as a full-text query. Typed text is not query syntax: "dr. popescu",
 * "50 mg" or a stray quote would be a syntax error, and "-" or "OR" would be operators. Every run of
 * letters and digits becomes a quoted word that matches by its start ("lombar" finds "lombară"), and
 * all of them must match. Null when nothing searchable was typed.
 *
 * A title ("Dr.", "Prof.") is left out when other words remain: a doctor is indexed by name alone,
 * so "dr. popescu" must find "Popescu". A search for the title by itself is still a search.
 */
export function ftsQuery(text: string): string | null {
  const all = text.normalize('NFKC').match(/[\p{L}\p{N}]+/gu) ?? [];
  const isTitle = (word: string) => TITLES.has(word.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase());
  const named = all.filter(word => !isTitle(word));
  const words = named.length ? named : all;
  return words.length ? words.map(word => `"${word}"*`).join(' ') : null;
}

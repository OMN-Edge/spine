/**
 * A label for a document that has not been read yet (SECURITY.md M-29), taken from the text of its first page and nothing else: no
 * model, nothing stored, nothing sent. It exists so the grouping screen has something to recognise a group by ("Buletin de analize")
 * while the owner checks the grouping. It is a guess from the first lines and says so on screen; the real title comes with the reading.
 */
const MAX_LINES = 30;
const MAX_LENGTH = 90;

/** Words a document's own title usually has, in the languages the interface speaks; diacritics and case are ignored when matching. */
const TITLE_WORDS = [
  'buletin', 'rezultat', 'raport', 'scrisoare', 'epicriza', 'externare', 'internare', 'bilet', 'fisa', 'fișa', 'consultat', 'retet', 'reteta',
  'certificat', 'adeverint', 'trimitere', 'recomandare', 'ecograf', 'radiograf', 'tomograf', 'rezonant', 'electrocardio', 'ecg', 'analize',
  'investigat', 'interpretare', 'medical', 'vaccin', 'istoric', 'biletul', 'foaie', 'protocol', 'operator',
  'report', 'result', 'letter', 'discharge', 'consultation', 'prescription', 'certificate', 'referral', 'ultrasound', 'x-ray', 'scan', 'laboratory', 'summary',
  'rapport', 'résultat', 'resultat', 'ordonnance', 'certificat', 'compte rendu', 'lettre', 'consultation', 'sortie', 'analyses',
  'bericht', 'befund', 'arztbrief', 'entlassung', 'rezept', 'überweisung', 'ueberweisung', 'laborbefund', 'attest', 'zeugnis',
];

const plain = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const NOISE = [
  /\b(tel|telefon|fax|e-?mail|www|http|iban|cif|cui|cnp|cod\s*fiscal|str\.?|strada|bd\.?|nr\.?\s*\d|jud\.?|sector|adresa|address)\b/i,
  /@|https?:|www\./i,
  /^\W*\d[\d\s./:-]*\W*$/, // a number, a date, a phone number
  /^(pagina|page|seite|p\.)\s*\d+/i,
  /^\d+\s*(\/|din|of|von|sur)\s*\d+$/i,
];

function usable(line: string, allowSingleWord = false): boolean {
  const text = line.trim();
  if (text.length < 4 || text.length > MAX_LENGTH) return false;
  const letters = (text.match(/\p{L}/gu) ?? []).length;
  if (letters < text.replace(/\s/g, '').length * 0.6) return false;
  if (!allowSingleWord && !/\s/.test(text) && text.length < 12) return false; // a lone short word is rarely a title, unless it names a kind of document
  return !NOISE.some(pattern => pattern.test(text));
}

/** Null when the text has no line worth showing. */
export function guessTitle(firstPageText: string | null | undefined): string | null {
  const lines = (firstPageText ?? '').split(/\r?\n/).map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, MAX_LINES);
  if (lines.length === 0) return null;
  const words = TITLE_WORDS.map(plain);
  const titled = lines.find(l => usable(l, true) && words.some(w => plain(l).includes(w)));
  const chosen = titled ?? lines.find(l => usable(l));
  if (!chosen) return null;
  // Printed in capitals, it reads as shouting on screen: "BULETIN DE ANALIZE" becomes "Buletin de analize".
  const letters = chosen.replace(/[^\p{L}]/gu, '');
  const shouting = letters.length > 3 && letters === letters.toUpperCase();
  const text = shouting ? chosen.charAt(0) + chosen.slice(1).toLowerCase() : chosen;
  return text.length > 80 ? `${text.slice(0, 79).trimEnd()}…` : text;
}

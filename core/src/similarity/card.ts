import { sha256Hex } from '../digest.js';
import type { Store } from '../store/index.js';
import type { Document } from '../types.js';

/**
 * What a document is embedded as: a short card of what a person would say about it, not its pages. Titles, type, date,
 * provider, summary, doctors and the fields that say what it is about (diagnoses, reasons, recommendations) and the names
 * of the tests in it, in that order and cut to a fixed length. Short cards are cheaper to embed, say more per word, and
 * leave exact words and codes to full-text search. Built only from the database, so a new embedding model never needs a
 * file.
 *
 * `CARD_VERSION` is part of what is hashed: change how cards are made and every vector is stale, with nothing else to do.
 */
export const CARD_VERSION = 1;
const MAX_CARD = 2400;
const MAX_VALUE = 320;

/** Fields that say what a document is about, in the order they are put on the card. */
const ABOUT = [
  'reason_for_visit', 'diagnosis', 'diagnosis_uncoded', 'symptoms', 'impression', 'findings', 'procedure', 'investigations',
  'recommended_tests', 'recommended_medication', 'current_treatment', 'follow_up', 'drug', 'vaccine', 'modality', 'body_part', 'summary',
];

const clip = (text: string, n: number) => (text.length > n ? `${text.slice(0, n)}…` : text);
const words = (label: string) => label.replace(/_+/g, ' ');

export async function cardOf(store: Store, userId: string, doc: Document): Promise<string> {
  const [fields, measurements, doctors] = await Promise.all([
    store.fields.listForDocument(userId, doc.id),
    store.measurements.listForDocument(userId, doc.id),
    store.doctors.forDocument(userId, doc.id),
  ]);
  const lines: string[] = [];
  const head = [doc.title, doc.doc_type ? words(doc.doc_type) : null, doc.provider, doc.doc_date].filter(Boolean).join(' · ');
  if (head) lines.push(head);
  if (doc.ai_summary) lines.push(clip(doc.ai_summary, 700));
  if (doctors.length > 0) lines.push(doctors.slice(0, 6).map(d => [d.name, d.specialty].filter(Boolean).join(', ')).join('; '));

  const rank = (label: string) => { const i = ABOUT.indexOf(label); return i === -1 ? ABOUT.length : i; };
  const seen = new Set<string>();
  for (const f of [...fields].sort((a, b) => rank(a.label) - rank(b.label))) {
    const line = `${words(f.label)}: ${clip(f.value.replace(/\s+/g, ' ').trim(), MAX_VALUE)}`;
    if (f.value.trim() && !seen.has(line)) { seen.add(line); lines.push(line); }
  }
  const tests = [...new Set(measurements.map(m => m.name))].slice(0, 30);
  if (tests.length > 0) lines.push(`tests: ${tests.join(', ')}`);
  return clip(lines.join('\n'), MAX_CARD);
}

/** The digest a stored vector is checked against: the card, the model's vector space, and how cards are made. */
export const cardHash = (card: string, modelId: string): string =>
  sha256Hex(`${CARD_VERSION}\n${modelId}\n${card}`);

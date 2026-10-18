import { getStore } from '../store/index.js';
import { getChatLlm } from '../llm/index.js';
import { llmContextChars } from '../config.js';
import { logger } from '../logger.js';
import { describeError } from '../failure.js';
import { askAgent, hasAnythingToRead } from './agent.js';
import { cardOf } from '../similarity/card.js';
import { documentsForQuestion } from './retrieval.js';
import { DOCUMENT_SECTIONS, describeScreen, resolveScreen, sectionRecords, type DocumentSection, type ScreenContext } from './screen.js';
import { chainOf } from '../linking/index.js';
import type { ChatRecord, ChatTurn } from '../llm/types.js';
import type { Document, Measurement } from '../types.js';

/**
 * Questions answered from the owner's own records. Retrieval is ours and the model only reads what it is handed:
 *
 *  1. the documents that match the question by its keywords and, where embeddings are on, by meaning (`retrieval.ts`);
 *  2. the documents their care chains connect them to (a consultation brings the tests it asked for);
 *  3. for a test the question names, that test's values over time, with the document each came from.
 *
 * Each document goes as its summary card, the owner's notes and its results with their values; never page text or
 * scans. The whole context is cut to a budget. The model is told to answer only from it, to say when it cannot, and to
 * cite documents by label; labels it invents are dropped. Everything is read through the store as the signed-in user, so
 * only documents that are shown (not set aside, grouping confirmed) are ever sent.
 */
const TOP_HITS = 8;
const CHAIN_SEEDS = 3;
const MAX_DOCS = 12;
const MAX_SERIES = 3;
const SERIES_POINTS = 20;
const SERIES_EXTRA_DOCS = 6;
const MAX_RESULTS_PER_DOC = 40;
const NOTES_MAX = 600;
const SHORT_QUESTION_WORDS = 4;
const SCREEN_LISTED = 8;

export const MAX_QUESTION = 1000;
export const MAX_TURNS = 6;
export const MAX_TURN = 1500;

/** What the agent is doing, for the person waiting: a kind the page words in its own language, and what it concerns. */
export interface ChatStep { kind: 'search' | 'open' | 'series' | 'tests' | 'connections'; detail?: string }

/** Progress of one question, for a caller that streams it. All optional: a caller that waits for the whole reply passes none. */
export interface ChatProgress {
  step?: (step: ChatStep) => void;
  /** A piece of the answer as the model writes it (not yet checked: citations are resolved in the final reply). */
  delta?: (text: string) => void;
  /** What was streamed so far is not the answer after all (the model went on to look something up): clear it. */
  reset?: () => void;
  /** The person went away: stop. */
  signal?: AbortSignal;
}

export interface ChatSource {
  label: string; id: string; title: string | null; doc_type: Document['doc_type']; doc_date: string | null;
  /** The part of the document page the answer came from, when the model cited one. */
  section?: DocumentSection;
}
export interface ChatReply {
  /** Null when nothing in the records matched the question: the model was not asked. */
  answer: string | null;
  sources: ChatSource[];
  /** How many documents were handed to the model. */
  documents: number;
  /** What the agent looked at, in words, so the person can see how the answer was reached. Absent for the fixed pipeline. */
  looked?: string[];
}

/** The conversation as the model gets it: only the last turns, text only, each cut. */
export function trimHistory(history: ChatTurn[]): ChatTurn[] {
  return history.slice(-MAX_TURNS).map(t => ({ role: t.role, content: t.content.slice(0, MAX_TURN) }));
}

const clip = (text: string, n: number) => (text.length > n ? `${text.slice(0, n)}…` : text);

function resultLine(m: Measurement): string {
  const range = m.ref_low !== null && m.ref_high !== null ? ` (reference ${m.ref_low}–${m.ref_high})` : '';
  return `${m.name}${m.canonical && m.canonical !== m.name.toLowerCase() ? ` [${m.canonical}]` : ''}: ${m.value_text}${m.unit ? ` ${m.unit}` : ''}${range}${m.flag ? ` ${m.flag}` : ''}${m.taken_on ? `, ${m.taken_on}` : ''}`;
}

/** The headline alone, for a document that is there only because a result points at it or the budget ran out. */
const headline = (doc: Document): string =>
  [doc.title, doc.doc_type?.replace(/_/g, ' '), doc.provider, doc.doc_date].filter(Boolean).join(' · ') || 'document';

export async function askQuestion(userId: string, question: string, history: ChatTurn[], screen: ScreenContext | null = null, progress: ChatProgress = {}): Promise<ChatReply | null> {
  // The agent decides what to look up; the fixed pipeline below is the fallback for a model that cannot use tools, for
  // and for an agent that fails.
  const model = getChatLlm().agentModel?.() ?? null;
  if (model) {
    if (!(await hasAnythingToRead(userId, screen))) return { answer: null, sources: [], documents: 0 };
    try {
      return await askAgent(model, userId, question, trimHistory(history), screen, progress);
    } catch (err) {
      // The person left: nothing to answer for.
      if (progress.signal?.aborted) throw err;
      progress.reset?.();
      logger.warn('the chat agent failed; answering without tools', { error: describeError(err) });
    }
  }
  return askWithoutTools(userId, question, history, screen);
}

/** The fixed pipeline: our code finds the documents, the model reads what it is handed. */
async function askWithoutTools(userId: string, question: string, history: ChatTurn[], screen: ScreenContext | null): Promise<ChatReply | null> {
  const store = getStore();
  const turns = trimHistory(history);
  const onScreen = await resolveScreen(userId, screen);

  // A short follow-up ("and the one before?") is searched together with the question it follows.
  const lastQuestion = [...turns].reverse().find(t => t.role === 'user')?.content;
  const query = lastQuestion && question.split(/\s+/).length < SHORT_QUESTION_WORDS ? `${lastQuestion} ${question}` : question;

  // What the person is looking at comes first: the document on screen is D1, then what the screen lists. Then what matches
  // the question, then what it is connected to.
  const docs = new Map<string, Document>();
  if (onScreen?.primary) docs.set(onScreen.primary.id, onScreen.primary);
  for (const doc of onScreen?.listed.slice(0, SCREEN_LISTED) ?? []) docs.set(doc.id, doc);
  for (const doc of await documentsForQuestion(userId, query, TOP_HITS)) docs.set(doc.id, doc);
  for (const seed of [...docs.keys()].slice(0, CHAIN_SEEDS)) {
    const chain = await chainOf(userId, seed);
    for (const node of chain?.nodes ?? []) {
      if (docs.size >= MAX_DOCS) break;
      if (!docs.has(node.id)) { const doc = await store.documents.findFor(userId, node.id); if (doc) docs.set(doc.id, doc); }
    }
  }

  // 3: the values over time of a test the question names.
  const asked = `${query} ${screen?.test ?? ''}`.toLowerCase();
  const tests = (await store.measurements.names(userId))
    .filter(n => (n.canonical.length >= 3 && asked.includes(n.canonical.toLowerCase())) || (n.name.length >= 3 && asked.includes(n.name.toLowerCase())))
    .slice(0, MAX_SERIES);
  const series = await Promise.all(tests.map(async t => ({ test: t, points: (await store.measurements.series(userId, t.canonical)).slice(-SERIES_POINTS) })));
  let extra = 0;
  for (const s of series) {
    for (const p of s.points) {
      if (docs.has(p.document_id) || extra >= SERIES_EXTRA_DOCS) continue;
      const doc = await store.documents.findFor(userId, p.document_id);
      if (doc) { docs.set(doc.id, doc); extra++; }
    }
  }
  // Nothing found and nothing on screen to speak of: the model is not asked.
  if (docs.size === 0 && !(onScreen && onScreen.facts.length > 0)) return { answer: null, sources: [], documents: 0 };

  // Labels, in the order found; the best matches come first and so get the budget first.
  const labelOf = new Map([...docs.keys()].map((id, i) => [id, `D${i + 1}`]));
  const records: ChatRecord[] = [];
  if (onScreen) records.push({ label: 'S0', text: describeScreen(onScreen, labelOf) });
  let budget = Math.min(Math.floor(llmContextChars() / 2), 80_000);
  for (const doc of docs.values()) {
    const label = labelOf.get(doc.id)!;
    // The document on screen is given by section, so an answer can point at one.
    if (doc.id === onScreen?.primary?.id) {
      for (const record of await sectionRecords(userId, doc, label, labelOf)) { records.push(record); budget -= record.text.length; }
      continue;
    }
    let text = headline(doc);
    if (budget > 0) {
      const [card, results] = await Promise.all([cardOf(store, userId, doc), store.measurements.listForDocument(userId, doc.id)]);
      const notes = doc.user_notes?.replace(/\s+/g, ' ').trim();
      text = [
        card,
        notes && `owner's notes: ${clip(notes, NOTES_MAX)}`,
        results.length > 0 && `results:\n${results.slice(0, MAX_RESULTS_PER_DOC).map(resultLine).join('\n')}`,
      ].filter(Boolean).join('\n');
      budget -= text.length;
    }
    records.push({ label, text });
  }

  // How the documents are connected, as the owner confirmed or the app suggested.
  const links = onScreen?.primary ? [] : (await store.links.among(userId, [...docs.keys()])).filter(l => l.state !== 'dismissed');
  if (links.length > 0) {
    const phrase = (l: (typeof links)[number]) => {
      const from = labelOf.get(l.from_document_id); const to = labelOf.get(l.to_document_id);
      const text = l.kind === 'requests' ? `${from} asked for ${to}` : l.kind === 'follow_up' ? `${to} is a follow-up of ${from}` : `${from} and ${to} are one episode`;
      return l.state === 'proposed' ? `${text} (suggested by the app, not confirmed)` : text;
    };
    records.push({ label: 'C1', text: `how the documents are connected:\n${links.map(phrase).join('\n')}` });
  }
  series.forEach((s, i) => {
    if (s.points.length === 0) return;
    records.push({
      label: `T${i + 1}`,
      text: `${s.test.name} over time (oldest first):\n${s.points.map(p => `${p.taken_on ?? 'undated'}: ${p.value_text}${p.unit ? ` ${p.unit}` : ''} [${labelOf.get(p.document_id) ?? '?'}]`).join('\n')}`,
    });
  });

  const answer = await getChatLlm().answerQuestion(question, records, turns);
  if (!answer) return null;

  const byLabel = new Map([...docs.values()].map(d => [labelOf.get(d.id)!, d]));
  const have = new Set(records.map(r => r.label));
  const sources: ChatSource[] = [];
  const seen = new Set<string>();
  for (const cited of answer.sources) {
    const [base, section] = cited.split('.');
    const doc = byLabel.get(base);
    // A section only if that document has one by that name among the records sent.
    const known = section && (DOCUMENT_SECTIONS as readonly string[]).includes(section) && have.has(cited) ? (section as DocumentSection) : undefined;
    if (!doc || (section && !known) || seen.has(cited)) continue;
    seen.add(cited);
    sources.push({ label: cited, id: doc.id, title: doc.title, doc_type: doc.doc_type, doc_date: doc.doc_date, ...(known ? { section: known } : {}) });
  }
  return { answer: answer.answer, sources, documents: docs.size };
}

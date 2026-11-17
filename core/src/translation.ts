import { sha256Hex } from './digest.js';
import { getStore } from './store/index.js';
import { getChatLlm } from './llm/index.js';
import { KNOWN_FIELD_LABELS } from './llm/doc-types.js';
import { LlmBlockedError, type TranslationBundle } from './llm/types.js';
import { translationEnabled, llmConcurrency } from './config.js';
import { mapLimit } from './concurrency.js';
import { logger } from './logger.js';
import { describeError } from './failure.js';
import { modelWait } from './llm/availability.js';
import { LANGUAGE_NAMES, isSupportedLanguage, type SupportedLanguage } from './languages.js';
import { cleanLanguageCode } from './languages.js';
import type { Document } from './types.js';
import type { Store } from './store/types.js';

/**
 * A document in the reader's language: its extracted details and the owner's notes, translated on demand and
 * kept, so the next reader (the same one again, or another with the same language) gets them at once.
 *
 * What is translated is a *bundle*: the title, summary, notes, each field's value (and its label when the
 * interface has no wording for it), each measurement's name and each doctor's specialty. Numbers, units,
 * dates, codes and names are not: the model is told to keep them, and they are not in the bundle at all where
 * they can be left out (a measurement's value and unit, a doctor's name).
 *
 * The cache is validated by digests, not invalidated by hand. A translation is kept with a digest of the whole
 * bundle and one for each of four parts: the title, the summary, the notes, and the details (fields, results and
 * specialties, which re-reading a document replaces together). A part's translation depends on that part's text,
 * the language it is in and the one it is translated into, and the version of the way translations are made;
 * never on another part. Re-extracting a document, editing a field or a note, or anything else that changes
 * what would be translated changes the digest of the part it is in, and the next read finds that part stale and
 * translates it again, and only it: the other parts are served as they were. Any change to a part's text counts
 * (there is no judgement of what is minor, and one part costs one short call). Moving pages does the same
 * through the re-extraction it asks for. There is no list of events to keep in step with.
 *
 * What a document is in originally is extraction's job (`documents.language`): reading it in that language
 * needs no translation, and every other language is translated from it, never from another translation.
 */

export type TranslationStatus = 'same' | 'cached' | 'translated' | 'off' | 'unavailable';

export interface TranslatedDocument {
  language: SupportedLanguage;
  /** What the document is written in, if known. */
  source_language: string | null;
  status: TranslationStatus;
  /** `head`: the title, summary, notes and specialties only; the fields and results follow in the `full` one. */
  part: 'head' | 'full';
  /** Some of it could not be translated and shows in the original; the rest is asked for again later. Only in a `full` one. */
  incomplete?: boolean;
  title: string | null;
  ai_summary: string | null;
  user_notes: string | null;
  /** By field id: the value, and the label if it was translated (else null). */
  fields: Record<string, { label: string | null; value: string }>;
  /** By measurement id: the name. */
  measurements: Record<string, string>;
  /** By doctor id: the specialty. */
  doctors: Record<string, string | null>;
}

/** The parts of a bundle that are kept, and found stale, one by one. */
const PARTS = ['title', 'summary', 'notes', 'details'] as const;
type PartName = typeof PARTS[number];
type PartHashes = Record<PartName, string>;

/** What is stored as a translation's content: the translated bundle, with the digests of the parts it was made from. */
type Kept = TranslationBundle & { parts?: PartHashes };

interface Source {
  document: Document;
  bundle: TranslationBundle;
  hash: string;
  parts: PartHashes;
}

/** `v` changes when the way a translation is made changes, so what an older way kept is not served again. */
const partHash = (part: PartName, language: SupportedLanguage, from: string | null, value: unknown): string =>
  sha256Hex(JSON.stringify({ v: 2, part, language, from, value }));

/** The digest of a title as it would be translated: all a list needs to know whether the title it holds is still good. */
const titleHashOf = (document: Document, language: SupportedLanguage): string =>
  partHash('title', language, document.language, (document.title ?? '').trim() === '' ? null : document.title);

/** The content to store: the bundle with the digests of what it was made from. */
const keep = (source: Source, bundle: TranslationBundle): string => JSON.stringify({ ...bundle, parts: source.parts } satisfies Kept);

/** What a kept translation holds that is still good for the document as it is now: the parts whose digest has not changed. */
function stillGood(kept: Kept, source: Source): TranslationBundle | null {
  if (!kept.parts) return null;
  const good = (part: PartName) => kept.parts?.[part] === source.parts[part];
  return {
    title: good('title') ? kept.title ?? null : null,
    summary: good('summary') ? kept.summary ?? null : null,
    notes: good('notes') ? kept.notes ?? null : null,
    fields: good('details') ? kept.fields ?? [] : [],
    measurements: good('details') ? kept.measurements ?? [] : [],
    doctors: good('details') ? kept.doctors ?? [] : [],
    source_language: kept.source_language ?? null,
  };
}

const sourceOf = async (userId: string, document: Document, language: SupportedLanguage, store: Store = getStore()): Promise<Source> => {
  const [fields, measurements, doctors] = await Promise.all([
    store.fields.listForDocument(userId, document.id),
    store.measurements.listForDocument(userId, document.id),
    store.doctors.forDocument(userId, document.id),
  ]);
  const blank = (text: string | null | undefined) => (text ?? '').trim() === '';
  const bundle: TranslationBundle = {
    title: blank(document.title) ? null : document.title,
    summary: blank(document.ai_summary) ? null : document.ai_summary,
    notes: blank(document.user_notes) ? null : document.user_notes,
    fields: fields.filter(f => !blank(f.value)).map(f => ({ id: f.id, label: KNOWN_FIELD_LABELS.has(f.label) ? null : f.label, value: f.value })),
    measurements: measurements.filter(m => !blank(m.name)).map(m => ({ id: m.id, name: m.name })),
    doctors: doctors.filter(d => !blank(d.specialty)).map(d => ({ id: d.id, specialty: d.specialty })),
  };
  const hash = sha256Hex(JSON.stringify({ v: 2, language, from: document.language, bundle }));
  const parts: PartHashes = {
    title: titleHashOf(document, language),
    summary: partHash('summary', language, document.language, bundle.summary),
    notes: partHash('notes', language, document.language, bundle.notes),
    details: partHash('details', language, document.language, { fields: bundle.fields, measurements: bundle.measurements, doctors: bundle.doctors }),
  };
  return { document, bundle, hash, parts };
};

const isEmpty = (bundle: TranslationBundle) =>
  !bundle.title && !bundle.summary && !bundle.notes && bundle.fields.length === 0 && bundle.measurements.length === 0 && bundle.doctors.length === 0;

/** The stored translation reshaped for the reader, filling anything the model left out with the original. */
function shape(source: Source, translated: TranslationBundle, language: SupportedLanguage, status: TranslationStatus, part: 'head' | 'full' = 'full'): TranslatedDocument {
  const byId = <T extends { id: string }>(list: T[]) => new Map(list.map(item => [item.id, item]));
  const f = byId(translated.fields);
  const m = byId(translated.measurements);
  const d = byId(translated.doctors);
  const pick = (text: string | null | undefined, original: string | null) => (text && text.trim() ? text : original);
  return {
    language,
    source_language: source.document.language,
    status,
    part,
    ...(part === 'full' && !isEmpty(leftOver(source.bundle, translated)) ? { incomplete: true } : {}),
    title: pick(translated.title, source.bundle.title),
    ai_summary: pick(translated.summary, source.bundle.summary),
    user_notes: pick(translated.notes, source.bundle.notes),
    fields: part === 'head' ? {} : Object.fromEntries(source.bundle.fields.map(field => {
      const got = f.get(field.id);
      return [field.id, { label: field.label === null ? null : pick(got?.label, field.label), value: pick(got?.value, field.value) ?? field.value }];
    })),
    measurements: part === 'head' ? {} : Object.fromEntries(source.bundle.measurements.map(item => [item.id, pick(m.get(item.id)?.name, item.name) ?? item.name])),
    doctors: Object.fromEntries(source.bundle.doctors.map(item => [item.id, pick(d.get(item.id)?.specialty, item.specialty)])),
  };
}

/** The bundle split so no single reply has to carry a long lab panel: the short parts first, then lists in pieces. */
function pieces(bundle: TranslationBundle, size = 100): TranslationBundle[] {
  const out: TranslationBundle[] = [{ ...bundle, fields: bundle.fields.slice(0, size), measurements: bundle.measurements.slice(0, size) }];
  for (let i = size; i < bundle.fields.length; i += size) {
    out.push({ title: null, summary: null, notes: null, fields: bundle.fields.slice(i, i + size), measurements: [], doctors: [] });
  }
  for (let i = size; i < bundle.measurements.length; i += size) {
    out.push({ title: null, summary: null, notes: null, fields: [], measurements: bundle.measurements.slice(i, i + size), doctors: [] });
  }
  return out;
}

/** A bundle in two, by its separate texts (title, summary, notes, each field, result and specialty); null if it is one. */
function halves(bundle: TranslationBundle): [TranslationBundle, TranslationBundle] | null {
  const units: Array<(into: TranslationBundle) => void> = [];
  if (bundle.title) units.push(b => { b.title = bundle.title; });
  if (bundle.summary) units.push(b => { b.summary = bundle.summary; });
  if (bundle.notes) units.push(b => { b.notes = bundle.notes; });
  for (const f of bundle.fields) units.push(b => { b.fields.push(f); });
  for (const m of bundle.measurements) units.push(b => { b.measurements.push(m); });
  for (const d of bundle.doctors) units.push(b => { b.doctors.push(d); });
  if (units.length < 2) return null;
  const blank = (): TranslationBundle => ({ title: null, summary: null, notes: null, fields: [], measurements: [], doctors: [] });
  const [a, b] = [blank(), blank()];
  const mid = Math.ceil(units.length / 2);
  units.forEach((add, i) => add(i < mid ? a : b));
  return [a, b];
}

/**
 * One piece translated. A reply the provider refused (a recitation block on boilerplate, say) or that was not usable
 * JSON is asked again in halves, down to single texts, so one stubborn line costs that line and not the document; a
 * text that still fails alone is left out and is shown in the original. Anything else (a 429, an outage) propagates.
 */
async function translatePiece(
  piece: TranslationBundle,
  translate: (bundle: TranslationBundle) => Promise<TranslationBundle | null>,
): Promise<TranslationBundle | null> {
  let answer: TranslationBundle | null = null;
  try {
    answer = await translate(piece);
  } catch (err) {
    if (!(err instanceof LlmBlockedError)) throw err;
  }
  if (answer) return answer;
  const split = halves(piece);
  if (!split) return null;
  const [first, second] = [await translatePiece(split[0], translate), await translatePiece(split[1], translate)];
  if (!first && !second) return null;
  const empty = (): TranslationBundle => ({ title: null, summary: null, notes: null, fields: [], measurements: [], doctors: [], source_language: null });
  const [x, y] = [first ?? empty(), second ?? empty()];
  return {
    title: x.title ?? y.title, summary: x.summary ?? y.summary, notes: x.notes ?? y.notes,
    fields: [...x.fields, ...y.fields], measurements: [...x.measurements, ...y.measurements], doctors: [...x.doctors, ...y.doctors],
    source_language: x.source_language ?? y.source_language ?? null,
  };
}

/**
 * Whether the model's text is a translation of the original and not a ramble: present, and about as long (a model
 * that loses its way writes the original, then alternatives, then arrows). A bad one is treated as missing.
 */
const sound = (translated: string | null | undefined, original: string | null): boolean => {
  if (original === null || original.trim() === '') return true;
  if (!translated || translated.trim() === '') return false;
  if (translated.length > original.length * 3 + 40) return false;
  return !(translated.includes(' -> ') && !original.includes(' -> '));
};

/** The model's answer with everything unsound taken out, so the rest can still be used. */
function cleaned(source: TranslationBundle, answer: TranslationBundle): TranslationBundle {
  const got = <T extends { id: string }>(list: T[]) => new Map(list.map(item => [item.id, item]));
  const f = got(answer.fields);
  const m = got(answer.measurements);
  const d = got(answer.doctors);
  return {
    title: sound(answer.title, source.title) ? answer.title : null,
    summary: sound(answer.summary, source.summary) ? answer.summary : null,
    notes: sound(answer.notes, source.notes) ? answer.notes : null,
    fields: source.fields.flatMap(item => {
      const a = f.get(item.id);
      return a && sound(a.value, item.value) && (item.label === null || sound(a.label, item.label)) ? [a] : [];
    }),
    measurements: source.measurements.flatMap(item => { const a = m.get(item.id); return a && sound(a.name, item.name) ? [a] : []; }),
    doctors: source.doctors.flatMap(item => { const a = d.get(item.id); return a && sound(a.specialty, item.specialty) ? [a] : []; }),
  };
}

/** What of the source the cleaned answer does not cover. */
function leftOver(source: TranslationBundle, answer: TranslationBundle): TranslationBundle {
  const has = (list: Array<{ id: string }>) => new Set(list.map(i => i.id));
  const f = has(answer.fields);
  const m = has(answer.measurements);
  const d = has(answer.doctors);
  return {
    title: source.title && !answer.title ? source.title : null,
    summary: source.summary && !answer.summary ? source.summary : null,
    notes: source.notes && !answer.notes ? source.notes : null,
    fields: source.fields.filter(i => !f.has(i.id)),
    measurements: source.measurements.filter(i => !m.has(i.id)),
    doctors: source.doctors.filter(i => !d.has(i.id)),
  };
}

/** The first answer with a second one's items laid over it. */
function overlaid(base: TranslationBundle, extra: TranslationBundle): TranslationBundle {
  const merge = <T extends { id: string }>(a: T[], b: T[]) => [...a.filter(x => !b.some(y => y.id === x.id)), ...b];
  return {
    title: extra.title ?? base.title, summary: extra.summary ?? base.summary, notes: extra.notes ?? base.notes,
    fields: merge(base.fields, extra.fields), measurements: merge(base.measurements, extra.measurements), doctors: merge(base.doctors, extra.doctors),
  };
}

/**
 * Keeps a translation that was written by hand, as the one the model would have made: the sample records are shown in the reader's language with no model call. It is stored under the
 * digest of what would be translated, so it is served as a translation made and is replaced, as any is, if the document changes. Texts are given by the text they translate (the original
 * value, test name or specialty); one not given stays as it is.
 */
export async function storeTranslation(
  userId: string,
  documentId: string,
  language: SupportedLanguage,
  by: { title: string | null; summary: string | null; fields: Record<string, string>; measurements: Record<string, string>; doctors: Record<string, string> },
): Promise<boolean> {
  const store = getStore();
  const document = await store.documents.findFor(userId, documentId);
  if (!document) return false;
  const source = await sourceOf(userId, document, language);
  const bundle: TranslationBundle = {
    title: source.bundle.title === null ? null : by.title ?? source.bundle.title,
    summary: source.bundle.summary === null ? null : by.summary ?? source.bundle.summary,
    notes: null,
    fields: source.bundle.fields.map(f => ({ id: f.id, label: f.label, value: by.fields[f.value] ?? f.value })),
    measurements: source.bundle.measurements.map(m => ({ id: m.id, name: by.measurements[m.name] ?? m.name })),
    doctors: source.bundle.doctors.map(d => ({ id: d.id, specialty: d.specialty === null ? null : by.doctors[d.specialty] ?? d.specialty })),
    source_language: document.language,
  };
  await store.translations.put(userId, documentId, language, source.hash, keep(source, bundle), new Date().toISOString());
  return true;
}

/** A document the model could not translate completely is not asked again for a while: each view would be another call. */
const FAILURE_PAUSE_MS = 10 * 60_000;
const failures = new Map<string, number>();

/**
 * A translation being made. `head` is ready first: the title, summary, notes and specialties, which is what a page shows
 * first and is one short model call. `full` is everything, once the fields and results have been translated too.
 */
interface Run { head: Promise<TranslatedDocument | null>; full: Promise<TranslatedDocument | null> }
const inFlight = new Map<string, Run>();

/**
 * The document in `language`, from the cache if it is fresh, otherwise translated now. `cachedOnly` never calls
 * the model: it answers `null` for one that is not ready, which is what a list uses before it asks for the
 * translation to be made in the background.
 *
 * `same`: the document is already in that language. `off`: translation is switched off here, so the original
 * is what there is. `unavailable` (cached-only): it could not be translated a moment ago and is not asked for again
 * until the pause is over, so a list shows the original rather than waiting for it. `null` (not cached-only): the
 * model could not be reached or its answer was unusable.
 */
export async function translateDocument(
  userId: string,
  documentId: string,
  language: SupportedLanguage,
  options: { cachedOnly?: boolean; part?: 'head' | 'full'; persistLanguage?: boolean } = {},
): Promise<TranslatedDocument | null | 'not_found'> {
  const store = getStore();
  const document = await store.documents.findFor(userId, documentId);
  if (!document) return 'not_found';

  const source = await sourceOf(userId, document, language);
  const original = { fields: {}, measurements: {}, doctors: {} };
  const unchanged = (status: TranslationStatus): TranslatedDocument => ({
    language, source_language: document.language, status, part: 'full',
    title: source.bundle.title, ai_summary: source.bundle.summary, user_notes: source.bundle.notes, ...original,
  });

  if (!translationEnabled()) {
    // Off means no model is asked; what is already kept (or was given with the document, as the sample records' is) is still the reader's translation.
    if (document.language !== language && !isEmpty(source.bundle)) {
      const kept = await store.translations.get(userId, documentId, language);
      if (kept && kept.sourceHash === source.hash) {
        try {
          const bundle = JSON.parse(kept.content) as TranslationBundle;
          if (isEmpty(leftOver(source.bundle, bundle))) return shape(source, bundle, language, 'cached');
        } catch { /* an unreadable row is the same as none */ }
      }
    }
    return unchanged('off');
  }
  if (document.language === language || isEmpty(source.bundle)) return unchanged('same');

  /** What is kept and still good, when it does not cover the whole document: only the rest is asked for. */
  let base: TranslationBundle | null = null;
  const cached = await store.translations.get(userId, documentId, language);
  if (cached && cached.sourceHash !== source.hash) {
    // Stale as a whole, perhaps not in every part: what is still good is kept, and only the rest is asked for.
    try {
      const good = stillGood(JSON.parse(cached.content) as Kept, source);
      if (good && !isEmpty(good)) base = good;
    } catch { /* an unreadable row is the same as a stale one: translate again */ }
  }
  if (cached && cached.sourceHash === source.hash) {
    try {
      const kept = JSON.parse(cached.content) as Kept;
      // Made for a share recipient, who does not record a language: the owner's visit does, from what the model said,
      // and the stored translation moves to the digest it now has, so nothing is translated again.
      const detected = !document.language && options.persistLanguage !== false ? cleanLanguageCode(kept.source_language) : null;
      if (detected) {
        await store.documents.update(userId, documentId, { language: detected });
        if (detected === language) return unchanged('same');
        const recorded = await sourceOf(userId, { ...document, language: detected }, language);
        await store.translations.put(userId, documentId, language, recorded.hash, keep(recorded, kept), cached.createdAt);
        return shape(recorded, kept, language, 'cached');
      }
      // Already in this language, as the model said for a reader who records no language (a share's): nothing to translate, and
      // nothing to ask again at every look. Before this was kept, a document with no language recorded (one read from no text) was
      // detected afresh at each of a list's polls, and stayed "translating".
      if (cleanLanguageCode(kept.source_language) === language) return unchanged('same');
      if (isEmpty(leftOver(source.bundle, kept))) {
        // Kept before the parts had digests of their own: they are written now, so the next edit costs only the part it touches.
        if (!kept.parts) await store.translations.put(userId, documentId, language, source.hash, keep(source, kept), cached.createdAt);
        return shape(source, kept, language, 'cached');
      }
      base = kept;
    } catch { /* an unreadable row is the same as a stale one: translate again */ }
  }
  const keptPart = () => (base ? shape(source, base, language, 'cached') : null);
  // One translation of a document into a language at a time, however many readers ask at once.
  const key = `${documentId}:${language}:${source.hash}`;
  const failedAt = failures.get(key);
  const paused = !!failedAt && Date.now() - failedAt < FAILURE_PAUSE_MS;
  if (options.cachedOnly) return keptPart() ?? (paused ? unchanged('unavailable') : null);
  if (paused) return keptPart();
  let run = inFlight.get(key);
  if (!run) {
    let resolveHead!: (value: TranslatedDocument | null) => void;
    const head = new Promise<TranslatedDocument | null>(resolve => { resolveHead = resolve; });
    const full = (async (): Promise<TranslatedDocument | null> => {
      try {
        const llm = getChatLlm();
        // Every call of this translation carries one id and the document's page count, so the plan counts the pages once, however many calls it takes.
        const meta = { work: crypto.randomUUID(), pages: Math.max(1, document.page_end - document.page_start + 1) };
        let fromName = document.language ? (LANGUAGE_NAMES[document.language as SupportedLanguage] ?? document.language) : null;
        const ask = async (bundle: TranslationBundle): Promise<TranslationBundle | null> => {
          const parts = pieces(bundle);
          const answers = await mapLimit(parts, llmConcurrency(), part => translatePiece(part, b => llm.translate(b, LANGUAGE_NAMES[language], fromName, meta)));
          // A piece nothing could be got from is left out: what it held is asked for once more, then shown in the original.
          const results = answers.filter((a): a is TranslationBundle => !!a);
          if (results.length === 0) return null;
          const lead = answers[0]; // the one that carries the title, summary, notes and specialties
          return {
            title: lead?.title ?? null, summary: lead?.summary ?? null, notes: lead?.notes ?? null,
            doctors: lead?.doctors ?? [],
            fields: results.flatMap(r => r.fields),
            measurements: results.flatMap(r => r.measurements),
            source_language: results.find(r => r.source_language)?.source_language ?? null,
          };
        };
        /** What came back sound is kept; what was left out or rambled is asked for again, once. */
        const settle = async (wanted: TranslationBundle, answer: TranslationBundle): Promise<TranslationBundle> => {
          let kept = cleaned(wanted, answer);
          const missing = leftOver(wanted, kept);
          if (!isEmpty(missing)) {
            const again = await ask(missing);
            if (again) kept = overlaid(kept, cleaned(missing, again));
          }
          return kept;
        };

        // Stage one: the short parts, so a page has something in its language after one quick call.
        const wanted = base ? leftOver(source.bundle, base) : source.bundle;
        const withBase = (b: TranslationBundle): TranslationBundle => (base ? overlaid(base, b) : b);
        const headBundle: TranslationBundle = { ...wanted, fields: [], measurements: [] };
        const bodyBundle: TranslationBundle = { title: null, summary: null, notes: null, doctors: [], fields: wanted.fields, measurements: wanted.measurements };
        const headAnswer = isEmpty(headBundle) ? null : await ask(headBundle);
        // Nothing usable for any part (an outage throws instead, below): paused like a half answer, or each look asks again.
        if (!isEmpty(headBundle) && !headAnswer) {
          failures.set(key, Date.now());
          return null;
        }

        // A document whose language was never recorded gets it from the model's answer, and is not translated into
        // the language it is already in.
        let current = source;
        if (!document.language && headAnswer) {
          const detected = cleanLanguageCode(headAnswer.source_language);
          if (detected) {
            fromName = LANGUAGE_NAMES[detected as SupportedLanguage] ?? detected;
            // Only the owner's own request writes to the document. A share recipient's read does not, so a public
            // route never changes a record; the owner's next visit records it.
            if (options.persistLanguage !== false) {
              await store.documents.update(userId, documentId, { language: detected });
              current = await sourceOf(userId, { ...document, language: detected }, language);
            }
            if (detected === language) {
              // Kept as that, for a reader who records no language too, so the next look does not ask the model again.
              if (options.persistLanguage === false) {
                const marker: TranslationBundle = { title: null, summary: null, notes: null, fields: [], measurements: [], doctors: [], source_language: detected };
                await store.translations.put(userId, documentId, language, current.hash, keep(current, marker), new Date().toISOString());
              }
              return unchanged('same');
            }
          }
        }

        const headDone = headAnswer ? await settle(headBundle, headAnswer) : { ...headBundle, source_language: null };
        resolveHead(shape(current, withBase(headDone), language, 'translated', 'head'));

        // Stage two: the fields and results, in pieces if there are many.
        let bodyDone: TranslationBundle = { ...bodyBundle, source_language: null };
        if (!isEmpty(bodyBundle)) {
          const bodyAnswer = await ask(bodyBundle);
          if (!bodyAnswer) return null; // the head was delivered; the rest can be asked for again
          bodyDone = await settle(bodyBundle, bodyAnswer);
        }

        const merged: TranslationBundle = { ...overlaid(withBase(headDone), bodyDone), source_language: headAnswer?.source_language ?? base?.source_language ?? null };
        if (!isEmpty(leftOver(current.bundle, merged))) {
          // What is usable is kept all the same, so the next view starts from it; what is missing reads as missing (`incomplete`) and is asked
          // for again, alone, once the pause has passed.
          failures.set(key, Date.now());
          logger.warn('a document could only be translated in part', { documentId, language });
        }
        await store.translations.put(userId, documentId, language, current.hash, keep(current, merged), new Date().toISOString());
        return shape(current, merged, language, 'translated');
      } catch (err) {
        logger.warn('a document could not be translated', { documentId, language, error: describeError(err) });
        // A limit or an outage (`llm/availability.ts`): asking again at every view of the page spends more of the quota, or waits again.
        if (modelWait(err) || /status code 429/.test(describeError(err))) failures.set(key, Date.now());
        return null;
      } finally {
        resolveHead(null); // no effect if the head was already delivered
        inFlight.delete(key);
      }
    })();
    run = { head, full };
    inFlight.set(key, run);
  }
  const running = options.part === 'head' ? run.head : run.full;
  return running;
}

/**
 * Translate these documents into `language` in the background, a couple at a time, so the reader who asks next
 * finds them ready. A failure is logged and does not stop the rest.
 */
export function warmTranslations(userId: string, documentIds: string[], language: string): void {
  // Started by a share (a recipient's list, or the owner making a link): neither records a language on a document.
  if (!translationEnabled() || !isSupportedLanguage(language)) return;
  void mapLimit(documentIds, Math.min(2, llmConcurrency()), async id => {
    await translateDocument(userId, id, language, { persistLanguage: false }).catch(() => null);
  }).catch(() => undefined);
}

/**
 * Into a share's copy (`SliceOptions.finish`): the translations the owner keeps of the documents it holds, so the reader is shown them at
 * once and no model is asked again for what was already translated. Only a translation still good for the owner's document is carried,
 * and only what of it the copy holds the original of: a field or result on a page the owner hid is in neither. It is kept under the
 * digest of the copy's own text, which is what the reader's core compares it with.
 */
export async function carryTranslations(userId: string, documentIds: string[], copy: Store): Promise<void> {
  const store = getStore();
  for (const documentId of documentIds) {
    const [mine, theirs] = [await store.documents.findFor(userId, documentId), await copy.documents.findFor(userId, documentId)];
    if (!mine || !theirs) continue;
    for (const language of await store.translations.languagesFor(userId, documentId)) {
      if (!isSupportedLanguage(language)) continue;
      const kept = await store.translations.get(userId, documentId, language);
      if (!kept) continue;
      const own = await sourceOf(userId, mine, language);
      let content: TranslationBundle;
      try {
        const parsed = JSON.parse(kept.content) as Kept;
        // What is still good for the owner's document, part by part: an edited note does not keep the title out of the copy.
        const good = kept.sourceHash === own.hash ? parsed : stillGood(parsed, own);
        if (!good || isEmpty(good)) continue;
        content = good;
      } catch { continue; }
      const held = await sourceOf(userId, theirs, language, copy);
      const ids = <T extends { id: string }>(list: T[]) => new Set(list.map(item => item.id));
      const [fields, measurements, doctors] = [ids(held.bundle.fields), ids(held.bundle.measurements), ids(held.bundle.doctors)];
      const cut: TranslationBundle = {
        title: held.bundle.title ? content.title : null,
        summary: held.bundle.summary ? content.summary : null,
        notes: held.bundle.notes ? content.notes : null,
        fields: (content.fields ?? []).filter(f => fields.has(f.id)),
        measurements: (content.measurements ?? []).filter(m => measurements.has(m.id)),
        doctors: (content.doctors ?? []).filter(d => doctors.has(d.id)),
        source_language: content.source_language ?? null,
      };
      await copy.translations.put(userId, documentId, language, held.hash, keep(held, cut), kept.createdAt);
    }
  }
}

/** The digest of a summary as it would be translated: what a list needs to know whether the summary it holds is still good. */
const summaryHashOf = (document: Document, language: SupportedLanguage): string =>
  partHash('summary', language, document.language, (document.ai_summary ?? '').trim() === '' ? null : document.ai_summary);

/**
 * What a list learns of a document's title and summary in a language: `same` (already in it, or nothing to translate), `ready` (the title and the summary,
 * each null where it is not kept or no longer matches; `stale` says some is still to be made), `missing` (nothing yet: to be made), `off` or `not_found`.
 */
export type KeptText = { state: 'same' | 'missing' | 'off' | 'not_found' } | { state: 'ready'; title: string | null; summary: string | null; stale: boolean };

/**
 * The titles and summaries of these documents in `language`, from what is kept and nowhere else: the model is never asked. A text is given only
 * while its own digest still matches the document's, so it is never one that no longer matches its document, and it does not matter what else on the
 * document changed. Only the title and the summary are read (one document row and one translation row); a translation kept before the parts had
 * digests is checked once against the whole document and then written with them.
 */
export async function keptTexts(userId: string, documentIds: string[], language: SupportedLanguage): Promise<Map<string, KeptText>> {
  const store = getStore();
  const out = new Map<string, KeptText>();
  const blank = (text: string | null | undefined) => (text ?? '').trim() === '';
  for (const id of documentIds) {
    const document = await store.documents.findFor(userId, id);
    if (!document) { out.set(id, { state: 'not_found' }); continue; }
    const [hasTitle, hasSummary] = [!blank(document.title), !blank(document.ai_summary)];
    const kept = await store.translations.get(userId, id, language);
    let content: Kept | null = null;
    try { content = kept ? JSON.parse(kept.content) as Kept : null; } catch { /* unreadable: the same as none */ }
    let title: string | null = null;
    let summary: string | null = null;
    if (kept && content) {
      let parts = content.parts;
      if (!parts) {
        const source = await sourceOf(userId, document, language);
        if (kept.sourceHash === source.hash) {
          await store.translations.put(userId, id, language, source.hash, keep(source, content), kept.createdAt);
          parts = source.parts;
        }
      }
      if (parts) {
        if (hasTitle && parts.title === titleHashOf(document, language) && !blank(content.title)) title = content.title!.trim();
        if (hasSummary && parts.summary === summaryHashOf(document, language) && !blank(content.summary)) summary = content.summary!.trim();
      }
    }
    if (title !== null || summary !== null) out.set(id, { state: 'ready', title, summary, stale: translationEnabled() && ((hasTitle && title === null) || (hasSummary && summary === null)) });
    else if (!translationEnabled()) out.set(id, { state: 'off' });
    else if (document.language === language || (!hasTitle && !hasSummary)) out.set(id, { state: 'same' });
    else out.set(id, { state: 'missing' });
  }
  return out;
}

/** The wording of doctors' specialties and of test names in a language, and whether some is still being made. */
export interface KeptTerms {
  /** By the specialty as the directory has it. */
  specialties: Record<string, string>;
  /** By the test's name as the trends list it. */
  tests: Record<string, string>;
  pending: boolean;
}

const termsRunning = new Set<string>();
const termsFailedAt = new Map<string, number>();

/**
 * Specialties and test names in `language`, for the pages that list them across documents (the doctors, the trends), where no one document's translation
 * is theirs: a doctor and a test are in many documents. They are kept by the text (`term_translations`), so every doctor with a specialty and every
 * document with a test gets the same words, and an edited name is a new text with nothing stale to find. What is not kept yet is translated in the
 * background, all of it in one short call to the model (counted by the relay like a document's), and `pending` tells the page to ask again; with
 * translation off, or while a failure is being waited out, nothing is asked and the original shows.
 */
export async function keptTerms(userId: string, language: SupportedLanguage): Promise<KeptTerms> {
  const store = getStore();
  const clean = (text: string | null | undefined) => (text ?? '').trim();
  const specialties = new Set((await store.doctors.listFor(userId)).map(d => clean(d.specialty)).filter(Boolean));
  const tests = new Set((await store.measurements.names(userId)).map(n => clean(n.name)).filter(Boolean));
  const out: KeptTerms = { specialties: {}, tests: {}, pending: false };
  const have = new Set<string>();
  for (const row of await store.termTranslations.forLanguage(userId, language)) {
    const inUse = row.kind === 'specialty' ? specialties : tests;
    if (!inUse.has(row.sourceText)) continue;
    have.add(`${row.kind}\u0000${row.sourceText}`);
    if (row.translated !== row.sourceText) (row.kind === 'specialty' ? out.specialties : out.tests)[row.sourceText] = row.translated;
  }
  const missing = [
    ...[...specialties].filter(t => !have.has(`specialty\u0000${t}`)).map(text => ({ kind: 'specialty' as const, text })),
    ...[...tests].filter(t => !have.has(`test\u0000${t}`)).map(text => ({ kind: 'test' as const, text })),
  ];
  const key = `${userId}:${language}`;
  const paused = Date.now() - (termsFailedAt.get(key) ?? 0) < FAILURE_PAUSE_MS;
  if (missing.length === 0 || !translationEnabled() || paused) return out;
  out.pending = true;
  if (!termsRunning.has(key)) {
    termsRunning.add(key);
    void (async () => {
      try {
        const llm = getChatLlm();
        const meta = { work: crypto.randomUUID(), pages: 1 };
        for (let i = 0; i < missing.length; i += TERMS_PER_CALL) {
          const part = missing.slice(i, i + TERMS_PER_CALL);
          const asked = part.map((m, n) => ({ ...m, id: String(n) }));
          const bundle: TranslationBundle = {
            title: null, summary: null, notes: null, fields: [],
            measurements: asked.filter(m => m.kind === 'test').map(m => ({ id: m.id, name: m.text })),
            doctors: asked.filter(m => m.kind === 'specialty').map(m => ({ id: m.id, specialty: m.text })),
          };
          const answer = await translatePiece(bundle, b => llm.translate(b, LANGUAGE_NAMES[language], null, meta));
          if (!answer) { termsFailedAt.set(key, Date.now()); continue; }
          const said = new Map<string, string | null>([...answer.measurements.map(m => [m.id, m.name] as const), ...answer.doctors.map(d => [d.id, d.specialty] as const)]);
          // The model's text is kept only where it is a translation and not a ramble; a name it could not do is asked for again after the pause.
          const rows = asked.flatMap(m => { const text = said.get(m.id); return text && sound(text, m.text) ? [{ kind: m.kind, sourceText: m.text, translated: text.trim() }] : []; });
          if (rows.length < asked.length) termsFailedAt.set(key, Date.now());
          await store.termTranslations.put(userId, language, rows, new Date().toISOString());
        }
      } catch (err) {
        logger.warn('terms could not be translated', { language, error: describeError(err) });
        termsFailedAt.set(key, Date.now());
      } finally {
        termsRunning.delete(key);
      }
    })();
  }
  return out;
}

/** Specialties and test names asked of the model in one call. */
const TERMS_PER_CALL = 80;

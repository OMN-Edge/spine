import { sha256Hex } from './digest.js';
import { getStore } from './store/index.js';
import { getChatLlm } from './llm/index.js';
import { KNOWN_FIELD_LABELS } from './llm/doc-types.js';
import { LlmBlockedError, type TranslationBundle } from './llm/types.js';
import { translationEnabled, llmConcurrency } from './config.js';
import { mapLimit } from './concurrency.js';
import { logger } from './logger.js';
import { describeError } from './failure.js';
import { LANGUAGE_NAMES, isSupportedLanguage, type SupportedLanguage } from './languages.js';
import { cleanLanguageCode } from './languages.js';
import type { Document } from './types.js';

/**
 * A document in the reader's language: its extracted details and the owner's notes, translated on demand and
 * kept, so the next reader (the same one again, or another with the same language) gets them at once.
 *
 * What is translated is a *bundle*: the title, summary, notes, each field's value (and its label when the
 * interface has no wording for it), each measurement's name and each doctor's specialty. Numbers, units,
 * dates, codes and names are not: the model is told to keep them, and they are not in the bundle at all where
 * they can be left out (a measurement's value and unit, a doctor's name).
 *
 * The cache is validated by a digest of the bundle, not invalidated by hand. Re-extracting a document,
 * editing a field or a note, or anything else that changes what would be translated changes the digest, and
 * the next read finds the stored translation stale and translates again. Moving pages does the same through
 * the re-extraction it asks for. There is no list of events to keep in step with.
 *
 * What a document is in originally is extraction's job (`documents.language`): reading it in that language
 * needs no translation, and every other language is translated from it, never from another translation.
 */

export type TranslationStatus = 'same' | 'cached' | 'translated' | 'off';

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

interface Source {
  document: Document;
  bundle: TranslationBundle;
  hash: string;
}

const sourceOf = async (userId: string, document: Document, language: SupportedLanguage): Promise<Source> => {
  const store = getStore();
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
  // `v` changes when the way a translation is made changes, so what an older way kept is not served again.
  const hash = sha256Hex(JSON.stringify({ v: 2, language, from: document.language, bundle }));
  return { document, bundle, hash };
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
 * is what there is. `null` (not cached-only): the model could not be reached or its answer was unusable.
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

  if (!translationEnabled()) return unchanged('off');
  if (document.language === language || isEmpty(source.bundle)) return unchanged('same');

  /** What is kept and still good, when it does not cover the whole document: only the rest is asked for. */
  let base: TranslationBundle | null = null;
  const cached = await store.translations.get(userId, documentId, language);
  if (cached && cached.sourceHash === source.hash) {
    try {
      const kept = JSON.parse(cached.content) as TranslationBundle;
      // Made for a share recipient, who does not record a language: the owner's visit does, from what the model said,
      // and the stored translation moves to the digest it now has, so nothing is translated again.
      const detected = !document.language && options.persistLanguage !== false ? cleanLanguageCode(kept.source_language) : null;
      if (detected) {
        await store.documents.update(userId, documentId, { language: detected });
        if (detected === language) return unchanged('same');
        const recorded = await sourceOf(userId, { ...document, language: detected }, language);
        await store.translations.put(userId, documentId, language, recorded.hash, cached.content, cached.createdAt);
        return shape(recorded, kept, language, 'cached');
      }
      if (isEmpty(leftOver(source.bundle, kept))) return shape(source, kept, language, 'cached');
      base = kept;
    } catch { /* an unreadable row is the same as a stale one: translate again */ }
  }
  const keptPart = () => (base ? shape(source, base, language, 'cached') : null);
  if (options.cachedOnly) return keptPart();

  // One translation of a document into a language at a time, however many readers ask at once.
  const key = `${documentId}:${language}:${source.hash}`;
  const failedAt = failures.get(key);
  if (failedAt && Date.now() - failedAt < FAILURE_PAUSE_MS) return keptPart();
  let run = inFlight.get(key);
  if (!run) {
    let resolveHead!: (value: TranslatedDocument | null) => void;
    const head = new Promise<TranslatedDocument | null>(resolve => { resolveHead = resolve; });
    const full = (async (): Promise<TranslatedDocument | null> => {
      try {
        const llm = getChatLlm();
        let fromName = document.language ? (LANGUAGE_NAMES[document.language as SupportedLanguage] ?? document.language) : null;
        const ask = async (bundle: TranslationBundle): Promise<TranslationBundle | null> => {
          const parts = pieces(bundle);
          const answers = await mapLimit(parts, llmConcurrency(), part => translatePiece(part, b => llm.translate(b, LANGUAGE_NAMES[language], fromName)));
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
        if (!isEmpty(headBundle) && !headAnswer) return null; // an outage is tried again next time; only a half answer is paused

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
            if (detected === language) return unchanged('same');
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
        await store.translations.put(userId, documentId, language, current.hash, JSON.stringify(merged), new Date().toISOString());
        return shape(current, merged, language, 'translated');
      } catch (err) {
        logger.warn('a document could not be translated', { documentId, language, error: describeError(err) });
        // A rate limit is the provider's quota: asking again at every view of the page spends more of it.
        if (/status code 429/.test(describeError(err))) failures.set(key, Date.now());
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

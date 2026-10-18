import { v4 as uuidv4 } from 'uuid';
import { getStore, type NewExtractedField, type NewMeasurement, type PageSummary, type Store } from '../store/index.js';
import { normaliseMeasurements } from './measurements.js';
import { extractFields } from './extraction.js';
import { groundSnippet } from './grounding.js';
import { EXTRACTION_FALLBACK } from '../llm/types.js';
import { llmConcurrency, llmContextChars } from '../config.js';
import { mapLimit } from '../concurrency.js';
import { cleanLanguageCode } from '../languages.js';
import { scheduleSync } from '../similarity/index.js';
import { scheduleLinking } from '../linking/index.js';
import type { ExtractionResult } from '../types.js';
import { fieldKey, fieldSlot, measurementKey, measurementSlot } from '../store/reading-keys.js';

/**
 * Reading one logical document: its pages' text goes to `extractFields` (text only, the
 * same egress as any upload), and every field it returns is grounded on its page. Shared
 * by ingestion and by regrouping, which reads the documents a split or join changed.
 *
 * The model sees the whole document. The only cap is the context window: a document that
 * would not fit is split into chunks at page boundaries, never cut off.
 */

/** A page as the model sees it, under a marker with its number in the upload. */
function pageBlock(page: PageSummary, budget: number): string {
  const head = `--- page ${page.page_number} ---\n`;
  const text = page.raw_text ?? '';
  // A single page larger than the whole window cannot be split further. This is the one place text is cut.
  return head + (text.length > budget - head.length ? text.slice(0, budget - head.length) : text);
}

/** The document's pages in order, packed into chunks that each fit the window. One chunk for nearly every document. */
export function chunkPages(pages: PageSummary[], budget: number): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let size = 0;
  for (const page of pages) {
    const block = pageBlock(page, budget);
    const added = current.length === 0 ? block.length : block.length + 2; // the blank line between pages
    if (current.length > 0 && size + added > budget) {
      chunks.push(current.join('\n\n'));
      current = [block];
      size = block.length;
    } else {
      current.push(block);
      size += added;
    }
  }
  if (current.length > 0) chunks.push(current.join('\n\n'));
  return chunks;
}

/**
 * One extraction from several. The title, date, provider, type and summary come from the
 * first chunk (a document opens with them); tags and fields are gathered from all. If any
 * chunk could not be read the whole thing counts as failed, since a document missing its
 * later pages would look complete.
 */
export function mergeExtractions(extractions: ExtractionResult[]): ExtractionResult {
  if (extractions.length === 1) return extractions[0];
  if (extractions.some(e => e === EXTRACTION_FALLBACK)) return EXTRACTION_FALLBACK;

  const seen = new Set<string>();
  const fields: ExtractionResult['fields'] = [];
  for (const extraction of extractions) {
    for (const field of extraction.fields) {
      const key = `${field.page_number}|${field.label}|${field.value}`;
      if (!seen.has(key)) { seen.add(key); fields.push(field); }
    }
  }
  return {
    ...extractions[0],
    suggested_tags: [...new Set(extractions.flatMap(e => e.suggested_tags))],
    fields,
  };
}

/** The page a field is on: the page number the model named, or failing that the nearest page of the document. */
function pageFor(pages: PageSummary[], pageNumber: number): PageSummary {
  return pages.find(p => p.page_number === pageNumber)
    ?? pages.reduce((best, p) => (Math.abs(p.page_number - pageNumber) < Math.abs(best.page_number - pageNumber) ? p : best));
}

export interface DocumentReading {
  extraction: ExtractionResult;
  fields: NewExtractedField[];
  /** Normalised and grounded, ready to store. */
  measurements: NewMeasurement[];
}

/** A small share of the context window: the list is a hint, and must never crowd out the document. */
const KNOWN_TESTS_SHARE = 0.05;
const KNOWN_TESTS_MAX = 300;

/** The canonical test names in this user's archive, most-used first, within a budget of characters. */
export async function knownTestNames(userId: string): Promise<string[]> {
  const budget = Math.floor(llmContextChars() * KNOWN_TESTS_SHARE);
  const names = (await getStore().measurements.names(userId)).sort((a, b) => b.count - a.count);
  const out: string[] = [];
  let used = 0;
  for (const { canonical } of names) {
    if (out.length >= KNOWN_TESTS_MAX || used + canonical.length + 2 > budget) break;
    out.push(canonical);
    used += canonical.length + 2;
  }
  return out;
}

export async function readDocument(
  userId: string,
  documentId: string,
  pages: PageSummary[],
  model?: string,
): Promise<DocumentReading> {
  const store = getStore();

  // One after another: a long document is a few chunks at most, and the calls across
  // documents are what run in parallel.
  // The tests already in the archive go with every chunk, so one test is named one way across labs.
  const knownTests = await knownTestNames(userId);
  const extractions: ExtractionResult[] = [];
  // The person's own tags, so a category is not split into near-duplicates by the model's wording.
  const knownTags = (await store.tags.listFor(userId)).map(t => t.name);
  // What the owner wrote on this document helps a new reading, and is kept through it.
  const ownerNotes = (await store.documents.findFor(userId, documentId))?.user_notes ?? null;
  for (const text of chunkPages(pages, llmContextChars())) extractions.push(await extractFields(text, knownTests, model, knownTags, ownerNotes));
  const extraction = mergeExtractions(extractions);

  // Where on its page a supporting phrase is, as a box; null when it cannot be pinned down.
  const locate = async (pageId: string, snippet: string) => {
    const context = await store.pages.findGroundingContext(userId, pageId);
    const box = context
      ? groundSnippet(snippet, context.elements, context.imageWidth, context.imageHeight)
      : { bbox_x0: null, bbox_y0: null, bbox_x1: null, bbox_y1: null };
    return box.bbox_x0 === null || box.bbox_y0 === null || box.bbox_x1 === null || box.bbox_y1 === null
      ? null
      : { x0: box.bbox_x0, y0: box.bbox_y0, x1: box.bbox_x1, y1: box.bbox_y1 };
  };

  // Grounded before any write, so a caller's transaction holds only store calls.
  const fields = await Promise.all(
    extraction.fields.map(async (field): Promise<NewExtractedField> => {
      const page = pageFor(pages, field.page_number);
      return {
        id: uuidv4(),
        documentId,
        pageId: page.id,
        label: field.label,
        value: field.value,
        groupNo: field.group ?? null,
        sourceSnippet: field.source_snippet,
        bbox: await locate(page.id, field.source_snippet),
        confidence: field.confidence,
      };
    }),
  );

  const measurements = await Promise.all(
    normaliseMeasurements(extraction.measurements, extraction.doc_date).map(async (m): Promise<NewMeasurement> => {
      const page = pageFor(pages, m.page_number);
      return {
        id: uuidv4(),
        documentId,
        pageId: page.id,
        name: m.name,
        // A name the owner has merged into another is filed under the other.
        canonical: await store.measurements.resolveCanonical(userId, m.canonical),
        valueText: m.value_text,
        valueNum: m.value_num,
        unit: m.unit,
        refLow: m.ref_low,
        refHigh: m.ref_high,
        flag: m.flag,
        takenOn: m.taken_on,
        sourceSnippet: m.source_snippet,
        bbox: await locate(page.id, m.source_snippet),
        confidence: m.confidence,
      };
    }),
  );
  return { extraction, fields, measurements };
}

/**
 * Everything a reading produced, written into one document: its fields, its measurements, and the
 * doctors it names (added to the directory if new, and linked). Called inside the caller's transaction.
 */
export async function storeReading(tx: Store, userId: string, documentId: string, reading: DocumentReading): Promise<void> {
  // What the owner added, changed or removed is theirs: a new reading does not overwrite it, repeat it or bring it back.
  const [heldFields, heldMeasurements, removedFields, removedMeasurements] = await Promise.all([
    tx.fields.listForDocument(userId, documentId),
    tx.measurements.listForDocument(userId, documentId),
    tx.fields.removedKeys(userId, documentId),
    tx.measurements.removedKeys(userId, documentId),
  ]);
  const fieldSlots = new Set(heldFields.map(f => fieldSlot(f.label, f.group_no)));
  const measurementSlots = new Set(heldMeasurements.map(m => measurementSlot(m.canonical, m.taken_on)));
  for (const field of reading.fields) {
    if (removedFields.has(fieldKey(field.label, field.value)) || fieldSlots.has(fieldSlot(field.label, field.groupNo))) continue;
    await tx.fields.create(userId, field);
  }
  for (const m of reading.measurements) {
    if (removedMeasurements.has(measurementKey(m.canonical, m.valueText, m.takenOn)) || measurementSlots.has(measurementSlot(m.canonical, m.takenOn))) continue;
    await tx.measurements.create(userId, m);
  }

  const now = new Date().toISOString();
  for (const doctor of reading.extraction.doctors) {
    const id = await tx.doctors.upsert(userId, { name: doctor.name, specialty: doctor.specialty, clinic: reading.extraction.provider, licenseCode: doctor.code }, now);
    if (id) await tx.doctors.link(userId, documentId, id, doctor.role);
  }
}

/**
 * An existing document read from its pages' text again. Null, and nothing changed, if the
 * model could not be reached or its answer failed validation: keeping the previous reading
 * is better than writing "extraction failed" over it. This is the part that waits on the
 * model, so documents can be read in parallel.
 */
async function readExisting(userId: string, documentId: string, model?: string): Promise<DocumentReading | null> {
  const store = getStore();
  const doc = await store.documents.findFor(userId, documentId);
  if (!doc) return null;

  // Pages the owner set aside are not read: that is what hiding one is for.
  const pages = (await store.pages.listForSourceFile(userId, doc.source_file_id)).filter(
    p => p.page_number >= doc.page_start && p.page_number <= doc.page_end && !p.hidden,
  );
  if (pages.length === 0) return null;

  try {
    const reading = await readDocument(userId, documentId, pages, model);
    return reading.extraction === EXTRACTION_FALLBACK ? null : reading;
  } catch {
    return null;
  }
}

/**
 * Replaces what was read from a document before: title, date, provider, type, summary, tags and
 * fields, except what the owner set, added or changed by hand (and what they removed stays removed). The owner's notes stay. It is left unreviewed, since what it holds changed. All
 * writes, one transaction.
 */
async function applyReading(userId: string, documentId: string, reading: DocumentReading): Promise<void> {
  const store = getStore();
  const { extraction } = reading;
  await store.transaction(async tx => {
    // The headline the owner set by hand is theirs: only the rest is filled in again.
    const edited = new Set(await tx.documents.editedColumns(userId, documentId));
    const headline = {
      title: extraction.title?.trim() || undefined,
      doc_date: extraction.doc_date ?? undefined,
      provider: extraction.provider ?? undefined,
      doc_type: extraction.doc_type,
      ai_summary: extraction.ai_summary,
    };
    for (const column of Object.keys(headline) as Array<keyof typeof headline>) if (edited.has(column)) delete headline[column];
    await tx.documents.update(userId, documentId, {
      ...headline,
      language: cleanLanguageCode(extraction.language) ?? undefined,
      reviewed: false,
    });
    await tx.tags.setForDocument(userId, documentId, extraction.suggested_tags);
    await tx.fields.deleteUnedited(userId, documentId);
    await tx.measurements.deleteUnedited(userId, documentId);
    await tx.doctors.unlinkRead(userId, documentId); // not what a signature stamp gave: that is not in the text
    await storeReading(tx, userId, documentId, reading);
  });
  scheduleSync(userId); // its meaning may have changed
  scheduleLinking(userId, [documentId]);
}

/** Reads one document again and, if that worked, replaces what it held. */
export async function rereadDocument(userId: string, documentId: string, model?: string): Promise<boolean> {
  const reading = await readExisting(userId, documentId, model);
  if (!reading) return false;
  await applyReading(userId, documentId, reading);
  return true;
}

/**
 * Several documents read again. The model calls run in parallel, up to the concurrency
 * setting; the writes then happen one after another. Whether each one worked, in the order given.
 */
export async function rereadDocuments(userId: string, documentIds: string[], model?: string): Promise<boolean[]> {
  const readings = await mapLimit(documentIds, llmConcurrency(), id => readExisting(userId, id, model));
  const done: boolean[] = [];
  for (const [i, reading] of readings.entries()) {
    if (reading) await applyReading(userId, documentIds[i], reading);
    done.push(reading !== null);
  }
  return done;
}

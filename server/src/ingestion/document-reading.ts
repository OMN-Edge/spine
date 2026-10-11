import { v4 as uuidv4 } from 'uuid';
import { getStore, type NewExtractedField, type PageSummary } from '../store/index.js';
import { extractFields } from './extraction.js';
import { groundSnippet } from './grounding.js';
import { EXTRACTION_FALLBACK } from '../llm/types.js';
import { llmConcurrency, llmContextChars } from '../config.js';
import { mapLimit } from '../concurrency.js';
import type { ExtractionResult } from '../types.js';

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
}

export async function readDocument(
  userId: string,
  documentId: string,
  pages: PageSummary[],
): Promise<DocumentReading> {
  const store = getStore();

  // One after another: a long document is a few chunks at most, and the calls across
  // documents are what run in parallel.
  const extractions: ExtractionResult[] = [];
  for (const text of chunkPages(pages, llmContextChars())) extractions.push(await extractFields(text));
  const extraction = mergeExtractions(extractions);

  // Grounded before any write, so a caller's transaction holds only store calls.
  const fields = await Promise.all(
    extraction.fields.map(async field => {
      const page = pageFor(pages, field.page_number);
      const context = await store.pages.findGroundingContext(userId, page.id);
      const box = context
        ? groundSnippet(field.source_snippet, context.elements, context.imageWidth, context.imageHeight)
        : { bbox_x0: null, bbox_y0: null, bbox_x1: null, bbox_y1: null };

      return {
        id: uuidv4(),
        documentId,
        pageId: page.id,
        label: field.label,
        value: field.value,
        sourceSnippet: field.source_snippet,
        bbox:
          box.bbox_x0 === null || box.bbox_y0 === null || box.bbox_x1 === null || box.bbox_y1 === null
            ? null
            : { x0: box.bbox_x0, y0: box.bbox_y0, x1: box.bbox_x1, y1: box.bbox_y1 },
        confidence: field.confidence,
      };
    }),
  );
  return { extraction, fields };
}

/**
 * An existing document read from its pages' text again. Null, and nothing changed, if the
 * model could not be reached or its answer failed validation: keeping the previous reading
 * is better than writing "extraction failed" over it. This is the part that waits on the
 * model, so documents can be read in parallel.
 */
async function readExisting(userId: string, documentId: string): Promise<DocumentReading | null> {
  const store = getStore();
  const doc = await store.documents.findFor(userId, documentId);
  if (!doc) return null;

  const pages = (await store.pages.listForSourceFile(userId, doc.source_file_id)).filter(
    p => p.page_number >= doc.page_start && p.page_number <= doc.page_end,
  );
  if (pages.length === 0) return null;

  try {
    const reading = await readDocument(userId, documentId, pages);
    return reading.extraction === EXTRACTION_FALLBACK ? null : reading;
  } catch {
    return null;
  }
}

/**
 * Replaces what was read from a document before: title, date, provider, type, summary, tags and
 * fields. The owner's notes stay. It is left unreviewed, since what it holds changed. All
 * writes, one transaction.
 */
async function applyReading(userId: string, documentId: string, reading: DocumentReading): Promise<void> {
  const store = getStore();
  const { extraction, fields } = reading;
  await store.transaction(async tx => {
    await tx.documents.update(userId, documentId, {
      title: extraction.title?.trim() || undefined,
      doc_date: extraction.doc_date ?? undefined,
      provider: extraction.provider ?? undefined,
      doc_type: extraction.doc_type,
      ai_summary: extraction.ai_summary,
      reviewed: false,
    });
    await tx.tags.setForDocument(userId, documentId, extraction.suggested_tags);
    await tx.fields.deleteForDocument(userId, documentId);
    for (const field of fields) await tx.fields.create(userId, field);
  });
}

/** Reads one document again and, if that worked, replaces what it held. */
export async function rereadDocument(userId: string, documentId: string): Promise<boolean> {
  const reading = await readExisting(userId, documentId);
  if (!reading) return false;
  await applyReading(userId, documentId, reading);
  return true;
}

/**
 * Several documents read again. The model calls run in parallel, up to the concurrency
 * setting; the writes then happen one after another. Whether each one worked, in the order given.
 */
export async function rereadDocuments(userId: string, documentIds: string[]): Promise<boolean[]> {
  const readings = await mapLimit(documentIds, llmConcurrency(), id => readExisting(userId, id));
  const done: boolean[] = [];
  for (const [i, reading] of readings.entries()) {
    if (reading) await applyReading(userId, documentIds[i], reading);
    done.push(reading !== null);
  }
  return done;
}

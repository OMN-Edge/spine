import { getStore } from '../store/index.js';
import { getModelParser, getParser } from '../parser/index.js';
import { rereadDocuments } from './document-reading.js';
import { llmConcurrency } from '../config.js';
import { mapLimit } from '../concurrency.js';
import type { Page, UnstructuredElement } from '../types.js';
import { describeError } from '../failure.js';
import { logger } from '../logger.js';

/**
 * Reading chosen pages of an upload with the model, then re-extracting the documents
 * those pages belong to. The page-level and document-level versions of "Read with AI":
 * where the whole-file button sends every page and replaces every document, this sends
 * only the pages asked for and replaces only the documents that contain them.
 *
 * The images go through `getModelParser()`, the same adapter and the same operator
 * switch as every other path that sends an image (SECURITY.md M-7), so there is still
 * one place that decides whether an image can leave.
 *
 * It runs in the background, one job per upload, polled by the browser. In memory: a
 * restart forgets a job in flight, which at worst leaves some page text newer than the
 * details extracted from it; re-extracting the document fixes that.
 */
export interface AiReadingJob {
  source_file_id: string;
  status: 'running' | 'done' | 'failed';
  progress: number; // 0-100
  step: string;
  pages_total: number;
  pages_read: number;
  /** Documents re-extracted from the new text. */
  documents_updated: number;
  /** Documents whose page text changed but whose details could not be extracted again. */
  documents_not_updated: number;
  error?: string;
}

const jobs = new Map<string, AiReadingJob>();

export function getAiReading(sourceFileId: string): AiReadingJob | null {
  return jobs.get(sourceFileId) ?? null;
}

export function isReadingPages(sourceFileId: string): boolean {
  return jobs.get(sourceFileId)?.status === 'running';
}

/** Tests only. */
export function resetAiReadings(): void {
  jobs.clear();
}

/**
 * How the pages are read. `model`: each page's image goes to the model, which is "Read page with AI".
 * `configured`: the way an upload reads them, with the parser the operator set (the text layer, then
 * OCR, then a model for what is left, or whatever it is), which is "Read whole document": the pages
 * keep their grouping and are read once, together, and the details are extracted again.
 */
export type ReadingStrategy = 'model' | 'configured';

export function startAiReading(userId: string, sourceFileId: string, pageIds: string[], model?: string, strategy: ReadingStrategy = 'model', thinking = false): AiReadingJob {
  const job: AiReadingJob = {
    source_file_id: sourceFileId,
    status: 'running',
    progress: 0,
    step: 'starting',
    pages_total: pageIds.length,
    pages_read: 0,
    documents_updated: 0,
    documents_not_updated: 0,
  };
  jobs.set(sourceFileId, job);

  run(userId, sourceFileId, pageIds, job, model, strategy, thinking).catch(err => {
    job.status = 'failed';
    job.step = 'failed';
    job.error = describeError(err);
    logger.error('reading pages with the model failed', { sourceFileId, error: job.error });
  });
  return job;
}

async function run(userId: string, sourceFileId: string, pageIds: string[], job: AiReadingJob, model?: string, strategy: ReadingStrategy = 'model', thinking = false): Promise<void> {
  const store = getStore();
  const upload = await store.sourceFiles.findFor(userId, sourceFileId);
  if (!upload) throw new Error('upload not found');

  const known = await store.pages.listForSourceFile(userId, sourceFileId);
  const wanted = pageIds.map(id => known.find(p => p.id === id));
  if (wanted.some(p => !p)) throw new Error('a page to read is not part of this upload');
  const pages = wanted as typeof known;

  // Read every page before changing anything, so a page that cannot be read leaves the upload exactly as it was.
  type Reading = { pageId: string; rawText: string; elements: UnstructuredElement[]; source: Page['extraction_source'] };
  let readings: Reading[];

  if (strategy === 'configured') {
    // The way an upload reads: one call for the pages together (a PDF is parsed once, not once a page), by the
    // configured parser; a photo has no text layer, so it goes to the model, as at upload.
    const parser = upload.mime_type?.startsWith('image/') ? getModelParser(model, thinking) : getParser(model);
    job.step = pages.length === 1 ? `reading page ${pages[0].page_number}` : `reading ${pages.length} pages`;
    job.progress = 5;
    const input = [];
    for (const page of pages) {
      const imagePath = await store.pages.findImagePathFor(userId, page.id);
      if (!imagePath) throw new Error(`page ${page.page_number} has no image to read`);
      // The parser counts pages of the file, and a page may have been moved since: ask for it by that.
      input.push({ page_number: page.source_page, image_path: imagePath });
    }
    const result = await parser.parse({ sourceFileId, filePath: upload.file_path, pages: input });

    readings = [];
    for (const page of pages) {
      const read = result.pages.find(r => r.page_number === page.source_page);
      if (!read) throw new Error(`page ${page.page_number} could not be read`);
      // Nothing read where something was before: the earlier reading is better than none.
      if (read.extraction_source === 'unread' && (page.raw_text ?? '').trim()) continue;
      readings.push({ pageId: page.id, rawText: read.elements.map(e => e.text).join('\n'), elements: read.elements, source: read.extraction_source });
    }
    job.pages_read = readings.length;
    job.progress = 70;
  } else {
    // One image per call, several calls at once.
    const parser = getModelParser(model, thinking);
    let done = 0;
    readings = await mapLimit(pages, llmConcurrency(), async page => {
      job.step = `reading ${pages.length === 1 ? `page ${page.page_number}` : `${pages.length} pages`}`;
      const imagePath = await store.pages.findImagePathFor(userId, page.id);
      if (!imagePath) throw new Error(`page ${page.page_number} has no image to read`);

      const result = await parser.parse({
        sourceFileId,
        filePath: upload.file_path,
        pages: [{ page_number: page.source_page, image_path: imagePath }],
      });
      const read = result.pages[0];
      if (!read) throw new Error(`page ${page.page_number} could not be read`);

      done += 1;
      job.pages_read = done;
      job.progress = Math.floor((done / pages.length) * 70);
      return { pageId: page.id, rawText: read.elements.map(e => e.text).join('\n'), elements: read.elements, source: 'multimodal' as const };
    });
  }

  job.step = 'saving the new text';
  job.progress = 72;
  await store.transaction(async tx => {
    for (const r of readings) {
      await tx.pages.updateReading(userId, r.pageId, { rawText: r.rawText, elements: r.elements, extractionSource: r.source });
    }
  });

  // Only the documents that contain a page that was read.
  const numbers = pages.map(p => p.page_number);
  const documents = (await store.documents.listFor(userId, { sourceFileId, limit: 1000, offset: 0 }))
    .filter(d => numbers.some(n => n >= d.page_start && n <= d.page_end));

  job.step = documents.length === 1 ? 'extracting the document again' : `extracting ${documents.length} documents again`;
  job.progress = 75;
  const worked = await rereadDocuments(userId, documents.map(d => d.id), model);
  job.documents_updated = worked.filter(Boolean).length;
  job.documents_not_updated = worked.length - job.documents_updated;

  job.status = 'done';
  job.step = 'complete';
  job.progress = 100;
}

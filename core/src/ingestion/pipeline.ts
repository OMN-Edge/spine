import { v4 as uuidv4 } from 'uuid';
import { getStore, getAccountsStore } from '../store/index.js';
import { rasterizePdf } from './rasterize.js';
import { demoLimits } from '../demo/limits.js';
import { extractPdfPages } from '../archive/pdf-pages.js';
import { fileSystem } from '../files.js';
import { normalisePhoto } from './photo.js';
import { readsByModel } from '../file-kind.js';
import { logger } from '../logger.js';
import { announceUploadLater } from '../chat/notices.js';
import { aiReadingAllowed, getModelParser, getParser } from '../parser/index.js';
import { checkContinuation } from './continuation.js';
import { llmConcurrency } from '../config.js';
import { mapLimit } from '../concurrency.js';
import { beginJob, getJobStatus, runQueued } from './jobs.js';
import type { JobStatus, UnstructuredElement } from '../types.js';
import { describeError } from '../failure.js';

export { getJobStatus };

/**
 * Fail over any source_file left mid-flight by a previous process.
 *
 * Progress lives in the in-memory registry above, so a restart loses it.
 * Rows still marked 'pending' or 'processing' have no job behind them and
 * would otherwise poll forever in the review queue. Safe to call only at
 * startup, before any job is registered.
 */
export async function reconcileStalledJobs(): Promise<number> {
  return getAccountsStore().maintenance.failStalledSourceFiles();
}

export interface IngestionOptions {
  /**
   * Run an upload that failed again, the way it was first read. What the failed attempt left behind
   * is removed only once this one has succeeded, so a second failure leaves it as it was.
   */
  retry?: boolean;
}

export function startIngestionJob(sourceFileId: string, userId: string, options: IngestionOptions = {}): void {
  const job = beginJob(sourceFileId);
  if (!job) return;

  // Fire-and-forget; errors are captured in the job record
  runQueued(() => runPipeline(sourceFileId, userId, job, options)).catch(() => {});
}

async function runPipeline(
  sourceFileId: string,
  userId: string,
  job: JobStatus,
  options: IngestionOptions,
): Promise<void> {
  const store = getStore();

  const sourceFile = await store.sourceFiles.findFor(userId, sourceFileId);
  if (!sourceFile) throw new Error(`source_file ${sourceFileId} not found`);

  try {
    await store.sourceFiles.setStatus(userId, sourceFileId, 'processing');

    // A photo is one page that has no text to find locally, so it goes straight to the model; it is
    // not tried against OCR first. That sends the image off the host, which only the operator's switch allows.
    const isPhoto = sourceFile.mime_type?.startsWith('image/') ?? false;
    const byModel = readsByModel(sourceFile); // a photo, or photos bundled into a PDF
    if (byModel && !aiReadingAllowed()) {
      throw new Error('a photo can only be read by the model, and image reading is switched off on this server');
    }

    // Step 1: Rasterize pages
    job.step = isPhoto ? 'preparing the photo' : 'rasterizing';
    job.progress = 5;
    const pageImages = isPhoto
      ? await normalisePhoto(sourceFileId, sourceFile.file_path)
      : await rasterizePdf(sourceFileId, sourceFile.file_path);
    // The demo reads the first pages of a file only: what is past them is not parsed, stored or sent to a model.
    const limits = demoLimits();
    if (limits && pageImages.length > limits.pages) {
      for (const dropped of pageImages.splice(limits.pages)) fileSystem().rmSync(dropped.image_path);
      // The file kept is the pages read, so the upload and what an export of it carries agree (a restore counts the file's pages).
      if (!isPhoto) fileSystem().writeFileSync(sourceFile.file_path, await extractPdfPages(sourceFile.file_path, pageImages.map(image => image.page_number)));
    }
    await store.sourceFiles.setPageCount(userId, sourceFileId, pageImages.length);

    // Step 2: Parse. Which parser runs — the local sidecar, a vision model, or the
    // sidecar with the model for the pages it is bad at — is configuration. Either
    // way: one entry per page image, boxes in that image's pixel space.
    job.step = 'parsing';
    job.progress = 20;
    const parser = byModel ? getModelParser() : getParser();
    const parseResult = await parser.parse({
      sourceFileId,
      filePath: sourceFile.file_path,
      pages: pageImages,
    });

    // Step 3: Decide where documents begin, then store the pages. Each pair of neighbouring
    // pages is judged on those two pages' text alone, so the checks run several at a time
    // (SPINE_LLM_CONCURRENCY); the writes, below, stay in order.
    job.step = 'detecting boundaries';
    const parsed = parseResult.pages.map(p => {
      const imageInfo = pageImages.find(image => image.page_number === p.page_number);
      if (!imageInfo) throw new Error(`the parser returned page ${p.page_number}, which has no image`);
      return { ...p, image_path: imageInfo.image_path, raw_text: p.elements.map((e: UnstructuredElement) => e.text).join('\n') };
    });

    const concurrency = llmConcurrency();
    let checked = 0;
    const continuations = await mapLimit(parsed.slice(1), concurrency, async (page, k) => {
      const result = await checkContinuation(parsed[k].raw_text, page.raw_text);
      checked += 1;
      job.progress = 20 + Math.floor((checked / Math.max(1, parsed.length - 1)) * 30);
      return result;
    });

    // Everything that can fail on the model's side has now succeeded. Only now remove the old
    // documents, so a provider outage or a page the model could not read leaves them untouched.
    if (options.retry) await store.sourceFiles.clearDerived(userId, sourceFileId);

    for (const [i, page] of parsed.entries()) {
      const continuation = i > 0 ? continuations[i - 1] : null;
      await store.pages.create(userId, {
        id: uuidv4(),
        sourceFileId,
        pageNumber: page.page_number,
        imagePath: page.image_path,
        imageWidth: page.image_width,
        imageHeight: page.image_height,
        rawText: page.raw_text,
        elements: page.elements,
        extractionSource: page.extraction_source,
        isContinuation: continuation ? continuation.is_continuation : null,
        continuationConfidence: continuation ? continuation.confidence : null,
        continuationReasoning: continuation ? continuation.reasoning : null,
      });
      job.progress = 50 + Math.floor(((i + 1) / parsed.length) * 10);
    }

    // Step 4: Group pages into logical documents
    job.step = 'grouping documents';
    job.progress = 60;

    const allPages = await store.pages.listForSourceFile(userId, sourceFileId);

    const documentRanges: Array<{ start: number; end: number; pageIds: string[] }> = [];
    let currentDoc: { start: number; end: number; pageIds: string[] } | null = null;

    for (const page of allPages) {
      if (page.is_continuation && currentDoc) {
        currentDoc.end = page.page_number;
        currentDoc.pageIds.push(page.id);
      } else {
        if (currentDoc) documentRanges.push(currentDoc);
        currentDoc = { start: page.page_number, end: page.page_number, pageIds: [page.id] };
      }
    }
    if (currentDoc) documentRanges.push(currentDoc);

    // Step 5: The documents, as the pages were grouped. Nothing is read from their text yet: that is the second stage
    // (read-upload.ts), once the owner has confirmed the grouping, so a grouping that is fixed by hand is not read
    // several times. Until then a document has no title or details, only its pages.
    job.step = 'making documents';
    job.progress = 90;
    for (const range of documentRanges) {
      await store.documents.create(userId, { id: uuidv4(), sourceFileId, pageStart: range.start, pageEnd: range.end, needsReading: true });
    }

    // The documents wait, out of the timeline, search and shares, until the owner has checked how the pages were grouped
    // (POST /api/source-files/:id/grouping/confirm); that is also when the documents are read, vectors are made and links are looked for. Set
    // before the upload counts as done, so there is no moment when it is done and shown.
    await store.sourceFiles.setGroupingConfirmed(userId, sourceFileId, false);
    await store.sourceFiles.setStatus(userId, sourceFileId, 'done');
    job.status = 'done';
    job.progress = 100;
    job.step = 'complete';
    announceUploadLater(userId, sourceFileId);
  } catch (err) {
    const msg = describeError(err);
    logger.error('an upload failed', { sourceFileId, error: msg });
    await store.sourceFiles.setStatus(userId, sourceFileId, 'error', msg);
    job.status = 'error';
    job.step = 'failed';
    job.error = msg;
    announceUploadLater(userId, sourceFileId);
  }
}

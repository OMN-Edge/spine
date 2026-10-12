import { v4 as uuidv4 } from 'uuid';
import { getStore } from '../store/index.js';
import { rasterizePdf } from './rasterize.js';
import { getModelParser, getParser } from '../parser/index.js';
import { checkContinuation } from './continuation.js';
import { readDocument, storeReading } from './document-reading.js';
import { llmConcurrency } from '../config.js';
import { mapLimit } from '../concurrency.js';
import type { JobStatus, UnstructuredElement } from '../types.js';

// Simple in-memory job registry — sufficient for single-user
const jobs = new Map<string, JobStatus>();

export function getJobStatus(sourceFileId: string): JobStatus | null {
  return jobs.get(sourceFileId) ?? null;
}

/**
 * Fail over any source_file left mid-flight by a previous process.
 *
 * Progress lives in the in-memory registry above, so a restart loses it.
 * Rows still marked 'pending' or 'processing' have no job behind them and
 * would otherwise poll forever in the review queue. Safe to call only at
 * startup, before any job is registered.
 */
export async function reconcileStalledJobs(): Promise<number> {
  return getStore().maintenance.failStalledSourceFiles();
}

export interface IngestionOptions {
  /**
   * Read the file again with the model for every page, replacing what it produced.
   * The "Read with AI" button. The old documents are removed only after the new
   * reading has succeeded, so a failed attempt leaves them as they were.
   */
  reread?: boolean;
}

export function startIngestionJob(sourceFileId: string, userId: string, options: IngestionOptions = {}): void {
  if (jobs.get(sourceFileId)?.status === 'processing') return;

  const job: JobStatus = {
    source_file_id: sourceFileId,
    status: 'processing',
    progress: 0,
    step: 'starting',
  };
  jobs.set(sourceFileId, job);

  // Fire-and-forget; errors are captured in the job record
  runPipeline(sourceFileId, userId, job, options).catch(() => {});
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

    // Step 1: Rasterize pages
    job.step = 'rasterizing';
    job.progress = 5;
    const pageImages = await rasterizePdf(sourceFileId, sourceFile.file_path);
    await store.sourceFiles.setPageCount(userId, sourceFileId, pageImages.length);

    // Step 2: Parse. Which parser runs — the local sidecar, a vision model, or the
    // sidecar with the model for the pages it is bad at — is configuration. Either
    // way: one entry per page image, boxes in that image's pixel space.
    job.step = 'parsing';
    job.progress = 20;
    const parser = options.reread ? getModelParser() : getParser();
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
    if (options.reread) await store.sourceFiles.clearDerived(userId, sourceFileId);

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

    // Step 5: Read each document. The reads wait on the model and are independent, so they run
    // several at a time; each document, its tags and its fields are then written as one unit,
    // one after another, so no partial write leaves a document with no fields and no error.
    job.step = 'extracting fields';
    let read = 0;
    const readings = await mapLimit(documentRanges, concurrency, async range => {
      const docId = uuidv4();
      const reading = await readDocument(
        userId,
        docId,
        allPages.filter(p => p.page_number >= range.start && p.page_number <= range.end),
      );
      read += 1;
      job.progress = 60 + Math.floor((read / documentRanges.length) * 30);
      return { docId, range, ...reading };
    });

    for (const [di, { docId, range, ...reading }] of readings.entries()) {
      const { extraction } = reading;
      await store.transaction(async tx => {
        await tx.documents.create(userId, {
          id: docId,
          sourceFileId,
          pageStart: range.start,
          pageEnd: range.end,
          // An empty title is no title: the UI then falls back to type and provider.
          title: extraction.title?.trim() || null,
          docDate: extraction.doc_date,
          provider: extraction.provider,
          docType: extraction.doc_type,
          aiSummary: extraction.ai_summary,
        });

        await tx.tags.setForDocument(userId, docId, extraction.suggested_tags);
        await storeReading(tx, userId, docId, reading);
      });

      job.progress = 90 + Math.floor(((di + 1) / readings.length) * 8);
    }

    await store.sourceFiles.setStatus(userId, sourceFileId, 'done');
    job.status = 'done';
    job.progress = 100;
    job.step = 'complete';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await store.sourceFiles.setStatus(userId, sourceFileId, 'error', msg);
    job.status = 'error';
    job.step = 'failed';
    job.error = msg;
  }
}

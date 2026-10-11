import { v4 as uuidv4 } from 'uuid';
import { getStore } from '../store/index.js';
import { rasterizePdf } from './rasterize.js';
import { getModelParser, getParser } from '../parser/index.js';
import { checkContinuation } from './continuation.js';
import { extractFields } from './extraction.js';
import { groundSnippet } from './grounding.js';
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
    const pageCount = pageImages.length;
    await store.sourceFiles.setPageCount(userId, sourceFileId, pageCount);

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

    // The new reading is in hand. Only now remove the old documents, so a failure above
    // — a provider outage, a page the model could not read — leaves them untouched.
    if (options.reread) await store.sourceFiles.clearDerived(userId, sourceFileId);

    // Step 3: Store pages + run continuation checks
    job.step = 'detecting boundaries';
    const pageRows: Array<{ id: string; page_number: number; raw_text: string }> = [];

    for (let i = 0; i < parseResult.pages.length; i++) {
      const p = parseResult.pages[i];
      const { page_number, elements, extraction_source } = p;
      const imageInfo = pageImages.find(image => image.page_number === page_number);
      if (!imageInfo) throw new Error(`the parser returned page ${page_number}, which has no image`);
      const { image_width: width, image_height: height } = p;

      const rawText = elements.map((e: UnstructuredElement) => e.text).join('\n');
      const pageId = uuidv4();

      let is_continuation: boolean | null = null;
      let confidence: number | null = null;
      let reasoning: string | null = null;

      if (i > 0) {
        const prev = pageRows[i - 1];
        const result = await checkContinuation(prev.raw_text, rawText);
        is_continuation = result.is_continuation;
        confidence = result.confidence;
        reasoning = result.reasoning;
      }

      await store.pages.create(userId, {
        id: pageId,
        sourceFileId,
        pageNumber: page_number,
        imagePath: imageInfo.image_path,
        imageWidth: width,
        imageHeight: height,
        rawText,
        elements,
        extractionSource: extraction_source,
        isContinuation: is_continuation,
        continuationConfidence: confidence,
        continuationReasoning: reasoning,
      });

      pageRows.push({ id: pageId, page_number, raw_text: rawText });
      job.progress = 20 + Math.floor(((i + 1) / pageCount) * 40);
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

    // Step 5: Extract fields per document
    job.step = 'extracting fields';
    for (let di = 0; di < documentRanges.length; di++) {
      const range = documentRanges[di];
      const docText = allPages
        .filter(p => p.page_number >= range.start && p.page_number <= range.end)
        .map(p => p.raw_text)
        .join('\n\n--- page break ---\n\n');

      const extraction = await extractFields(docText);
      const docId = uuidv4();

      // Ground every field before the write, so the transaction below contains
      // only store calls — no model or filesystem work inside a held
      // transaction, and SQLite is single-writer.
      const groundedFields = await Promise.all(
        extraction.fields.map(async field => {
          const targetPageIndex = field.page_number - range.start;
          const pageId = range.pageIds[
            Math.max(0, Math.min(targetPageIndex, range.pageIds.length - 1))
          ];
          const context = await store.pages.findGroundingContext(userId, pageId);

          const box = context
            ? groundSnippet(field.source_snippet, context.elements, context.imageWidth, context.imageHeight)
            : { bbox_x0: null, bbox_y0: null, bbox_x1: null, bbox_y1: null };

          return {
            id: uuidv4(),
            documentId: docId,
            pageId,
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

      // A document, its tags and its fields are one unit: a partial write
      // leaves a document with no fields and no error to explain it.
      await store.transaction(async tx => {
        await tx.documents.create(userId, {
          id: docId,
          sourceFileId,
          pageStart: range.start,
          pageEnd: range.end,
          docDate: extraction.doc_date,
          provider: extraction.provider,
          docType: extraction.doc_type,
          aiSummary: extraction.ai_summary,
        });

        await tx.tags.setForDocument(userId, docId, extraction.suggested_tags);

        for (const field of groundedFields) {
          await tx.fields.create(userId, field);
        }
      });

      job.progress = 60 + Math.floor(((di + 1) / documentRanges.length) * 38);
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

import type { FastifyInstance } from 'fastify';
import { rmSync } from 'fs';
import path from 'path';
import { getStore } from '../store/index.js';
import { getJobStatus } from '../ingestion/pipeline.js';
import { acceptFile, newUploadPath, retryFailedUpload, saveStream } from '../ingestion/accept-upload.js';
import { importZip } from '../archive/import.js';
import { similarityEnabled } from '../similarity/index.js';
import { removeUploadFiles } from '../ingestion/remove-upload.js';
import { rereadDocuments } from '../ingestion/document-reading.js';
import { scheduleLinking } from '../linking/index.js';
import { scheduleSync } from '../similarity/index.js';
import { aiReadingAllowed, getParser } from '../parser/index.js';
import { getAiReading, isReadingPages, startAiReading } from '../ingestion/ai-reading.js';
import { loadLlmConfig, loadParserConfig } from '../config.js';
import { chooseModel } from '../llm/index.js';
import { requireAuth } from './middleware.js';
import type { Document } from '../types.js';


/** What a client needs to name and place one document of an upload. */
function documentSummary(doc: Document) {
  return {
    id: doc.id, title: doc.title, doc_type: doc.doc_type, doc_date: doc.doc_date, provider: doc.provider,
    page_start: doc.page_start, page_end: doc.page_end, reviewed: doc.reviewed,
  };
}

/** A document or a photo. */
const MAX_FILE_BYTES = 200 * 1024 * 1024;
/** A zip of them, which the request limit in `index.ts` must allow. */
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

/** One request cannot ask for an unbounded number of images to be sent. */
const MAX_PAGES_PER_READING = 200;

export async function sourceFileRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  // Every upload, newest first, with what it became, so the history can name each upload
  // by its documents and link to regrouping its pages.
  app.get('/api/source-files', async (req, reply) => {
    const store = getStore();
    const uploads = await store.sourceFiles.listFor(req.userId);
    const withDocuments = await Promise.all(
      uploads.map(async upload => {
        // The upload's own screens show its documents before the owner has confirmed the grouping; only set-aside ones are left out.
        const filter = { sourceFileId: upload.id, limit: 1000, offset: 0, includeUnconfirmed: true };
        const documents = (await store.documents.listFor(req.userId, filter))
          .sort((a, b) => a.page_start - b.page_start)
          .map(documentSummary);
        // Documents whose every page the owner hid are not listed, but the card says how many there are,
        // so an upload that is nothing but hidden pages can still be opened and brought back.
        const everything = await store.documents.listFor(req.userId, { ...filter, includeHidden: true });
        return { ...upload, documents, hidden_documents: everything.length - documents.length };
      }),
    );
    return reply.send(withDocuments.sort((a, b) => b.uploaded_at.localeCompare(a.uploaded_at)));
  });

  // One upload's pages and how they are grouped into documents: what the regrouping
  // screen draws. Page images come from /api/pages/:id/image, as everywhere else.
  app.get<{ Params: { id: string } }>('/api/source-files/:id', async (req, reply) => {
    const store = getStore();
    const upload = await store.sourceFiles.findFor(req.userId, req.params.id);
    if (!upload) return reply.status(404).send({ error: 'not found' });

    const pages = await store.pages.listForSourceFile(req.userId, upload.id);
    const documents = await store.documents.listFor(req.userId, { sourceFileId: upload.id, limit: 1000, offset: 0, includeHidden: true });
    return reply.send({
      id: upload.id,
      uploaded_at: upload.uploaded_at,
      status: upload.status,
      error_message: upload.error_message,
      page_count: upload.page_count,
      grouping_confirmed: upload.grouping_confirmed,
      pages: pages.map(p => ({
        id: p.id, page_number: p.page_number, image_width: p.image_width,
        image_height: p.image_height, extraction_source: p.extraction_source, hidden: !!p.hidden, source_page: p.source_page,
      })),
      // Every document, with whether the owner has hidden all of its pages: this screen is where that is undone.
      documents: documents.sort((a, b) => a.page_start - b.page_start).map(doc => {
        const held = pages.filter(p => p.page_number >= doc.page_start && p.page_number <= doc.page_end);
        return { ...documentSummary(doc), hidden: held.length > 0 && held.every(p => p.hidden) };
      }),
    });
  });

  app.post('/api/source-files/upload', async (req, reply) => {
    const parts = req.parts();
    const results: unknown[] = [];

    for await (const part of parts) {
      if (part.type !== 'file') continue;

      const ext = path.extname(part.filename ?? '.pdf') || '.pdf';
      const { fileId, filePath } = newUploadPath(req.userId, ext);
      // A zip may hold many files, so the request limit is its limit; anything else is one document or photo.
      const { checksum, truncated, zip } = await saveStream(part.file, filePath, { zip: MAX_UPLOAD_BYTES, other: MAX_FILE_BYTES });

      if (zip) {
        try {
          if (truncated) results.push({ skipped: true, reason: 'too_large', filename: part.filename ?? null });
          else results.push(...(await importZip(req.userId, filePath, part.filename ?? null)));
        } finally {
          rmSync(filePath, { force: true }); // the zip itself is not kept: its contents are
        }
        continue;
      }
      if (truncated) {
        rmSync(filePath, { force: true });
        results.push({ skipped: true, reason: 'too_large', filename: part.filename ?? null });
        continue;
      }
      results.push(await acceptFile(req.userId, { id: fileId, path: filePath, filename: part.filename ?? null, checksum }));
    }

    return reply.send(results);
  });

  // Try a failed upload again, as it was first read. No image is sent unless it would have been the first time.
  app.post<{ Params: { id: string } }>('/api/source-files/:id/retry', async (req, reply) => {
    const outcome = await retryFailedUpload(req.userId, req.params.id);
    if (outcome === 'not_found') return reply.status(404).send({ error: 'not found' });
    if (outcome === 'not_failed') return reply.status(409).send({ error: 'only an upload that failed can be tried again' });
    return reply.status(202).send({ id: req.params.id, status: 'processing' });
  });

  // Delete an upload and everything made from it: its documents, fields and measurements, the page
  // images, the original and the backup mirror's copy. Not while it is being read, which would write rows
  // for an upload that no longer exists.
  app.delete<{ Params: { id: string } }>('/api/source-files/:id', async (req, reply) => {
    const { id } = req.params;
    const store = getStore();
    const file = await store.sourceFiles.findFor(req.userId, id);
    if (!file) return reply.status(404).send({ error: 'not found' });
    if (file.status === 'pending' || file.status === 'processing' || getJobStatus(id)?.status === 'processing' || isReadingPages(id)) {
      return reply.status(409).send({ error: 'this file is still being processed' });
    }
    removeUploadFiles(req.userId, file);
    await store.sourceFiles.delete(req.userId, id);
    return reply.send({ deleted: true });
  });

  // The owner has checked how the pages were grouped and it is right. Until then the upload's documents are out of the
  // timeline, search, shares and trends. Now they appear, are embedded and are looked at for links.
  app.post<{ Params: { id: string } }>('/api/source-files/:id/grouping/confirm', async (req, reply) => {
    const { id } = req.params;
    const store = getStore();
    const file = await store.sourceFiles.findFor(req.userId, id);
    if (!file) return reply.status(404).send({ error: 'not found' });
    if (file.status !== 'done' || getJobStatus(id)?.status === 'processing' || isReadingPages(id)) {
      return reply.status(409).send({ error: 'this file is not ready to be confirmed' });
    }
    if (!file.grouping_confirmed) {
      await store.sourceFiles.setGroupingConfirmed(req.userId, id, true);
      scheduleSync(req.userId);
      scheduleLinking(req.userId, (await store.documents.listFor(req.userId, { sourceFileId: id, limit: 1000, offset: 0 })).map(d => d.id));
    }
    return reply.send({ confirmed: true });
  });

  // Extract the details of some of an upload's documents again, from the text already read (no image
  // is sent). The "Done" of regrouping: the splits and joins were saved without reading, and this reads
  // every document they touched once.
  app.post<{ Params: { id: string }; Body: { document_ids?: unknown } }>('/api/source-files/:id/extract', async (req, reply) => {
    const { id } = req.params;
    const store = getStore();
    const file = await store.sourceFiles.findFor(req.userId, id);
    if (!file) return reply.status(404).send({ error: 'not found' });

    const ids = req.body?.document_ids;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 500 || ids.some(x => typeof x !== 'string') || new Set(ids).size !== ids.length) {
      return reply.status(400).send({ error: 'document_ids must be 1 to 500 different document ids' });
    }
    if (file.status === 'pending' || file.status === 'processing' || getJobStatus(id)?.status === 'processing' || isReadingPages(id)) {
      return reply.status(409).send({ error: 'this file is still being processed' });
    }
    for (const documentId of ids as string[]) {
      const doc = await store.documents.findFor(req.userId, documentId);
      if (!doc || doc.source_file_id !== id) return reply.status(404).send({ error: 'document not found in this upload' });
    }

    // A document whose every page is hidden has nothing to read: it is skipped, not failed, and stays as it is.
    const readable: string[] = [];
    for (const documentId of ids as string[]) {
      if ((await store.pages.listForDocument(req.userId, documentId)).length > 0) readable.push(documentId);
    }
    const worked = await rereadDocuments(req.userId, readable);
    const outcome = new Map(readable.map((documentId, i) => [documentId, worked[i] ? 'done' : 'failed'] as const));
    return reply.send({ results: (ids as string[]).map(documentId => ({ id: documentId, reread: outcome.get(documentId) ?? 'skipped' })) });
  });

  // What the page needs to offer "Read with AI", and to say where the images would go.
  app.get('/api/capabilities', async (_req, reply) => {
    const llm = loadLlmConfig();
    const parser = loadParserConfig();
    return reply.send({
      aiReading: { enabled: aiReadingAllowed(), provider: llm.provider, endpoint: llm.endpoint ?? null },
      // Whether documents can be found by meaning (embeddings are on), for the search page to offer it.
      similarity: { enabled: similarityEnabled() },
      // How an upload is read here, so "Read whole document" can say what it will do.
      reading: { mode: parser.mode, ocr: parser.ocrEnabled, images: parser.mode === 'hybrid' || parser.mode === 'multimodal' },
      // What a person can pick for a reading; the first is what uploads use.
      // `endpoint` is where a reading with that model would go, which is not always where the default's does.
      models: llm.models.map((choice, i) => ({ id: choice.id, label: choice.label, default: i === 0, endpoint: choice.endpoint ?? llm.endpoint ?? null })),
    });
  });

  // Read chosen pages with the model, then extract again the documents they belong to: the
  // page- and document-level "Read with AI". Only those pages' images are sent, so the same
  // operator switch applies as for every other route that sends one (SECURITY.md M-7).
  app.post<{ Params: { id: string }; Body: { page_ids?: unknown; model?: unknown; strategy?: unknown; thinking?: unknown } }>('/api/source-files/:id/ai-reading', async (req, reply) => {
    const { id } = req.params;
    const store = getStore();
    const file = await store.sourceFiles.findFor(req.userId, id);
    if (!file) return reply.status(404).send({ error: 'not found' });

    // `model`: each page's image goes to the model (Read page with AI). `configured`: the pages are read the way an
    // upload reads them, by the parser the operator set (Read whole document), which sends an image only if
    // that parser does, or if the upload is a photo.
    const strategy = req.body?.strategy ?? 'model';
    if (strategy !== 'model' && strategy !== 'configured') {
      return reply.status(400).send({ error: 'strategy must be model or configured' });
    }
    const sendsImages = strategy === 'model' || !!file.mime_type?.startsWith('image/') || getParser().imageEgress;
    if (sendsImages && !aiReadingAllowed()) {
      return reply.status(409).send({ error: 'AI reading is not enabled on this server' });
    }

    const pageIds = req.body?.page_ids;
    if (!Array.isArray(pageIds) || pageIds.length === 0 || pageIds.length > MAX_PAGES_PER_READING
        || pageIds.some(p => typeof p !== 'string') || new Set(pageIds).size !== pageIds.length) {
      return reply.status(400).send({ error: `page_ids must be 1 to ${MAX_PAGES_PER_READING} different page ids` });
    }
    const model = chooseModel(req.body?.model);
    if (model === null) return reply.status(400).send({ error: 'that model is not offered' });
    // Let the model think before it answers. Only the page-by-page reading asks for it; the whole-document one reads as an upload does.
    const thinking = req.body?.thinking ?? false;
    if (typeof thinking !== 'boolean') return reply.status(400).send({ error: 'thinking must be true or false' });
    // Pages of another upload, or another user's, are reported the same as pages that do not exist.
    const known = new Set((await store.pages.listForSourceFile(req.userId, id)).map(p => p.id));
    if (!(pageIds as string[]).every(p => known.has(p))) {
      return reply.status(400).send({ error: 'a page is not part of this upload' });
    }

    if (file.status === 'pending' || file.status === 'processing' || getJobStatus(id)?.status === 'processing' || isReadingPages(id)) {
      return reply.status(409).send({ error: 'this file is still being processed' });
    }

    return reply.status(202).send(startAiReading(req.userId, id, pageIds as string[], model, strategy, thinking && strategy === 'model'));
  });

  app.get<{ Params: { id: string } }>('/api/source-files/:id/ai-reading', async (req, reply) => {
    if (!(await getStore().sourceFiles.findFor(req.userId, req.params.id))) {
      return reply.status(404).send({ error: 'not found' });
    }
    return reply.send(getAiReading(req.params.id) ?? { status: 'idle' });
  });

  app.get<{ Params: { id: string } }>('/api/source-files/:id/status', async (req, reply) => {
    const { id } = req.params;
    const row = await getStore().sourceFiles.findFor(req.userId, id);

    if (!row) return reply.status(404).send({ error: 'not found' });

    const job = getJobStatus(id);
    // What the upload became, so the page can name it by its documents' titles rather
    // than the file name. Empty until processing has finished.
    const documents = row.status === 'done'
      ? (await getStore().documents.listFor(req.userId, { sourceFileId: id, limit: 1000, offset: 0, includeUnconfirmed: true }))
          .sort((a, b) => a.page_start - b.page_start)
          .map(documentSummary)
      : [];
    return reply.send({
      status: row.status,
      progress: job?.progress ?? (row.status === 'done' ? 100 : 0),
      step: job?.step ?? row.status,
      error: row.error_message,
      grouping_confirmed: row.grouping_confirmed,
      documents,
    });
  });
}

import type { FastifyInstance } from 'fastify';
import { createHash } from 'crypto';
import { createWriteStream, mkdirSync, rmSync } from 'fs';
import { detectFileKind, isImage, MIME_OF } from '../file-kind.js';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { getStore } from '../store/index.js';
import { resolveDataDir } from '../config.js';
import { startIngestionJob, getJobStatus } from '../ingestion/pipeline.js';
import { aiReadingAllowed } from '../parser/index.js';
import { getAiReading, isReadingPages, startAiReading } from '../ingestion/ai-reading.js';
import { loadLlmConfig } from '../config.js';
import { requireAuth } from './middleware.js';
import type { Document } from '../types.js';


/** What a client needs to name and place one document of an upload. */
function documentSummary(doc: Document) {
  return {
    id: doc.id, title: doc.title, doc_type: doc.doc_type, doc_date: doc.doc_date, provider: doc.provider,
    page_start: doc.page_start, page_end: doc.page_end, reviewed: doc.reviewed,
  };
}

/** One request cannot ask for an unbounded number of images to be sent. */
const MAX_PAGES_PER_READING = 200;

/**
 * Runs an upload that failed again. A failure (the provider was down, a page could not be read) is not
 * the file's fault, and the original is still held, so it should not take re-uploading, which would be
 * refused as a duplicate of the failed one. Only a failed upload qualifies, and not while a job runs.
 */
async function retryFailedUpload(userId: string, id: string): Promise<'started' | 'not_found' | 'not_failed'> {
  const file = await getStore().sourceFiles.findFor(userId, id);
  if (!file) return 'not_found';
  if (file.status !== 'error' || getJobStatus(id)?.status === 'processing') return 'not_failed';
  startIngestionJob(id, userId, { retry: true });
  return 'started';
}

export async function sourceFileRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  // Every upload, newest first, with what it became, so the history can name each upload
  // by its documents and link to regrouping its pages.
  app.get('/api/source-files', async (req, reply) => {
    const store = getStore();
    const uploads = await store.sourceFiles.listFor(req.userId);
    const withDocuments = await Promise.all(
      uploads.map(async upload => ({
        ...upload,
        documents: (await store.documents.listFor(req.userId, { sourceFileId: upload.id, limit: 1000, offset: 0 }))
          .sort((a, b) => a.page_start - b.page_start)
          .map(documentSummary),
      })),
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
    const documents = await store.documents.listFor(req.userId, { sourceFileId: upload.id, limit: 1000, offset: 0 });
    return reply.send({
      id: upload.id,
      uploaded_at: upload.uploaded_at,
      status: upload.status,
      error_message: upload.error_message,
      page_count: upload.page_count,
      pages: pages.map(p => ({
        id: p.id, page_number: p.page_number, image_width: p.image_width,
        image_height: p.image_height, extraction_source: p.extraction_source,
      })),
      documents: documents.sort((a, b) => a.page_start - b.page_start).map(documentSummary),
    });
  });

  app.post('/api/source-files/upload', async (req, reply) => {
    const parts = req.parts();
    const store = getStore();

    const results = [];

    for await (const part of parts) {
      if (part.type !== 'file') continue;

      const fileId = uuidv4();
      const year = new Date().getFullYear().toString();
      const ext = path.extname(part.filename ?? '.pdf') || '.pdf';
      // Per-user directory, so a filesystem mistake cannot cross users as easily
      // as a query mistake (M-9). The id is a server-issued uuid, never user input.
      const outDir = path.join(resolveDataDir(), 'originals', req.userId, year);
      mkdirSync(outDir, { recursive: true });
      const filePath = path.join(outDir, `${fileId}${ext}`);

      // Stream to disk while computing checksum
      const hash = createHash('sha256');
      const ws = createWriteStream(filePath);

      await new Promise<void>((resolve, reject) => {
        part.file.on('data', (chunk: Buffer) => hash.update(chunk));
        part.file.pipe(ws);
        ws.on('finish', resolve);
        ws.on('error', reject);
      });

      const checksum = hash.digest('hex');

      // Only what can be read is kept. A refused file, and a copy of one already held, is not left on disk.
      const kind = detectFileKind(filePath);
      if (kind === null) {
        rmSync(filePath, { force: true });
        results.push({ skipped: true, reason: 'not_pdf', filename: part.filename ?? null });
        continue;
      }
      // A photo has no text for anything local to read, so the model reads it, and that sends the
      // image off this host: refused, with the reason, unless the operator has allowed it.
      if (isImage(kind) && !aiReadingAllowed()) {
        rmSync(filePath, { force: true });
        results.push({ skipped: true, reason: 'photo_needs_ai', filename: part.filename ?? null });
        continue;
      }

      // Reject duplicate uploads
      const existing = await store.sourceFiles.findByChecksumFor(req.userId, checksum);
      if (existing) {
        rmSync(filePath, { force: true });
        // The same file again after it failed is a request to try again, not a duplicate of nothing.
        if (existing.status === 'error' && (await retryFailedUpload(req.userId, existing.id)) === 'started') {
          results.push({ id: existing.id, status: 'processing', retried: true });
          continue;
        }
        results.push({ skipped: true, reason: 'duplicate', existing_id: existing.id });
        continue;
      }

      await store.sourceFiles.create(req.userId, {
        id: fileId,
        uploadedAt: new Date().toISOString(),
        originalFilename: part.filename ?? null,
        filePath,
        mimeType: MIME_OF[kind], // what it is, not what the browser called it
        checksum,
      });

      startIngestionJob(fileId, req.userId);
      results.push({ id: fileId, status: 'processing' });
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

  // What the page needs to offer "Read with AI", and to say where the images would go.
  app.get('/api/capabilities', async (_req, reply) => {
    const llm = loadLlmConfig();
    return reply.send({
      aiReading: { enabled: aiReadingAllowed(), provider: llm.provider, endpoint: llm.endpoint ?? null },
    });
  });

  // Read this upload again with the model for every page. It sends the page images to
  // the configured provider, so it needs the operator's switch as well as the click.
  app.post<{ Params: { id: string } }>('/api/source-files/:id/reread', async (req, reply) => {
    const { id } = req.params;
    const file = await getStore().sourceFiles.findFor(req.userId, id);
    if (!file) return reply.status(404).send({ error: 'not found' });

    if (!aiReadingAllowed()) {
      return reply.status(409).send({ error: 'AI reading is not enabled on this server' });
    }
    if (file.status === 'pending' || file.status === 'processing' || getJobStatus(id)?.status === 'processing' || isReadingPages(id)) {
      return reply.status(409).send({ error: 'this file is still being processed' });
    }

    startIngestionJob(id, req.userId, { reread: true });
    return reply.status(202).send({ id, status: 'processing' });
  });

  // Read chosen pages with the model, then extract again the documents they belong to: the
  // page- and document-level "Read with AI". Only those pages' images are sent, so the same
  // operator switch applies as for every other route that sends one (SECURITY.md M-7).
  app.post<{ Params: { id: string }; Body: { page_ids?: unknown } }>('/api/source-files/:id/ai-reading', async (req, reply) => {
    const { id } = req.params;
    const store = getStore();
    const file = await store.sourceFiles.findFor(req.userId, id);
    if (!file) return reply.status(404).send({ error: 'not found' });

    if (!aiReadingAllowed()) {
      return reply.status(409).send({ error: 'AI reading is not enabled on this server' });
    }

    const pageIds = req.body?.page_ids;
    if (!Array.isArray(pageIds) || pageIds.length === 0 || pageIds.length > MAX_PAGES_PER_READING
        || pageIds.some(p => typeof p !== 'string') || new Set(pageIds).size !== pageIds.length) {
      return reply.status(400).send({ error: `page_ids must be 1 to ${MAX_PAGES_PER_READING} different page ids` });
    }
    // Pages of another upload, or another user's, are reported the same as pages that do not exist.
    const known = new Set((await store.pages.listForSourceFile(req.userId, id)).map(p => p.id));
    if (!(pageIds as string[]).every(p => known.has(p))) {
      return reply.status(400).send({ error: 'a page is not part of this upload' });
    }

    if (file.status === 'pending' || file.status === 'processing' || getJobStatus(id)?.status === 'processing' || isReadingPages(id)) {
      return reply.status(409).send({ error: 'this file is still being processed' });
    }

    return reply.status(202).send(startAiReading(req.userId, id, pageIds as string[]));
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
      ? (await getStore().documents.listFor(req.userId, { sourceFileId: id, limit: 1000, offset: 0 }))
          .sort((a, b) => a.page_start - b.page_start)
          .map(documentSummary)
      : [];
    return reply.send({
      status: row.status,
      progress: job?.progress ?? (row.status === 'done' ? 100 : 0),
      step: job?.step ?? row.status,
      error: row.error_message,
      documents,
    });
  });
}

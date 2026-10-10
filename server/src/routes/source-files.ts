import type { FastifyInstance } from 'fastify';
import { createHash } from 'crypto';
import { createWriteStream, mkdirSync } from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { getStore } from '../store/index.js';
import { resolveDataDir } from '../config.js';
import { startIngestionJob, getJobStatus } from '../ingestion/pipeline.js';
import { requireAuth } from './middleware.js';


export async function sourceFileRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/source-files', async (req, reply) => {
    return reply.send(await getStore().sourceFiles.listFor(req.userId));
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

      // Reject duplicate uploads
      const existing = await store.sourceFiles.findByChecksumFor(req.userId, checksum);
      if (existing) {
        results.push({ skipped: true, reason: 'duplicate', existing_id: existing.id });
        continue;
      }

      await store.sourceFiles.create(req.userId, {
        id: fileId,
        uploadedAt: new Date().toISOString(),
        originalFilename: part.filename ?? null,
        filePath,
        mimeType: part.mimetype ?? null,
        checksum,
      });

      startIngestionJob(fileId, req.userId);
      results.push({ id: fileId, status: 'processing' });
    }

    return reply.send(results);
  });

  app.get<{ Params: { id: string } }>('/api/source-files/:id/status', async (req, reply) => {
    const { id } = req.params;
    const row = await getStore().sourceFiles.findFor(req.userId, id);

    if (!row) return reply.status(404).send({ error: 'not found' });

    const job = getJobStatus(id);
    return reply.send({
      status: row.status,
      progress: job?.progress ?? (row.status === 'done' ? 100 : 0),
      step: job?.step ?? row.status,
      error: row.error_message,
    });
  });
}

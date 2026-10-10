import type { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { createReadStream, existsSync, statSync } from 'fs';
import { extname } from 'path';
import { getStore, type DocumentPatch } from '../store/index.js';
import { requireAuth } from './middleware.js';

/** The only fields a PATCH may name. `reviewed` is handled alongside them. */
const PATCHABLE_FIELDS = [
  'doc_date',
  'provider',
  'doc_type',
  'ai_summary',
  'user_notes',
  'reviewed',
] as const;

export async function documentRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  // List documents with optional filters
  app.get<{
    Querystring: {
      q?: string;
      tag?: string;
      doc_type?: string;
      provider?: string;
      date_from?: string;
      date_to?: string;
      reviewed?: string;
      limit?: string;
      offset?: string;
    };
  }>('/api/documents', async (req, reply) => {
    const { q, tag, doc_type, provider, date_from, date_to, reviewed, limit = '50', offset = '0' } = req.query;

    const documents = await getStore().documents.listFor(req.userId, {
      q,
      tag,
      docType: doc_type,
      provider,
      dateFrom: date_from,
      dateTo: date_to,
      reviewed: reviewed === undefined ? undefined : reviewed === 'true',
      limit: parseInt(limit),
      offset: parseInt(offset),
    });

    return reply.send(documents);
  });

  app.get<{ Params: { id: string } }>('/api/documents/:id', async (req, reply) => {
    const store = getStore();
    const { id } = req.params;

    const doc = await store.documents.findFor(req.userId, id);
    if (!doc) return reply.status(404).send({ error: 'not found' });

    const [fields, tags, pages] = await Promise.all([
      store.fields.listForDocument(req.userId, id),
      store.tags.namesForDocument(req.userId, id),
      store.pages.listForDocument(req.userId, id),
    ]);

    return reply.send({ ...doc, fields, tags, pages });
  });

  app.patch<{
    Params: { id: string };
    Body: DocumentPatch & { tags?: string[] };
  }>('/api/documents/:id', async (req, reply) => {
    const store = getStore();
    const { id } = req.params;
    const { tags, ...patch } = req.body ?? {};

    // The store takes a patch object and maps it to columns itself, so a
    // request key can never reach the SQL (S-12). Unknown keys are refused
    // here so a typo is a 400 rather than a silent no-op.
    const unknown = Object.keys(patch).filter(
      key => !(PATCHABLE_FIELDS as readonly string[]).includes(key),
    );
    if (unknown.length > 0) {
      return reply.status(400).send({ error: `unknown field(s): ${unknown.join(', ')}` });
    }

    // 404, not 403, for a document that is someone else's: the same answer as for
    // one that does not exist, so it cannot be probed for.
    if (!(await store.documents.findFor(req.userId, id))) {
      return reply.status(404).send({ error: 'not found' });
    }

    await store.transaction(async tx => {
      await tx.documents.update(req.userId, id, patch);
      if (tags !== undefined) await tx.tags.setForDocument(req.userId, id, tags);
    });

    return reply.send({ ok: true });
  });

  // Override page boundary — split or merge
  app.post<{
    Params: { id: string };
    Body: { action: 'split'; at_page: number } | { action: 'merge'; with_document_id: string };
  }>('/api/documents/:id/boundary', async (req, reply) => {
    const store = getStore();
    const { id } = req.params;
    const body = req.body;

    const doc = await store.documents.findFor(req.userId, id);
    if (!doc) return reply.status(404).send({ error: 'not found' });

    if (body.action === 'split') {
      const { at_page } = body;
      if (at_page <= doc.page_start || at_page > doc.page_end) {
        return reply.status(400).send({ error: 'at_page out of range' });
      }

      // Shorten current doc, create new one for the tail. Both or neither:
      // a half-applied split leaves pages belonging to no document.
      const newId = uuidv4();
      await store.transaction(async tx => {
        await tx.documents.setPageEnd(req.userId, id, at_page - 1);
        await tx.documents.create(req.userId, {
          id: newId,
          sourceFileId: doc.source_file_id,
          pageStart: at_page,
          pageEnd: doc.page_end,
        });
      });

      return reply.send({ split_into: [id, newId] });
    }

    if (body.action === 'merge') {
      const other = await store.documents.findFor(req.userId, body.with_document_id);
      if (!other) return reply.status(404).send({ error: 'other document not found' });

      // Extend current doc to cover the other, move its fields, delete it.
      // Four writes that must not half-apply.
      await store.transaction(async tx => {
        await tx.documents.setPageEnd(req.userId, id, other.page_end);
        await tx.fields.reassignDocument(req.userId, other.id, id);
        await tx.tags.removeAllForDocument(req.userId, other.id);
        await tx.documents.delete(req.userId, other.id);
      });

      return reply.send({ merged: id });
    }

    return reply.status(400).send({ error: 'unknown action' });
  });

  // Serve page images (authenticated — these are medical scans, never static)
  app.get<{ Params: { id: string } }>('/api/pages/:id/image', async (req, reply) => {
    const imagePath = await getStore().pages.findImagePathFor(req.userId, req.params.id);
    if (!imagePath) return reply.status(404).send({ error: 'not found' });

    // image_path is an absolute path written by rasterize.ts, so it cannot go
    // through fastify-static's sendFile (which resolves relative to a root).
    if (!existsSync(imagePath) || !statSync(imagePath).isFile()) {
      return reply.status(404).send({ error: 'image not found on disk' });
    }

    const type = extname(imagePath).toLowerCase() === '.jpg' ? 'image/jpeg' : 'image/png';
    return reply
      .type(type)
      .header('Cache-Control', 'private, max-age=3600')
      .send(createReadStream(imagePath));
  });
}

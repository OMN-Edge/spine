import type { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { createReadStream, existsSync, statSync } from 'fs';
import { extname } from 'path';
import { getStore, type DocumentPatch } from '../store/index.js';
import { requireAuth } from './middleware.js';
import { rereadDocument, rereadDocuments } from '../ingestion/document-reading.js';
import { isReadingPages } from '../ingestion/ai-reading.js';
import { DOC_TYPES } from '../llm/types.js';

/** The only fields a PATCH may name. `reviewed` is handled alongside them. */
const PATCHABLE_FIELDS = [
  'title',
  'doc_date',
  'provider',
  'doc_type',
  'ai_summary',
  'user_notes',
  'reviewed',
] as const;

interface FieldEdits {
  update?: Array<{ id?: unknown; label?: unknown; value?: unknown }>;
  remove?: unknown[];
  add?: Array<{ label?: unknown; value?: unknown; page_id?: unknown }>;
}

interface ValidFieldEdits {
  update: Array<{ id: string; label: string; value: string }>;
  remove: string[];
  add: Array<{ label: string; value: string; page_id: string }>;
}

const LIMITS = { title: 200, provider: 200, summary: 4000, notes: 10000, label: 80, value: 2000, tag: 60, tags: 30, fieldEdits: 200 };

/** A string within a length, or null for "not that". */
const text = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.length <= max ? value : null;

/**
 * Checks the details a client may set. An empty date, title or provider means "clear
 * it"; a date has to be a real day, and a type one the app knows.
 */
function checkDetails(patch: DocumentPatch): string | null {
  const limit: Array<[keyof DocumentPatch, number, string]> = [
    ['title', LIMITS.title, 'title'], ['provider', LIMITS.provider, 'provider'],
    ['ai_summary', LIMITS.summary, 'summary'], ['user_notes', LIMITS.notes, 'notes'],
  ];
  for (const [key, max, name] of limit) {
    const value = patch[key];
    if (value !== undefined && value !== null && text(value, max) === null) return `${name} must be text of at most ${max} characters`;
  }
  if (patch.doc_date !== undefined && patch.doc_date !== null && patch.doc_date !== '') {
    const iso = /^\d{4}-\d{2}-\d{2}$/.test(String(patch.doc_date)) && !Number.isNaN(Date.parse(String(patch.doc_date)));
    if (!iso) return 'date must be a real day as YYYY-MM-DD';
  }
  if (patch.doc_type !== undefined && !(DOC_TYPES as readonly string[]).includes(String(patch.doc_type))) {
    return `type must be one of ${DOC_TYPES.join(', ')}`;
  }
  if (patch.reviewed !== undefined && typeof patch.reviewed !== 'boolean') return 'reviewed must be true or false';
  return null;
}

/** Empty text clears the value; surrounding space is not part of it. */
function normaliseDetails(patch: DocumentPatch): DocumentPatch {
  const out: DocumentPatch = { ...patch };
  for (const key of ['title', 'provider', 'doc_date', 'ai_summary', 'user_notes'] as const) {
    const value = out[key];
    if (typeof value === 'string') out[key] = value.trim() === '' ? null : key === 'user_notes' || key === 'ai_summary' ? value : value.trim();
  }
  return out;
}

function checkTags(tags: unknown): string | null {
  if (tags === undefined) return null;
  if (!Array.isArray(tags) || tags.length > LIMITS.tags) return `tags must be a list of at most ${LIMITS.tags}`;
  for (const tag of tags) {
    if (typeof tag !== 'string' || tag.trim() === '' || tag.length > LIMITS.tag) {
      return `each tag must be text of 1 to ${LIMITS.tag} characters`;
    }
  }
  return null;
}

/**
 * Checks every field edit against what this document actually has, before anything is
 * written. A field or page that is not this document's, or is another user's, is
 * reported the same way as one that does not exist.
 */
async function checkFieldEdits(userId: string, documentId: string, edits: FieldEdits): Promise<ValidFieldEdits | string> {
  const store = getStore();
  const update = edits.update ?? [];
  const remove = edits.remove ?? [];
  const add = edits.add ?? [];
  if (![update, remove, add].every(Array.isArray)) return 'fields must hold lists: update, remove, add';
  if (update.length + remove.length + add.length > LIMITS.fieldEdits) return `at most ${LIMITS.fieldEdits} field changes at a time`;

  const mine = new Set((await store.fields.listForDocument(userId, documentId)).map(f => f.id));
  const pages = new Set((await store.pages.listForDocument(userId, documentId)).map(p => p.id));

  const labelAndValue = (item: { label?: unknown; value?: unknown }): string | null => {
    const label = text(item.label, LIMITS.label);
    const value = text(item.value, LIMITS.value);
    if (label === null || label.trim() === '') return `a field label is 1 to ${LIMITS.label} characters`;
    if (value === null || value.trim() === '') return `a field value is 1 to ${LIMITS.value} characters`;
    return null;
  };

  const touched = new Set<string>();
  const out: ValidFieldEdits = { update: [], remove: [], add: [] };
  for (const item of update) {
    const problem = labelAndValue(item);
    if (problem) return problem;
    if (typeof item.id !== 'string' || !mine.has(item.id)) return 'a field to change was not found on this document';
    if (touched.has(item.id)) return 'a field is changed or removed twice';
    touched.add(item.id);
    out.update.push({ id: item.id, label: String(item.label).trim(), value: String(item.value).trim() });
  }
  for (const fieldId of remove) {
    if (typeof fieldId !== 'string' || !mine.has(fieldId)) return 'a field to remove was not found on this document';
    if (touched.has(fieldId)) return 'a field is changed or removed twice';
    touched.add(fieldId);
    out.remove.push(fieldId);
  }
  for (const item of add) {
    const problem = labelAndValue(item);
    if (problem) return problem;
    if (typeof item.page_id !== 'string' || !pages.has(item.page_id)) return 'a new field must be on one of this document\'s pages';
    out.add.push({ label: String(item.label).trim(), value: String(item.value).trim(), page_id: item.page_id });
  }
  return out;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 500;

/** A positive integer, or the fallback: `parseInt('abc')` is NaN, which SQLite rejects. */
function integer(value: string | undefined, fallback: number, min: number): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

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
      // Bounded, so one request cannot ask for the whole archive; a client that wants
      // everything pages through it.
      limit: Math.min(integer(limit, DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE),
      offset: integer(offset, 0, 0),
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

  /**
   * One edit session, saved as one request: the document's details, its tags and its
   * extracted fields, together with whether it is now reviewed. Everything is checked
   * first and written in one transaction, so a bad field cannot leave the rest half
   * applied. Where a field edit and the checks fail, the answer is a 400 naming the problem
   * and nothing has changed.
   */
  app.patch<{
    Params: { id: string };
    Body: DocumentPatch & { tags?: string[]; fields?: FieldEdits };
  }>('/api/documents/:id', async (req, reply) => {
    const store = getStore();
    const { id } = req.params;
    const { tags, fields, ...patch } = req.body ?? {};

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

    const problem = checkDetails(patch) ?? checkTags(tags);
    if (problem) return reply.status(400).send({ error: problem });

    const normalised = normaliseDetails(patch);

    let edits: ValidFieldEdits | null = null;
    if (fields !== undefined) {
      const checked = await checkFieldEdits(req.userId, id, fields);
      if (typeof checked === 'string') return reply.status(400).send({ error: checked });
      edits = checked;
    }

    await store.transaction(async tx => {
      await tx.documents.update(req.userId, id, normalised);
      if (tags !== undefined) await tx.tags.setForDocument(req.userId, id, tags);
      if (edits) {
        for (const change of edits.update) await tx.fields.update(req.userId, id, change.id, change);
        for (const fieldId of edits.remove) await tx.fields.remove(req.userId, id, fieldId);
        for (const field of edits.add) {
          await tx.fields.create(req.userId, {
            id: uuidv4(), documentId: id, pageId: field.page_id, label: field.label, value: field.value,
            // Entered by the owner: nothing was read from the page, so there is no source.
            sourceSnippet: null, bbox: null, confidence: null,
          });
        }
      }
    });

    return reply.send({ ok: true });
  });

  // Extract this document's details again from its pages' text. No image is sent, so it
  // needs no operator switch; it uses the same text-only model call as an upload. It replaces
  // the title, date, provider, type, summary, tags and fields (notes are kept) and puts the
  // document back in the review queue.
  app.post<{ Params: { id: string } }>('/api/documents/:id/reextract', async (req, reply) => {
    const store = getStore();
    const doc = await store.documents.findFor(req.userId, req.params.id);
    if (!doc) return reply.status(404).send({ error: 'not found' });

    const upload = await store.sourceFiles.findFor(req.userId, doc.source_file_id);
    if (isReadingPages(doc.source_file_id) || upload?.status === 'pending' || upload?.status === 'processing') {
      return reply.status(409).send({ error: 'this file is still being processed' });
    }

    const read = await rereadDocument(req.userId, doc.id);
    return reply.send({ reread: read ? 'done' : 'failed' });
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

    // Regrouping changes what a document holds, so the documents it touches are read
    // again (text only, as at upload) and go back to review. The new grouping is saved
    // first and stands even if reading fails; the old reading is then kept.
    if (body.action === 'split') {
      const { at_page } = body;
      if (typeof at_page !== 'number' || at_page <= doc.page_start || at_page > doc.page_end) {
        return reply.status(400).send({ error: 'at_page out of range' });
      }

      // Shorten this document and make a new one for the tail. Fields go with their pages,
      // and the tail starts with this document's tags until it is read.
      const newId = uuidv4();
      const tags = await store.tags.namesForDocument(req.userId, id);
      await store.transaction(async tx => {
        await tx.documents.setPageEnd(req.userId, id, at_page - 1);
        await tx.documents.create(req.userId, {
          id: newId,
          sourceFileId: doc.source_file_id,
          pageStart: at_page,
          pageEnd: doc.page_end,
          docType: doc.doc_type,
          provider: doc.provider,
          docDate: doc.doc_date,
        });
        await tx.fields.reassignFromPage(req.userId, id, newId, at_page);
        await tx.tags.setForDocument(req.userId, newId, tags);
        await tx.documents.update(req.userId, id, { reviewed: false });
      });

      const read = await rereadDocuments(req.userId, [id, newId]);
      return reply.send({ split_into: [id, newId], reread: read.every(Boolean) ? 'done' : 'failed' });
    }

    if (body.action === 'merge') {
      const other = await store.documents.findFor(req.userId, body.with_document_id);
      if (!other) return reply.status(404).send({ error: 'other document not found' });

      // Only the document that directly follows this one in the same upload: anything
      // else would leave a range that skips pages, or ends before it starts.
      if (other.source_file_id !== doc.source_file_id || other.page_start !== doc.page_end + 1) {
        return reply.status(400).send({ error: 'can only join with the next document in the same upload' });
      }

      // Extend this document over the other, move its fields, delete it. Four writes
      // that must not half-apply.
      await store.transaction(async tx => {
        await tx.documents.setPageEnd(req.userId, id, other.page_end);
        await tx.fields.reassignDocument(req.userId, other.id, id);
        await tx.tags.removeAllForDocument(req.userId, other.id);
        await tx.documents.delete(req.userId, other.id);
        await tx.documents.update(req.userId, id, { reviewed: false });
      });

      const read = await rereadDocument(req.userId, id);
      return reply.send({ merged: id, reread: read ? 'done' : 'failed' });
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

import type { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { doctorKey } from '../doctors.js';
import { createReadStream, existsSync, renameSync, rmSync, statSync } from 'fs';
import { rotateImage } from '../ingestion/image-ops.js';
import { isTurn } from '../geometry.js';
import { extname } from 'path';
import { getStore, type DocumentPatch, type MeasurementChange, type NewMeasurement } from '../store/index.js';
import { requireAuth } from './middleware.js';
import { rereadDocument, rereadDocuments } from '../ingestion/document-reading.js';
import { chooseModel } from '../llm/index.js';
import { cleanLanguageCode, isSupportedLanguage, SUPPORTED_LANGUAGES } from '../languages.js';
import { translateDocument } from '../translation.js';
import { scheduleSync } from '../similarity/index.js';
import { scheduleLinking } from '../linking/index.js';
import { movePage, MoveError, type MoveTarget } from '../ingestion/move-page.js';
import { isReadingPages } from '../ingestion/ai-reading.js';
import { DOC_TYPES, DOCTOR_ROLES } from '../llm/types.js';
import { canonicalName, flagFor, parseNumber, validWhen } from '../ingestion/measurements.js';
import type { DoctorRole } from '../types.js';

/** The columns a new reading would fill in, and that the owner can take over by setting them. */
const HEADLINE_COLUMNS = ['title', 'doc_date', 'provider', 'doc_type', 'ai_summary'] as const;

/** The only fields a PATCH may name. `reviewed` is handled alongside them. */
const PATCHABLE_FIELDS = [
  'title',
  'doc_date',
  'provider',
  'doc_type',
  'ai_summary',
  'user_notes',
  'language',
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

/** Exported for the chat's proposals, which are checked against the same limits as the route they will call. */
export const LIMITS = {
  title: 200, provider: 200, summary: 4000, notes: 10000, label: 80, value: 2000, tag: 60, tags: 30, fieldEdits: 200,
  measurementValue: 60, unit: 30, doctors: 20, doctorName: 120, specialty: 80,
};

/** A string within a length, or null for "not that". */
const text = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.length <= max ? value : null;

/**
 * Checks the details a client may set. An empty date, title or provider means "clear
 * it"; a date has to be a real day, and a type one the app knows.
 */
export function checkDetails(patch: DocumentPatch): string | null {
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
  if (patch.language !== undefined && patch.language !== null && patch.language !== '' && cleanLanguageCode(patch.language) === null) {
    return 'language must be a two-letter code, or empty when unknown';
  }
  return null;
}

/** Empty text clears the value; surrounding space is not part of it. */
function normaliseDetails(patch: DocumentPatch): DocumentPatch {
  const out: DocumentPatch = { ...patch };
  for (const key of ['title', 'provider', 'doc_date', 'ai_summary', 'user_notes'] as const) {
    const value = out[key];
    if (typeof value === 'string') out[key] = value.trim() === '' ? null : key === 'user_notes' || key === 'ai_summary' ? value : value.trim();
  }
  if (out.language !== undefined) out.language = cleanLanguageCode(out.language);
  return out;
}

/** A measurement as the owner typed it, as what is stored: the number parsed, the flag worked out from the range. */
function measurementFrom(item: { name?: unknown; canonical?: unknown; value?: unknown; unit?: unknown; ref_low?: unknown; ref_high?: unknown; taken_on?: unknown }): MeasurementChange | string {
  const name = text(item.name, LIMITS.label);
  const value = text(item.value, LIMITS.measurementValue);
  if (name === null || name.trim() === '') return `a measurement name is 1 to ${LIMITS.label} characters`;
  if (value === null || value.trim() === '') return `a measurement value is 1 to ${LIMITS.measurementValue} characters`;
  const unit = item.unit == null || item.unit === '' ? null : text(item.unit, LIMITS.unit);
  if (item.unit != null && item.unit !== '' && unit === null) return `a unit is at most ${LIMITS.unit} characters`;
  const range = (raw: unknown): number | null | 'bad' => {
    if (raw == null || raw === '') return null;
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? parseNumber(raw) : null;
    return n === null || !Number.isFinite(n) ? 'bad' : n;
  };
  const low = range(item.ref_low);
  const high = range(item.ref_high);
  if (low === 'bad' || high === 'bad') return 'a reference range must be a number';
  if (item.taken_on != null && item.taken_on !== '' && validWhen(String(item.taken_on)) === null) return 'a measurement date must be a real day (YYYY-MM-DD) or a month (YYYY-MM)';

  const valueNum = parseNumber(value);
  return {
    name: name.trim(),
    canonical: canonicalName(typeof item.canonical === 'string' ? item.canonical : null, name),
    valueText: value.trim(),
    valueNum,
    unit: unit?.trim() || null,
    refLow: low,
    refHigh: high,
    flag: flagFor(valueNum, low, high, null),
    takenOn: item.taken_on ? String(item.taken_on) : null,
  };
}

async function checkMeasurementEdits(userId: string, documentId: string, edits: MeasurementEdits): Promise<ValidMeasurementEdits | string> {
  const store = getStore();
  const update = edits.update ?? [];
  const remove = edits.remove ?? [];
  const add = edits.add ?? [];
  if (![update, remove, add].every(Array.isArray)) return 'measurements must hold lists: update, remove, add';
  if (update.length + remove.length + add.length > LIMITS.fieldEdits) return `at most ${LIMITS.fieldEdits} measurement changes at a time`;

  const mine = new Set((await store.measurements.listForDocument(userId, documentId)).map(m => m.id));
  const pages = new Set((await store.pages.listForDocument(userId, documentId)).map(p => p.id));
  const touched = new Set<string>();
  const out: ValidMeasurementEdits = { update: [], remove: [], add: [] };

  for (const item of update) {
    const change = measurementFrom(item);
    if (typeof change === 'string') return change;
    if (typeof item.id !== 'string' || !mine.has(item.id)) return 'a measurement to change was not found on this document';
    if (touched.has(item.id)) return 'a measurement is changed or removed twice';
    touched.add(item.id);
    out.update.push({ id: item.id, change });
  }
  for (const measurementId of remove) {
    if (typeof measurementId !== 'string' || !mine.has(measurementId)) return 'a measurement to remove was not found on this document';
    if (touched.has(measurementId)) return 'a measurement is changed or removed twice';
    touched.add(measurementId);
    out.remove.push(measurementId);
  }
  for (const item of add) {
    const change = measurementFrom(item);
    if (typeof change === 'string') return change;
    if (typeof item.page_id !== 'string' || !pages.has(item.page_id)) return 'a new measurement must be on one of this document\'s pages';
    out.add.push({ pageId: item.page_id, change });
  }
  return out;
}

function checkDoctors(doctors: unknown): ValidDoctor[] | string {
  if (!Array.isArray(doctors) || doctors.length > LIMITS.doctors) return `doctors must be a list of at most ${LIMITS.doctors}`;
  const out: ValidDoctor[] = [];
  for (const d of doctors as DoctorEdit[]) {
    const name = text(d.name, LIMITS.doctorName);
    if (name === null || name.trim() === '') return `a doctor's name is 1 to ${LIMITS.doctorName} characters`;
    const specialty = d.specialty == null || d.specialty === '' ? null : text(d.specialty, LIMITS.specialty);
    if (d.specialty != null && d.specialty !== '' && specialty === null) return `a specialty is at most ${LIMITS.specialty} characters`;
    if (!(DOCTOR_ROLES as readonly string[]).includes(String(d.role))) return `a doctor's role must be one of ${DOCTOR_ROLES.join(', ')}`;
    if (d.id != null && (typeof d.id !== 'string' || d.id.length > 64)) return 'a doctor id must be text';
    out.push({ id: typeof d.id === 'string' ? d.id : null, new: d.new === true, name: name.trim(), specialty: specialty?.trim() || null, role: d.role as DoctorRole });
  }
  return out;
}

export function checkTags(tags: unknown): string | null {
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

interface MeasurementEdits {
  update?: Array<{ id?: unknown; name?: unknown; canonical?: unknown; value?: unknown; unit?: unknown; ref_low?: unknown; ref_high?: unknown; taken_on?: unknown }>;
  remove?: unknown[];
  add?: Array<{ name?: unknown; canonical?: unknown; value?: unknown; unit?: unknown; ref_low?: unknown; ref_high?: unknown; taken_on?: unknown; page_id?: unknown }>;
}
interface DoctorEdit { id?: unknown; new?: unknown; name?: unknown; specialty?: unknown; role?: unknown }
interface ValidDoctor { id: string | null; new: boolean; name: string; specialty: string | null; role: DoctorRole }
interface ValidMeasurementEdits {
  update: Array<{ id: string; change: MeasurementChange }>;
  remove: string[];
  add: Array<{ pageId: string; change: MeasurementCreate }>;
}
type MeasurementCreate = Omit<NewMeasurement, 'id' | 'documentId' | 'pageId' | 'sourceSnippet' | 'bbox' | 'confidence'>;

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
      specialty?: string;
      episode?: string;
      date_from?: string;
      date_to?: string;
      reviewed?: string;
      limit?: string;
      offset?: string;
    };
  }>('/api/documents', async (req, reply) => {
    const { q, tag, doc_type, provider, specialty, episode, date_from, date_to, reviewed, limit = '50', offset = '0' } = req.query;

    const documents = await getStore().documents.listFor(req.userId, {
      q,
      tag,
      docType: doc_type,
      provider,
      specialty,
      episodeId: episode,
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

    const [fields, tags, pages, measurements, doctors] = await Promise.all([
      store.fields.listForDocument(req.userId, id),
      store.tags.namesForDocument(req.userId, id),
      store.pages.listForDocument(req.userId, id),
      store.measurements.listForDocument(req.userId, id),
      store.doctors.forDocument(req.userId, id),
    ]);

    const upload = await getStore().sourceFiles.findFor(req.userId, doc.source_file_id);
    const episode = (await store.episodes.list(req.userId, ['proposed', 'confirmed'])).find(e => e.document_ids.includes(id));
    return reply.send({
      ...doc, fields, tags, pages, measurements, doctors, grouping_confirmed: upload?.grouping_confirmed ?? true,
      episode: episode ? { id: episode.id, title: episode.title, state: episode.state, first_date: episode.first_date, last_date: episode.last_date, provider: episode.provider } : null,
    });
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
    Body: DocumentPatch & { tags?: string[]; fields?: FieldEdits; measurements?: MeasurementEdits; doctors?: DoctorEdit[] };
  }>('/api/documents/:id', async (req, reply) => {
    const store = getStore();
    const { id } = req.params;
    const { tags, fields, measurements, doctors, ...patch } = req.body ?? {};

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
    const doc = await store.documents.findFor(req.userId, id);
    if (!doc) return reply.status(404).send({ error: 'not found' });

    const problem = checkDetails(patch) ?? checkTags(tags);
    if (problem) return reply.status(400).send({ error: problem });

    // A document is reviewed against a grouping the owner has confirmed: the pages it holds must be the right ones first.
    if (patch.reviewed === true && !(await store.sourceFiles.findFor(req.userId, doc.source_file_id))?.grouping_confirmed) {
      return reply.status(409).send({ error: 'check how this upload’s pages are grouped first, and confirm it' });
    }

    const normalised = normaliseDetails(patch);

    let edits: ValidFieldEdits | null = null;
    if (fields !== undefined) {
      const checked = await checkFieldEdits(req.userId, id, fields);
      if (typeof checked === 'string') return reply.status(400).send({ error: checked });
      edits = checked;
    }

    let measurementEdits: ValidMeasurementEdits | null = null;
    if (measurements !== undefined) {
      const checked = await checkMeasurementEdits(req.userId, id, measurements);
      if (typeof checked === 'string') return reply.status(400).send({ error: checked });
      measurementEdits = checked;
    }
    let doctorEdits: ValidDoctor[] | null = null;
    if (doctors !== undefined) {
      const checked = checkDoctors(doctors);
      if (typeof checked === 'string') return reply.status(400).send({ error: checked });
      doctorEdits = checked;
    }

    // What the owner sets by hand stays through a new reading; clearing a value hands it back to the reading.
    const before = await store.documents.editedColumns(req.userId, id);
    const edited = new Set(before);
    for (const column of HEADLINE_COLUMNS) {
      const next = (normalised as Record<string, unknown>)[column];
      if (next === undefined) continue;
      if (next === null || next === '') edited.delete(column);
      else if (next !== (doc as unknown as Record<string, unknown>)[column]) edited.add(column);
    }
    const headlineChange = edited.size === before.length && before.every(c => edited.has(c)) ? null : [...edited];

    await store.transaction(async tx => {
      await tx.documents.update(req.userId, id, normalised);
      if (tags !== undefined) await tx.tags.setForDocument(req.userId, id, tags);
      if (measurementEdits) {
        for (const m of measurementEdits.update) {
          await tx.measurements.update(req.userId, id, m.id, { ...m.change, canonical: await tx.measurements.resolveCanonical(req.userId, m.change.canonical) });
        }
        for (const measurementId of measurementEdits.remove) await tx.measurements.remove(req.userId, id, measurementId);
        for (const m of measurementEdits.add) {
          await tx.measurements.create(req.userId, {
            id: uuidv4(), documentId: id, pageId: m.pageId, ...m.change,
            canonical: await tx.measurements.resolveCanonical(req.userId, m.change.canonical),
            sourceSnippet: null, bbox: null, confidence: null, ownerEdited: true,
          });
        }
      }
      if (doctorEdits) {
        // The list sent is the document's doctors: replace, adding anyone new to the directory.
        // What ties each doctor to this document (where it was read, the code it printed) is kept through the edit for everyone who stays.
        const held = await tx.doctors.linkInfo(req.userId, id);
        await tx.doctors.unlinkAll(req.userId, id);
        const now = new Date().toISOString();
        for (const d of doctorEdits) {
          // A doctor left under the name they had stays that entry, found by its code if it has one; a name that was changed is looked up
          // as a name (an existing doctor of that name, or a new entry), and the entry it was before is not renamed.
          const was = d.id ? await tx.doctors.find(req.userId, d.id) : null;
          const same = was && doctorKey(was.name) === doctorKey(d.name);
          // The owner chose this entry (its id with its own name), or says this is another person of a name already held (`new`).
          const doctorId = await tx.doctors.upsert(req.userId, { name: d.name, specialty: d.specialty, clinic: doc.provider, id: same ? was.id : undefined, newPerson: d.new }, now);
          if (!doctorId) continue;
          const before = held.find(h => h.doctor_id === doctorId && h.role === d.role) ?? held.find(h => h.doctor_id === doctorId);
          await tx.doctors.link(req.userId, id, doctorId, d.role, before?.source ?? 'text', before?.printed_code ?? null);
        }
      }
      if (edits) {
        for (const change of edits.update) await tx.fields.update(req.userId, id, change.id, change);
        for (const fieldId of edits.remove) await tx.fields.remove(req.userId, id, fieldId);
        for (const field of edits.add) {
          await tx.fields.create(req.userId, {
            id: uuidv4(), documentId: id, pageId: field.page_id, label: field.label, value: field.value,
            // Entered by the owner: nothing was read from the page, so there is no source.
            sourceSnippet: null, bbox: null, confidence: null, ownerEdited: true,
          });
        }
      }
      if (headlineChange) await tx.documents.setEditedColumns(req.userId, id, headlineChange);
    });

    scheduleSync(req.userId); // what the document says may have changed
    // Reviewing a document says its grouping and details are right: a good time to look for its links.
    if (patch.reviewed === true) scheduleLinking(req.userId, [id]);
    return reply.send({ ok: true });
  });

  // Extract this document's details again from its pages' text. No image is sent, so it
  // needs no operator switch; it uses the same text-only model call as an upload. It replaces
  // the title, date, provider, type, summary, tags and fields (notes are kept) and puts the
  // document back in the review queue.
  app.post<{ Params: { id: string }; Body: { model?: unknown } | undefined }>('/api/documents/:id/reextract', async (req, reply) => {
    const store = getStore();
    const doc = await store.documents.findFor(req.userId, req.params.id);
    if (!doc) return reply.status(404).send({ error: 'not found' });
    const model = chooseModel(req.body?.model);
    if (model === null) return reply.status(400).send({ error: 'that model is not offered' });

    const upload = await store.sourceFiles.findFor(req.userId, doc.source_file_id);
    if (isReadingPages(doc.source_file_id) || upload?.status === 'pending' || upload?.status === 'processing') {
      return reply.status(409).send({ error: 'this file is still being processed' });
    }

    const read = await rereadDocument(req.userId, doc.id, model);
    return reply.send({ reread: read ? 'done' : 'failed' });
  });

  // Override page boundary — split or merge
  app.post<{
    Params: { id: string };
    Body: ({ action: 'split'; at_page: number } | { action: 'merge'; with_document_id: string }) & { defer?: boolean };
  }>('/api/documents/:id/boundary', async (req, reply) => {
    const store = getStore();
    const { id } = req.params;
    const body = req.body;

    const doc = await store.documents.findFor(req.userId, id);
    if (!doc) return reply.status(404).send({ error: 'not found' });

    // Regrouping changes what a document holds, so the documents it touches go back to review and are read
    // again (text only, as at upload; the pages' own text is never read again), now or, with `defer`, later. The new grouping is saved
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
        await tx.measurements.reassignFromPage(req.userId, id, newId, at_page);
        await tx.doctors.copyLinks(req.userId, id, newId);
        await tx.tags.setForDocument(req.userId, newId, tags);
        await tx.documents.update(req.userId, id, { reviewed: false, needs_reading: true });
      });

      // `defer`: the grouping is saved and nothing is read, so a run of changes costs one reading,
      // which the caller asks for when it is done (POST /api/source-files/:id/extract).
      if (body.defer) return reply.send({ split_into: [id, newId], reread: 'deferred' });
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
        await tx.measurements.reassignDocument(req.userId, other.id, id);
        await tx.doctors.moveLinks(req.userId, other.id, id);
        await tx.tags.removeAllForDocument(req.userId, other.id);
        await tx.documents.delete(req.userId, other.id);
        await tx.documents.update(req.userId, id, { reviewed: false, needs_reading: true });
      });

      if (body.defer) return reply.send({ merged: id, reread: 'deferred' });
      const read = await rereadDocument(req.userId, id);
      return reply.send({ merged: id, reread: read ? 'done' : 'failed' });
    }

    return reply.status(400).send({ error: 'unknown action' });
  });

  // Set a page aside, or bring it back. The page, its image and its text are kept; it leaves the document's
  // view, the search and the next reading. The documents that hold it go back to review, since what they
  // should say changed, and are returned so the caller can read them again when it is ready.
  app.patch<{ Params: { id: string }; Body: { hidden?: unknown } }>('/api/pages/:id', async (req, reply) => {
    const hidden = req.body?.hidden;
    if (typeof hidden !== 'boolean') return reply.status(400).send({ error: 'hidden must be true or false' });

    const store = getStore();
    const imagePath = await store.pages.findImagePathFor(req.userId, req.params.id);
    if (!imagePath) return reply.status(404).send({ error: 'not found' });

    const documentIds = await store.transaction(async tx => {
      const held = await tx.pages.setHidden(req.userId, req.params.id, hidden);
      for (const documentId of held ?? []) await tx.documents.update(req.userId, documentId, { reviewed: false, needs_reading: true });
      return held;
    });
    if (documentIds === null) return reply.status(404).send({ error: 'not found' });
    return reply.send({ hidden, document_ids: documentIds });
  });

  // The document in another language: its extracted details and the owner's notes, translated on demand and kept, so
  // the next reader of this document in that language gets them at once. `status` says whether this was served
  // from what was kept (cached), translated just now (translated), needed nothing (same, the document is already
  // in that language) or is switched off on this server (off).
  app.get<{ Params: { id: string }; Querystring: { lang?: string; part?: string } }>('/api/documents/:id/translation', async (req, reply) => {
    const language = req.query.lang;
    if (!isSupportedLanguage(language)) return reply.status(400).send({ error: `lang must be one of ${SUPPORTED_LANGUAGES.join(', ')}` });
    const result = await translateDocument(req.userId, req.params.id, language, { part: req.query.part === 'head' ? 'head' : 'full' });
    if (result === 'not_found') return reply.status(404).send({ error: 'not found' });
    if (result === null) return reply.status(502).send({ error: 'the document could not be translated right now' });
    return reply.header('Cache-Control', 'no-store').send(result);
  });

  // Move a page to another place in its upload: another position in its own document, into another document,
  // or out into a document of its own. The page keeps its place in its file (re-reading it needs that), the
  // pages are numbered again in their new order, the document ranges follow, and what was read from the page
  // goes with it. The documents it touches go back to review and wait to be read again (the caller's Done).
  app.post<{
    Params: { id: string };
    Body: { document_id?: unknown; before_page_id?: unknown; new_document?: unknown; before_document_id?: unknown };
  }>('/api/pages/:id/move', async (req, reply) => {
    const body = req.body ?? {};
    const id = (value: unknown) => (typeof value === 'string' && value.length > 0 ? value : value === null || value === undefined ? null : undefined);

    let target: MoveTarget;
    if (body.new_document === true) {
      const before = id(body.before_document_id);
      if (before === undefined) return reply.status(400).send({ error: 'before_document_id must be a document id or null' });
      target = { newDocument: true, beforeDocumentId: before };
    } else {
      const document = id(body.document_id);
      const before = id(body.before_page_id);
      if (!document || before === undefined) return reply.status(400).send({ error: 'name a document_id, and before_page_id or null; or new_document: true' });
      target = { documentId: document, beforePageId: before };
    }

    const store = getStore();
    const sourceFileId = await store.pages.sourceFileOf(req.userId, req.params.id);
    if (!sourceFileId) return reply.status(404).send({ error: 'not found' });
    const upload = await store.sourceFiles.findFor(req.userId, sourceFileId);
    if (isReadingPages(sourceFileId) || upload?.status === 'pending' || upload?.status === 'processing') {
      return reply.status(409).send({ error: 'this file is still being processed' });
    }

    try {
      return reply.send(await movePage(req.userId, req.params.id, target, uuidv4()));
    } catch (err) {
      if (err instanceof MoveError) {
        return reply.status(err.code === 'not_found' ? 404 : err.code === 'inconsistent' ? 409 : 400).send({ error: err.message });
      }
      throw err;
    }
  });

  // Turn a page image clockwise by 90, 180 or 270 degrees, for a scan that was fed in sideways. The image file is turned in
  // place, and the boxes drawn on it (the page's text elements, the fields and results read from it) move with it; what a
  // model reads next is the turned image. Nothing is read again by this.
  app.post<{ Params: { id: string }; Body: { degrees?: unknown } }>('/api/pages/:id/rotate', async (req, reply) => {
    const degrees = req.body?.degrees;
    if (!isTurn(degrees)) return reply.status(400).send({ error: 'degrees must be 90, 180 or 270' });

    const store = getStore();
    const imagePath = await store.pages.findImagePathFor(req.userId, req.params.id);
    if (!imagePath) return reply.status(404).send({ error: 'not found' });
    const sourceFileId = await store.pages.sourceFileOf(req.userId, req.params.id);
    const upload = sourceFileId ? await store.sourceFiles.findFor(req.userId, sourceFileId) : null;
    if ((sourceFileId && isReadingPages(sourceFileId)) || upload?.status === 'pending' || upload?.status === 'processing') {
      return reply.status(409).send({ error: 'this file is still being processed' });
    }
    if (!existsSync(imagePath) || !statSync(imagePath).isFile()) return reply.status(404).send({ error: 'image not found on disk' });

    // Written beside the image and moved over it, so a failure leaves the page as it was.
    const staged = `${imagePath}.turning`;
    try {
      const info = await rotateImage(imagePath, staged, degrees);
      renameSync(staged, imagePath);
      await store.pages.rotate(req.userId, req.params.id, degrees, { width: info.width, height: info.height });
      const [page] = (await store.pages.listForSourceFile(req.userId, sourceFileId!)).filter(p => p.id === req.params.id);
      return reply.send({ rotation: page.rotation, image_width: info.width, image_height: info.height });
    } finally {
      rmSync(staged, { force: true });
    }
  });

  // Set a whole document aside, or bring it back: every page of its range at once, however many there are.
  // The document then leaves the timeline, search, shares and trends (a document with every page hidden is
  // set aside) and stays on the upload's regrouping screen. It goes back to review, as hiding one page does.
  app.patch<{ Params: { id: string }; Body: { hidden?: unknown } }>('/api/documents/:id/hidden', async (req, reply) => {
    const hidden = req.body?.hidden;
    if (typeof hidden !== 'boolean') return reply.status(400).send({ error: 'hidden must be true or false' });

    const store = getStore();
    if (!(await store.documents.findFor(req.userId, req.params.id))) return reply.status(404).send({ error: 'not found' });

    await store.transaction(async tx => {
      await tx.pages.setHiddenForDocument(req.userId, req.params.id, hidden);
      await tx.documents.update(req.userId, req.params.id, { reviewed: false, needs_reading: true });
    });
    return reply.send({ hidden, document_ids: [req.params.id] });
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

    // Kept by the browser, but asked again each time: a page can be turned, and the file's own date says whether it was.
    const modified = statSync(imagePath).mtime;
    const since = Date.parse(req.headers['if-modified-since'] ?? '');
    if (Number.isFinite(since) && Math.floor(modified.getTime() / 1000) <= Math.floor(since / 1000)) return reply.status(304).send();
    const type = extname(imagePath).toLowerCase() === '.jpg' ? 'image/jpeg' : 'image/png';
    return reply
      .type(type)
      .header('Cache-Control', 'private, no-cache')
      .header('Last-Modified', modified.toUTCString())
      .send(createReadStream(imagePath));
  });
}

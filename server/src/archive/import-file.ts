import { v4 as uuidv4 } from 'uuid';
import { getStore } from '../store/index.js';
import { rasterizePdf, getPageImageDimensions } from '../ingestion/rasterize.js';
import { normalisePhoto } from '../ingestion/photo.js';
import { beginJob, runQueued } from '../ingestion/jobs.js';
import { cleanLanguageCode } from '../languages.js';
import { scheduleSync } from '../similarity/index.js';
import { describeError } from '../failure.js';
import { logger } from '../logger.js';
import type { ManifestFile } from './manifest.js';
import type { DocType, UnstructuredElement } from '../types.js';

/**
 * Restores one upload from an export: turns its file into page images again, then writes the pages, documents and
 * everything read from them as the manifest says. No model is called: that is what an export is for, and why a
 * restore costs nothing and sends nothing off the host. Every id is made here (nothing in the manifest becomes one),
 * and the whole write is one transaction, so a manifest that does not fit its file leaves nothing behind.
 */
export function startRestore(
  userId: string, sourceFileId: string, filePath: string, isPhoto: boolean, file: ManifestFile, setAside: Set<number>,
  /** The doctor of this archive each person of the export is (`restoreDirectory`). Empty for a version 1 export, whose doctors are found by name. */
  people: Array<string | null>,
  /** Told once the upload is done: the new id of each of the file's documents in the manifest's order (null for one set aside), or null if it failed. */
  finished: (documentIds: Array<string | null> | null) => void = () => {},
): void {
  const job = beginJob(sourceFileId);
  if (!job) { finished(null); return; }
  runQueued(() => restore(userId, sourceFileId, filePath, isPhoto, file, setAside, people, job, finished)).catch(() => {});
}

async function restore(
  userId: string,
  sourceFileId: string,
  filePath: string,
  isPhoto: boolean,
  file: ManifestFile,
  setAside: Set<number>,
  people: Array<string | null>,
  job: { status: string; progress: number; step: string; error?: string },
  finished: (documentIds: Array<string | null> | null) => void,
): Promise<void> {
  const store = getStore();
  try {
    await store.sourceFiles.setStatus(userId, sourceFileId, 'processing');
    job.step = isPhoto ? 'preparing the photo' : 'rasterizing';
    job.progress = 5;
    const images = isPhoto ? await normalisePhoto(sourceFileId, filePath) : await rasterizePdf(sourceFileId, filePath);
    if (images.length !== file.page_count) throw new Error(`the file has ${images.length} pages but the export describes ${file.page_count}`);
    await store.sourceFiles.setPageCount(userId, sourceFileId, images.length);

    // The manifest must describe each page of the file once, and place each once.
    const bySource = new Map(file.pages.map(p => [p.source_page, p]));
    const places = new Set(file.pages.map(p => p.number));
    if (file.pages.length !== images.length || bySource.size !== images.length || places.size !== images.length
        || [...bySource.keys()].some(n => n > images.length) || [...places].some(n => n > images.length)) {
      throw new Error('the export does not describe the pages of its file');
    }
    for (const d of file.documents) {
      if (d.page_start > d.page_end || d.page_end > images.length) throw new Error('the export names pages its file does not have');
    }

    job.step = 'restoring';
    job.progress = 60;
    const documentIds: Array<string | null> = [];
    await store.transaction(async tx => {
      // Rows go in by their place in the file; the owner's arrangement is applied after, as moving a page does.
      const idBySource = new Map<number, string>();
      for (const page of [...file.pages].sort((a, b) => a.source_page - b.source_page)) {
        const id = uuidv4();
        idBySource.set(page.source_page, id);
        const image = images[page.source_page - 1];
        const { width, height } = getPageImageDimensions(image.image_path);
        await tx.pages.create(userId, {
          id, sourceFileId, pageNumber: page.source_page, imagePath: image.image_path, imageWidth: width, imageHeight: height,
          rawText: page.raw_text, elements: page.elements as UnstructuredElement[], extractionSource: page.extraction_source,
          isContinuation: null, continuationConfidence: null, continuationReasoning: null,
        });
      }
      const idByNumber = new Map(file.pages.map(p => [p.number, idBySource.get(p.source_page)!]));
      await tx.pages.renumber(userId, sourceFileId, [...file.pages].sort((a, b) => a.number - b.number).map(p => idBySource.get(p.source_page)!));
      for (const page of file.pages) if (page.hidden) await tx.pages.setHidden(userId, idBySource.get(page.source_page)!, true);

      const now = new Date().toISOString();
      for (const [index, d] of file.documents.entries()) {
        const docId = uuidv4();
        documentIds.push(setAside.has(index) ? null : docId);
        await tx.documents.create(userId, {
          id: docId, sourceFileId, pageStart: d.page_start, pageEnd: d.page_end,
          title: d.title?.trim() || null, docDate: d.doc_date, provider: d.provider, docType: d.doc_type as DocType | null,
          aiSummary: d.ai_summary, language: cleanLanguageCode(d.language),
        });
        await tx.documents.update(userId, docId, { user_notes: d.user_notes, reviewed: d.reviewed });
        if (d.owner_edited.length > 0) await tx.documents.setEditedColumns(userId, docId, d.owner_edited);
        await tx.fields.rememberRemoved(userId, docId, d.removed_fields);
        await tx.measurements.rememberRemoved(userId, docId, d.removed_measurements);
        await tx.tags.setForDocument(userId, docId, d.tags);
        // A field or result names a page by its place in the upload; one outside the document's range goes on its first page.
        const pageId = (n: number) => idByNumber.get(n >= d.page_start && n <= d.page_end ? n : d.page_start)!;
        for (const f of d.fields) {
          await tx.fields.create(userId, { id: uuidv4(), documentId: docId, pageId: pageId(f.page), label: f.label, value: f.value, groupNo: f.group_no, sourceSnippet: f.source_snippet, bbox: f.bbox, confidence: f.confidence, ownerEdited: f.owner_edited });
        }
        for (const m of d.measurements) {
          await tx.measurements.create(userId, {
            id: uuidv4(), documentId: docId, pageId: pageId(m.page), name: m.name, canonical: await tx.measurements.resolveCanonical(userId, m.canonical),
            valueText: m.value_text, valueNum: m.value_num, unit: m.unit, refLow: m.ref_low, refHigh: m.ref_high, flag: m.flag, takenOn: m.taken_on,
            sourceSnippet: m.source_snippet, bbox: m.bbox, confidence: m.confidence, ownerEdited: m.owner_edited,
          });
        }
        for (const doctor of d.doctors) {
          // A version 2 export says which person of its directory this is; a version 1 one is found by name and code.
          const id = (doctor.person !== null ? people[doctor.person] : null)
            ?? await tx.doctors.upsert(userId, { name: doctor.name, specialty: doctor.specialty, clinic: doctor.clinic, licenseCode: doctor.license_code, exactCode: true }, now);
          if (id) await tx.doctors.link(userId, docId, id, doctor.role, doctor.source, doctor.printed_code);
        }
        // A document already in the archive is kept out of sight rather than twice in the timeline, search and trends.
        if (setAside.has(index)) await tx.pages.setHiddenForDocument(userId, docId, true);
      }
    });

    await store.sourceFiles.setStatus(userId, sourceFileId, 'done');
    scheduleSync(userId); // an export carries no vectors
    job.status = 'done';
    job.progress = 100;
    job.step = 'complete';
    finished(documentIds);
  } catch (err) {
    const message = describeError(err);
    logger.error('restoring an upload from an export failed', { sourceFileId, error: message });
    await store.sourceFiles.setStatus(userId, sourceFileId, 'error', message);
    job.status = 'error';
    job.step = 'failed';
    job.error = message;
    finished(null);
  }
}

import { getStore } from '../store/index.js';
import { readsByModel } from '../file-kind.js';
import { logger } from '../logger.js';
import { describeError } from '../failure.js';
import { llmConcurrency } from '../config.js';
import { normaliseLicenseCode } from '../doctors.js';
import { announceUploadLater } from '../chat/notices.js';
import { scheduleSync } from '../similarity/index.js';
import { scheduleLinking } from '../linking/index.js';
import { rereadDocuments } from './document-reading.js';
import { readDigitalSigners, readSignatures } from './signatures.js';

/**
 * The second stage of reading an upload (SECURITY.md M-29). The first stage turns the file into pages and proposes how they group
 * into documents, using the configured parser and nothing that depends on the grouping. Only when the owner confirms the grouping
 * are the fields, results, summaries and doctors read from each document's text, once, so a grouping that was fixed by hand is not
 * read several times. A document that still `needs_reading` is one this has not read yet (or whose pages changed since).
 */
export interface ReadingJob {
  status: 'running' | 'done' | 'failed';
  step: string;
  progress: number;
  documents: number;
  read: number;
  /** Whether the grouping is confirmed when the reading ends. */
  confirming: boolean;
  started_at: string;
  finished_at?: string;
  error?: string;
}

const jobs = new Map<string, ReadingJob>();

export const getReadingJob = (sourceFileId: string): ReadingJob | undefined => jobs.get(sourceFileId);
export const isReadingUpload = (sourceFileId: string): boolean => jobs.get(sourceFileId)?.status === 'running';

/**
 * Reads every document of the upload that still needs it and, if `confirm`, confirms the grouping when that is over: the documents
 * then appear, are embedded and looked at for links. A document the model could not read stays marked, so it can be read again; it
 * does not hold the others back. Runs in the background; a restart stops it, and confirming again continues.
 */
export function startReadingUpload(userId: string, sourceFileId: string, confirm: boolean): ReadingJob {
  const running = jobs.get(sourceFileId);
  if (running?.status === 'running') return running;
  const job = begin(sourceFileId, confirm);
  void run(userId, sourceFileId, confirm, job);
  return job;
}

/** The same, waiting for it to end. For tests and for anything that has to continue afterwards. */
export async function readUpload(userId: string, sourceFileId: string, confirm: boolean): Promise<ReadingJob> {
  const running = jobs.get(sourceFileId);
  if (running?.status === 'running') return running;
  const job = begin(sourceFileId, confirm);
  await run(userId, sourceFileId, confirm, job);
  return job;
}

function begin(sourceFileId: string, confirm: boolean): ReadingJob {
  const job: ReadingJob = { status: 'running', step: 'reading the documents', progress: 0, documents: 0, read: 0, confirming: confirm, started_at: new Date().toISOString() };
  jobs.set(sourceFileId, job);
  return job;
}

/** Tests only. */
export function resetReadingJobs(): void {
  jobs.clear();
}

async function run(userId: string, sourceFileId: string, confirm: boolean, job: ReadingJob): Promise<void> {
  {
    const store = getStore();
    try {
      const file = await store.sourceFiles.findFor(userId, sourceFileId);
      if (!file) throw new Error('the upload is gone');
      const docs = await store.documents.listFor(userId, { sourceFileId, includeHidden: true, includeUnconfirmed: true, limit: 1000, offset: 0 });
      const todo = docs.filter(d => d.needs_reading).sort((a, b) => a.page_start - b.page_start);
      job.documents = todo.length;

      // In groups of the model concurrency, so the progress moves and a stop between groups loses nothing.
      const readIds: string[] = [];
      const step = Math.max(1, llmConcurrency());
      for (let i = 0; i < todo.length; i += step) {
        const group = todo.slice(i, i + step);
        const worked = await rereadDocuments(userId, group.map(d => d.id));
        group.forEach((d, k) => { if (worked[k]) readIds.push(d.id); });
        job.read = i + group.length;
        job.progress = Math.round((job.read / Math.max(1, todo.length)) * 90);
      }
      if (todo.length > 0 && readIds.length === 0) throw new Error('the model could not read any of the documents');

      // Doctors named by a stamp or a signature: they belong to documents, so they are filed once the documents are read.
      job.step = 'reading signatures';
      await fileSignatures(userId, sourceFileId, file.file_path, readsByModel(file), readIds);

      if (confirm) {
        await store.sourceFiles.setGroupingConfirmed(userId, sourceFileId, true);
        scheduleSync(userId);
        scheduleLinking(userId, (await store.documents.listFor(userId, { sourceFileId, limit: 1000, offset: 0 })).map(d => d.id));
      }
      job.status = 'done'; job.step = 'complete'; job.progress = 100; job.finished_at = new Date().toISOString();
      logger.info('an upload was read', { sourceFileId, documents: todo.length, read: readIds.length });
      announceUploadLater(userId, sourceFileId, 'read');
    } catch (err) {
      logger.warn('reading an upload failed', { sourceFileId, error: describeError(err) });
      job.status = 'failed'; job.step = 'failed'; job.error = describeError(err); job.finished_at = new Date().toISOString();
    }
  }
}

/** Stamps (pictures, so only with image reading allowed) and digital signatures name an author of the document they end. */
async function fileSignatures(userId: string, sourceFileId: string, filePath: string, isPhoto: boolean, documentIds: string[]): Promise<void> {
  if (isPhoto || documentIds.length === 0) return;
  const store = getStore();
  const docs = (await Promise.all(documentIds.map(id => store.documents.findFor(userId, id)))).filter((d): d is NonNullable<typeof d> => !!d);
  try {
    const stamps = await readSignatures(filePath, docs.map(d => d.page_end));
    if (stamps.size > 0) {
      await store.transaction(async tx => {
        const now = new Date().toISOString();
        for (const d of docs) {
          for (const doctor of stamps.get(d.page_end) ?? []) {
            // A stamp is a signature: whoever signed wrote it.
            const id = await tx.doctors.upsert(userId, { name: doctor.name, specialty: doctor.specialty, clinic: d.provider, licenseCode: doctor.code }, now);
            if (id) await tx.doctors.link(userId, d.id, id, 'author', 'stamp', normaliseLicenseCode(doctor.code));
          }
        }
      });
    }
  } catch (err) {
    // The documents are read; a signature that could not be filed does not undo that.
    logger.warn('could not file the doctors read from signature stamps', { sourceFileId, error: describeError(err) });
  }
  try {
    const signers = await readDigitalSigners(filePath);
    if (signers.length > 0) {
      await store.transaction(async tx => {
        const now = new Date().toISOString();
        for (const d of docs) {
          for (const signer of signers) {
            const id = await tx.doctors.upsert(userId, { name: signer.name, clinic: d.provider }, now);
            if (id) await tx.doctors.link(userId, d.id, id, 'author', 'signature');
          }
        }
      });
    }
  } catch (err) {
    logger.warn('could not file the doctors who signed the PDF', { sourceFileId, error: describeError(err) });
  }
}

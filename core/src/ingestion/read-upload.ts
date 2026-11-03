import { readsByModel } from '../file-kind.js';
import { logger } from '../logger.js';
import { describeError } from '../failure.js';
import { llmConcurrency } from '../config.js';
import { limiter } from '../concurrency.js';
import { normaliseLicenseCode } from '../doctors.js';
import { announceUploadLater } from '../chat/notices.js';
import { scheduleSync } from '../similarity/index.js';
import { scheduleLinking } from '../linking/index.js';
import { scheduleEpisodes } from '../episodes/index.js';
import { readDocumentsOrWait } from './document-reading.js';
import { getAccountsStore, getStore } from '../store/index.js';
import { modelAnswered, waitForModel, type ModelWaiting } from './model-wait.js';
import { readDigitalSigners, readSignatures } from './signatures.js';

/**
 * The second stage of reading an upload (SECURITY.md M-29). The first stage turns the file into pages and proposes how they group
 * into documents, using the configured parser and nothing that depends on the grouping. Only when the owner confirms the grouping
 * are the fields, results, summaries and doctors read from each document's text, once, so a grouping that was fixed by hand is not
 * read several times. A document that still `needs_reading` is one this has not read yet (or whose pages changed since).
 */
export interface ReadingJob {
  /** `waiting`: some documents could not be read because the model could not be asked; they are read by themselves later (`waiting`). */
  status: 'running' | 'done' | 'failed' | 'waiting';
  step: string;
  progress: number;
  documents: number;
  read: number;
  /** Whether the grouping is confirmed when the reading ends. */
  confirming: boolean;
  started_at: string;
  finished_at?: string;
  error?: string;
  waiting?: ModelWaiting;
}

const jobs = new Map<string, ReadingJob>();

/**
 * One upload is read at a time; the documents of each are read several at once (`llmConcurrency`). Not for the model's sake: a reading
 * writes each document in a transaction, and two readings writing at once on the one connection collide ("cannot start a transaction
 * within a transaction"). They would, when the readings that waited for the model start again together (after midnight, at start-up).
 */
const lane = limiter(1);

export const getReadingJob = (sourceFileId: string): ReadingJob | undefined => jobs.get(sourceFileId);
export const isReadingUpload = (sourceFileId: string): boolean => jobs.get(sourceFileId)?.status === 'running';

/**
 * Reads every document of the upload that still needs it and, if `confirm`, confirms the grouping when that is over: the documents
 * then appear, are embedded and looked at for links. A document the model could not read stays marked, so it can be read again; it
 * does not hold the others back. One it could not be asked about (a daily limit, an outage) is read again by itself later, and the
 * job says `waiting` until then. Runs in the background; a restart stops it, and the next start continues (`resumeUnreadDocuments`).
 */
export function startReadingUpload(userId: string, sourceFileId: string, confirm: boolean): ReadingJob {
  const running = jobs.get(sourceFileId);
  if (running?.status === 'running') return running;
  const job = begin(sourceFileId, confirm);
  void lane(() => run(userId, sourceFileId, confirm, job));
  return job;
}

/** The same, waiting for it to end. For tests and for anything that has to continue afterwards. */
export async function readUpload(userId: string, sourceFileId: string, confirm: boolean): Promise<ReadingJob> {
  const running = jobs.get(sourceFileId);
  if (running?.status === 'running') return running;
  const job = begin(sourceFileId, confirm);
  await lane(() => run(userId, sourceFileId, confirm, job));
  return job;
}

function begin(sourceFileId: string, confirm: boolean): ReadingJob {
  const job: ReadingJob = { status: 'running', step: 'reading the documents', progress: 0, documents: 0, read: 0, confirming: confirm, started_at: new Date().toISOString() };
  jobs.set(sourceFileId, job);
  return job;
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
      let wait: unknown = null;
      const step = Math.max(1, llmConcurrency());
      for (let i = 0; i < todo.length; i += step) {
        const group = todo.slice(i, i + step);
        const outcome = await readDocumentsOrWait(userId, group.map(d => d.id));
        group.forEach((d, k) => { if (outcome.read[k]) readIds.push(d.id); });
        wait ??= outcome.wait;
        job.read = i + group.length;
        job.progress = Math.round((job.read / Math.max(1, todo.length)) * 90);
      }
      // Some could not be read because the model could not be asked: they are read by themselves later, and the owner's confirmation
      // stands (below), so what was read is shown and the rest appear when they are read. Not a failure: nothing is given up.
      const waiting = wait ? readLater(userId, sourceFileId, wait) : null;
      if (todo.length > 0 && readIds.length === 0 && !waiting) throw new Error('the model could not read any of the documents');

      // Doctors named by a stamp or a signature: they belong to documents, so they are filed once the documents are read.
      job.step = 'reading signatures';
      await fileSignatures(userId, sourceFileId, file.file_path, readsByModel(file), readIds);

      if (confirm) {
        await store.sourceFiles.setGroupingConfirmed(userId, sourceFileId, true);
        scheduleSync(userId);
        scheduleLinking(userId, (await store.documents.listFor(userId, { sourceFileId, limit: 1000, offset: 0 })).map(d => d.id));
        scheduleEpisodes(userId);
      }
      if (waiting) {
        job.status = 'waiting'; job.step = 'waiting for the model'; job.waiting = waiting; job.error = describeError(wait);
        logger.warn('documents of an upload wait for the model', { sourceFileId, documents: todo.length, read: readIds.length, reason: waiting.reason, retryAt: waiting.retry_at });
        return;
      }
      modelAnswered(`read:${sourceFileId}`);
      job.status = 'done'; job.step = 'complete'; job.progress = 100; job.finished_at = new Date().toISOString();
      logger.info('an upload was read', { sourceFileId, documents: todo.length, read: readIds.length });
      announceUploadLater(userId, sourceFileId, 'read');
    } catch (err) {
      logger.warn('reading an upload failed', { sourceFileId, error: describeError(err) });
      job.status = 'failed'; job.step = 'failed'; job.error = describeError(err); job.finished_at = new Date().toISOString();
    }
  }
}

/**
 * Plans another reading of the upload's unread documents for when the model can be asked, if `err` says it could not be; null if
 * `err` is not a failure to wait out. For a reading that ran here, and for the routes that read documents of an upload themselves
 * (a split, a merge, regrouping's "Done"): a document they could not read for that reason is not left unread for good.
 */
export function readLater(userId: string, sourceFileId: string, err: unknown): ModelWaiting | null {
  const waiting = waitForModel(`read:${sourceFileId}`, err, () => startReadingUpload(userId, sourceFileId, false));
  if (!waiting) return null;
  // What the screens see until then, unless a reading is running and will say so itself.
  if (jobs.get(sourceFileId)?.status !== 'running') {
    jobs.set(sourceFileId, { status: 'waiting', step: 'waiting for the model', progress: 0, documents: 0, read: 0, confirming: false, started_at: new Date().toISOString(), waiting, error: describeError(err) });
  }
  return waiting;
}

/**
 * Start-up: reads the documents that uploads whose grouping is confirmed still hold unread, for every account on this core, so a reading
 * that waited for the model, or was stopped by a closed page, goes on. A document the model refused stays unread and is tried again.
 */
export async function resumeUnreadDocuments(): Promise<number> {
  const uploads = await getAccountsStore().maintenance.uploadsWithUnreadDocuments();
  for (const upload of uploads) startReadingUpload(upload.user_id, upload.id, false);
  return uploads.length;
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
            if (id) await tx.doctors.link(userId, d.id, id, 'author', signer.verified ? 'verified_signature' : 'signature');
          }
        }
      });
    }
  } catch (err) {
    logger.warn('could not file the doctors who signed the PDF', { sourceFileId, error: describeError(err) });
  }
}

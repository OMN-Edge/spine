import { fileSystem } from '../files.js';
import { sha256Hex } from '../digest.js';
import { getStore } from '../store/index.js';
import { newUploadPath } from '../ingestion/accept-upload.js';
import { textToPdf } from '../ingestion/text-pdf.js';
import { removeUploadFiles } from '../ingestion/remove-upload.js';
import { startRestore } from '../archive/import-file.js';
import { getJobStatus } from '../ingestion/jobs.js';
import { demoRecords, type DemoLanguage } from './records.js';
import { scheduleEpisodes } from '../episodes/index.js';

/**
 * "Explore with sample records" (FR-ACC-03): invented records written into the person's own archive through the restore path
 * (the page images are made again, nothing is read by a model), marked as samples, and removed again in one step. Nothing of them
 * is shared with any other account, and the sample is not a second kind of account: it is ordinary records the person can see,
 * edit and share like any other, which is the point of trying it.
 */
export async function loadDemo(userId: string, lang: DemoLanguage): Promise<'loaded' | 'already'> {
  const store = getStore();
  if ((await store.sourceFiles.listFor(userId)).some(u => u.sample)) return 'already';

  // Once every record is in, the episodes are looked for, as they are after an upload is read, so the samples show a suggested one.
  const records = demoRecords(lang);
  let left = records.length;
  const oneDone = () => { if (--left === 0) void finish(userId); };
  for (const demo of records) {
    const { fileId, filePath } = newUploadPath(userId, '.pdf');
    await textToPdf(demo.text, filePath);
    const checksum = sha256Hex(fileSystem().readFileSync(filePath));
    await store.sourceFiles.create(userId, {
      id: fileId, uploadedAt: new Date().toISOString(), originalFilename: demo.file.original_filename, filePath, mimeType: 'application/pdf', checksum, sample: true, fromExport: true,
    });
    startRestore(userId, fileId, filePath, false, demo.file, new Set(), [], oneDone);
  }
  return 'loaded';
}

/**
 * Nothing reads the sample records with a model, so nothing looks for links either: the visit's prescription and the X-ray a week later are linked here as a suggestion (as the search would
 * after an upload), so the sample shows a suggested link and, from it, a suggested episode. The owner can confirm or dismiss both like any other.
 */
async function finish(userId: string): Promise<void> {
  try {
    const store = getStore();
    const docs = (await store.documents.listFor(userId, { limit: 100, offset: 0 })).filter(d => d.doc_date);
    const prescription = docs.find(d => d.doc_type === 'prescription');
    const imaging = docs.find(d => d.doc_type === 'imaging');
    if (prescription && imaging) {
      const [from, to] = prescription.doc_date! <= imaging.doc_date! ? [prescription, imaging] : [imaging, prescription];
      await store.links.add(userId, { from_document_id: from.id, to_document_id: to.id, kind: 'same_episode', source: 'auto', state: 'proposed', reason: null }, new Date().toISOString());
    }
  } catch { /* the samples are still there without it */ }
  scheduleEpisodes(userId, 0);
}

/** What the sample is doing: whether any is held, and whether it is still being set up. */
export async function demoState(userId: string): Promise<{ loaded: boolean; processing: boolean }> {
  const samples = (await getStore().sourceFiles.listFor(userId)).filter(u => u.sample);
  return { loaded: samples.length > 0, processing: samples.some(u => u.status === 'pending' || u.status === 'processing' || getJobStatus(u.id)?.status === 'processing') };
}

/** Removes the sample records and nothing else. */
export async function removeDemo(userId: string): Promise<'removed' | 'busy' | 'none'> {
  const store = getStore();
  const samples = (await store.sourceFiles.listFor(userId)).filter(u => u.sample);
  if (samples.length === 0) return 'none';
  if ((await demoState(userId)).processing) return 'busy';
  for (const s of samples) {
    const file = await store.sourceFiles.findFor(userId, s.id);
    if (!file) continue;
    removeUploadFiles(userId, file);
    await store.sourceFiles.delete(userId, s.id);
  }
  return 'removed';
}


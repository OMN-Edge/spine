import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { getStore } from '../store/index.js';
import { newUploadPath } from '../ingestion/accept-upload.js';
import { textToPdf } from '../ingestion/convert.js';
import { removeUploadFiles } from '../ingestion/remove-upload.js';
import { startRestore } from '../archive/import-file.js';
import { getJobStatus } from '../ingestion/jobs.js';
import { demoRecords, type DemoLanguage } from './records.js';

/**
 * "Explore with sample records" (FR-ACC-03): invented records written into the person's own archive through the restore path
 * (the page images are made again, nothing is read by a model), marked as samples, and removed again in one step. Nothing of them
 * is shared with any other account, and the sample is not a second kind of account: it is ordinary records the person can see,
 * edit and share like any other, which is the point of trying it.
 */
export async function loadDemo(userId: string, lang: DemoLanguage): Promise<'loaded' | 'already'> {
  const store = getStore();
  if ((await store.sourceFiles.listFor(userId)).some(u => u.sample)) return 'already';

  for (const demo of demoRecords(lang)) {
    const { fileId, filePath } = newUploadPath(userId, '.pdf');
    await textToPdf(demo.text, filePath);
    const checksum = createHash('sha256').update(readFileSync(filePath)).digest('hex');
    await store.sourceFiles.create(userId, {
      id: fileId, uploadedAt: new Date().toISOString(), originalFilename: demo.file.original_filename, filePath, mimeType: 'application/pdf', checksum, sample: true,
    });
    startRestore(userId, fileId, filePath, false, demo.file, new Set(), []);
  }
  return 'loaded';
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


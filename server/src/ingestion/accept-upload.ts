import { createHash } from 'crypto';
import { createWriteStream, mkdirSync, rmSync } from 'fs';
import path from 'path';
import type { Readable } from 'stream';
import { v4 as uuidv4 } from 'uuid';
import { getStore } from '../store/index.js';
import { resolveDataDir } from '../config.js';
import { detectFileKind, isImage, MIME_OF } from '../file-kind.js';
import { aiReadingAllowed } from '../parser/index.js';
import { getJobStatus, startIngestionJob } from './pipeline.js';

/** Where a new original goes: per user, so a filesystem mistake cannot cross users as easily as a query mistake (M-9). The id is ours, never input. */
export function newUploadPath(userId: string, ext: string): { fileId: string; filePath: string } {
  const fileId = uuidv4();
  const outDir = path.join(resolveDataDir(), 'originals', userId, new Date().getFullYear().toString());
  mkdirSync(outDir, { recursive: true });
  return { fileId, filePath: path.join(outDir, `${fileId}${ext}`) };
}

/** The first bytes of a zip: "PK" and a local-header or end-of-archive marker. */
const looksLikeZip = (head: Buffer) =>
  head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && ((head[2] === 3 && head[3] === 4) || (head[2] === 5 && head[3] === 6));

/**
 * Writes a stream to disk and gives its sha256 and size. The limit depends on what the first bytes say it is: a zip may
 * be large (it can hold many files), anything else is one document or photo and is cut off much sooner, so a request
 * cannot make the server write gigabytes of something it will then refuse. If it stops at a limit, `truncated` says so.
 */
export async function saveStream(source: Readable, filePath: string, limits: { zip: number; other: number }): Promise<{ checksum: string; bytes: number; truncated: boolean; zip: boolean }> {
  const hash = createHash('sha256');
  const out = createWriteStream(filePath);
  let bytes = 0;
  let truncated = false;
  let zip = false;
  let limit = limits.other;
  await new Promise<void>((resolve, reject) => {
    source.on('data', (chunk: Buffer) => {
      if (truncated) return; // draining what is left of a stream we have stopped keeping
      if (bytes === 0) { zip = looksLikeZip(chunk); limit = zip ? limits.zip : limits.other; }
      bytes += chunk.length;
      if (bytes > limit) { truncated = true; out.end(); source.resume(); return; }
      hash.update(chunk);
      if (!out.write(chunk)) { source.pause(); out.once('drain', () => source.resume()); }
    });
    source.on('end', () => { if (!truncated) out.end(); });
    out.on('finish', resolve);
    out.on('error', reject);
    source.on('error', reject);
  });
  // A stream cut by the multipart limit flags itself instead of failing.
  truncated ||= !!(source as Readable & { truncated?: boolean }).truncated;
  return { checksum: hash.digest('hex'), bytes, truncated, zip };
}

/**
 * Runs an upload that failed again. A failure (the provider was down, a page could not be read) is not
 * the file's fault, and the original is still held, so it should not take re-uploading, which would be
 * refused as a duplicate of the failed one. Only a failed upload qualifies, and not while a job runs.
 */
export async function retryFailedUpload(userId: string, id: string): Promise<'started' | 'not_found' | 'not_failed'> {
  const file = await getStore().sourceFiles.findFor(userId, id);
  if (!file) return 'not_found';
  if (file.status !== 'error' || getJobStatus(id)?.status === 'processing') return 'not_failed';
  startIngestionJob(id, userId, { retry: true });
  return 'started';
}

export type UploadOutcome =
  | { id: string; status: 'processing'; retried?: true }
  | { skipped: true; reason: 'not_pdf' | 'photo_needs_ai' | 'too_large'; filename: string | null }
  | { skipped: true; reason: 'duplicate'; existing_id: string };

/**
 * A file that has just been written to `filePath` becomes an upload, or is refused and removed: only what can be
 * read is kept, and a copy of one already held is not. Shared by a file sent on its own and one found in a zip.
 */
export async function acceptFile(userId: string, file: { id: string; path: string; filename: string | null; checksum: string }): Promise<UploadOutcome> {
  const store = getStore();
  const kind = detectFileKind(file.path);
  if (kind === null) {
    rmSync(file.path, { force: true });
    return { skipped: true, reason: 'not_pdf', filename: file.filename };
  }
  // A photo has no text for anything local to read, so the model reads it, and that sends the
  // image off this host: refused, with the reason, unless the operator has allowed it.
  if (isImage(kind) && !aiReadingAllowed()) {
    rmSync(file.path, { force: true });
    return { skipped: true, reason: 'photo_needs_ai', filename: file.filename };
  }

  const existing = await store.sourceFiles.findByChecksumFor(userId, file.checksum);
  if (existing) {
    rmSync(file.path, { force: true });
    // The same file again after it failed is a request to try again, not a duplicate of nothing.
    if (existing.status === 'error' && (await retryFailedUpload(userId, existing.id)) === 'started') {
      return { id: existing.id, status: 'processing', retried: true };
    }
    return { skipped: true, reason: 'duplicate', existing_id: existing.id };
  }

  await store.sourceFiles.create(userId, {
    id: file.id,
    uploadedAt: new Date().toISOString(),
    originalFilename: file.filename,
    filePath: file.path,
    mimeType: MIME_OF[kind], // what it is, not what the browser called it
    checksum: file.checksum,
  });
  startIngestionJob(file.id, userId);
  return { id: file.id, status: 'processing' };
}

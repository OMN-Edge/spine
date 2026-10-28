import { fileSystem } from '../files.js';
import { sha256 } from '../digest.js';
import path from 'path';
import type { ByteSource } from '../http.js';
import { v4 as uuidv4 } from 'uuid';
import { getStore } from '../store/index.js';
import { resolveDataDir } from '../config.js';
import { detectFileKind, isImage, localOcrReadsPhotoSets, MIME_OF } from '../file-kind.js';
import { aiReadingAllowed } from '../parser/index.js';
import { getJobStatus, startIngestionJob } from './pipeline.js';
import { bundlePhotos, MAX_PHOTOS_IN_SET } from './photo-set.js';
import { sha256OfFileSync } from './checksum.js';
import { convertUpload, looksLikeHeic } from './convert.js';
import { demoLimits, demoUploadsUsed } from '../demo/limits.js';

/** Where a new original goes: per user, so a filesystem mistake cannot cross users as easily as a query mistake (M-9). The id is ours, never input. */
export function newUploadPath(userId: string, ext: string): { fileId: string; filePath: string } {
  const fileId = uuidv4();
  const outDir = path.join(resolveDataDir(), 'originals', userId, new Date().getFullYear().toString());
  fileSystem().mkdirSync(outDir);
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
export async function saveStream(source: ByteSource, filePath: string, limits: { zip: number; other: number }): Promise<{ checksum: string; bytes: number; truncated: boolean; zip: boolean }> {
  const hash = sha256();
  const out = fileSystem().writeStream(filePath);
  let bytes = 0;
  let truncated = false;
  let zip = false;
  let limit = limits.other;
  try {
    for await (const chunk of source) {
      if (truncated) continue; // draining what is left of a stream we have stopped keeping
      if (bytes === 0) { zip = looksLikeZip(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)); limit = zip ? limits.zip : limits.other; }
      bytes += chunk.length;
      if (bytes > limit) { truncated = true; await out.end(); continue; }
      hash.update(chunk);
      await out.write(chunk);
    }
    if (!truncated) await out.end();
  } catch (err) {
    await out.end().catch(() => undefined);
    throw err;
  }
  // A stream cut by the multipart limit flags itself instead of failing.
  truncated ||= !!source.truncated;
  return { checksum: hash.hex(), bytes, truncated, zip };
}

/** Reads a stream to its end and keeps none of it, so the request that carries it can finish. */
export async function drain(source: ByteSource): Promise<void> {
  for await (const _chunk of source) void _chunk;
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
  | { skipped: true; reason: 'not_pdf' | 'photo_needs_ai' | 'too_large' | 'too_many'; filename: string | null }
  /** The demo's uploads are used up (`demo/limits.ts`). */
  | { skipped: true; reason: 'demo_limit'; filename: string | null }
  | { skipped: true; reason: 'duplicate'; existing_id: string };

/**
 * A file that has just been written to `filePath` becomes an upload, or is refused and removed: only what can be
 * read is kept, and a copy of one already held is not. Shared by a file sent on its own and one found in a zip.
 */
export async function acceptFile(userId: string, file: { id: string; path: string; filename: string | null; checksum: string; chatConversationId?: string | null }): Promise<UploadOutcome> {
  const store = getStore();
  // A HEIC photo, a Word document or a text file is made into a JPEG or a PDF first; the file kept is the converted one,
  // the checksum stays that of what was sent so a repeat is still recognised.
  if (detectFileKind(file.path) === null) {
    try {
      const converted = await convertUpload(file.path);
      if (converted) file = { ...file, path: converted.path };
    } catch {
      fileSystem().rmSync(file.path);
      return { skipped: true, reason: 'not_pdf', filename: file.filename };
    }
  }
  const kind = detectFileKind(file.path);
  if (kind === null) {
    fileSystem().rmSync(file.path);
    return { skipped: true, reason: 'not_pdf', filename: file.filename };
  }
  // A photo has no text for anything local to read, so the model reads it, and that sends the
  // image off this host: refused, with the reason, unless the operator has allowed it.
  if (isImage(kind) && !aiReadingAllowed()) {
    fileSystem().rmSync(file.path);
    return { skipped: true, reason: 'photo_needs_ai', filename: file.filename };
  }

  const existing = await store.sourceFiles.findByChecksumFor(userId, file.checksum);
  if (existing) {
    fileSystem().rmSync(file.path);
    // The same file again after it failed is a request to try again, not a duplicate of nothing.
    if (existing.status === 'error' && (await retryFailedUpload(userId, existing.id)) === 'started') {
      return { id: existing.id, status: 'processing', retried: true };
    }
    return { skipped: true, reason: 'duplicate', existing_id: existing.id };
  }
  const limits = demoLimits();
  if (limits && (await demoUploadsUsed(userId, limits))) {
    fileSystem().rmSync(file.path);
    return { skipped: true, reason: 'demo_limit', filename: file.filename };
  }

  await store.sourceFiles.create(userId, {
    id: file.id,
    uploadedAt: new Date().toISOString(),
    originalFilename: file.filename,
    filePath: file.path,
    mimeType: MIME_OF[kind], // what it is, not what the browser called it
    checksum: file.checksum,
    chatConversationId: file.chatConversationId ?? null,
  });
  startIngestionJob(file.id, userId);
  return { id: file.id, status: 'processing' };
}

/**
 * Photos already written to `files`, in the order they are pages, become one upload: one PDF, a page each, that a model reads like a
 * single photo. The set is refused as a whole if any file is not a photo, if reading by a model is not allowed, or if there are
 * too many; one already held (the same photos in the same order) is a duplicate.
 */
export async function acceptPhotoSet(userId: string, files: Array<{ path: string; filename: string | null }>): Promise<UploadOutcome> {
  const store = getStore();
  if (files.length === 0) return { skipped: true, reason: 'not_pdf', filename: null };
  if (files.length > MAX_PHOTOS_IN_SET) return { skipped: true, reason: 'too_many', filename: null };
  if (!aiReadingAllowed() && !localOcrReadsPhotoSets()) return { skipped: true, reason: 'photo_needs_ai', filename: files[0].filename };
  for (const file of files) {
    // An iPhone's HEIC photo is made a JPEG first; sharp has no decoder for it.
    if (detectFileKind(file.path) === null && looksLikeHeic(file.path)) {
      try {
        const converted = await convertUpload(file.path);
        if (converted) file.path = converted.path;
      } catch {
        return { skipped: true, reason: 'not_pdf', filename: file.filename };
      }
    }
    if (!isImage(detectFileKind(file.path))) return { skipped: true, reason: 'not_pdf', filename: file.filename };
  }

  const { fileId, filePath } = newUploadPath(userId, '.pdf');
  try {
    await bundlePhotos(files.map(f => f.path), filePath);
  } catch {
    fileSystem().rmSync(filePath);
    return { skipped: true, reason: 'not_pdf', filename: files[0].filename }; // a photo that cannot be decoded is not one
  }
  const checksum = sha256OfFileSync(filePath);
  const existing = await store.sourceFiles.findByChecksumFor(userId, checksum);
  if (existing) {
    fileSystem().rmSync(filePath);
    if (existing.status === 'error' && (await retryFailedUpload(userId, existing.id)) === 'started') return { id: existing.id, status: 'processing', retried: true };
    return { skipped: true, reason: 'duplicate', existing_id: existing.id };
  }
  const limits = demoLimits();
  if (limits && (await demoUploadsUsed(userId, limits))) {
    fileSystem().rmSync(filePath);
    return { skipped: true, reason: 'demo_limit', filename: files[0].filename };
  }
  const first = (files[0].filename ?? 'photo').replace(/\.[^.]*$/, '').slice(0, 80) || 'photo';
  await store.sourceFiles.create(userId, {
    id: fileId, uploadedAt: new Date().toISOString(), originalFilename: `${first} (${files.length} photos).pdf`,
    filePath, mimeType: MIME_OF.pdf, checksum, photoSet: true,
  });
  startIngestionJob(fileId, userId);
  return { id: fileId, status: 'processing' };
}

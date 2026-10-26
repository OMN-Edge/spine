import { fileSystem } from '../files.js';
import type { UploadPart } from '../http.js';
import path from 'path';
import { importZip } from '../archive/import.js';
import { looksLikeDocx } from './convert.js';
import { MAX_PHOTOS_IN_SET } from './photo-set.js';
import { keepUnprocessed } from './raw-originals.js';
import { acceptFile, acceptPhotoSet, drain, newUploadPath, saveStream, type UploadOutcome } from './accept-upload.js';

/** A document or a photo. */
export const MAX_FILE_BYTES = 200 * 1024 * 1024;
/** A zip of them, which the request limit in `index.ts` must allow. */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

type Part = UploadPart;

/** Thrown by `conversationFor` to stop before any file of the request is saved. */
export class AttachRefused extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'AttachRefused';
  }
}

/**
 * The files of a multipart request become uploads, one result each (a zip several): the one place a file arriving from the
 * browser is accepted, for the Upload page and for a file attached in the chat. Nothing about acceptance differs between them; the
 * chat only says which conversation the file was attached in, so what happens to it is reported there.
 *
 * `conversationFor` is called once, with the form fields seen so far, when the first file arrives (so a field sent before the files
 * can name the conversation); it returns the conversation to tie the files to, or null.
 */
export async function acceptParts(
  userId: string,
  parts: AsyncIterable<Part>,
  options: { conversationFor?: (fields: Record<string, string>) => Promise<string | null> } = {},
): Promise<Array<UploadOutcome | Record<string, unknown>>> {
  const results: Array<UploadOutcome | Record<string, unknown>> = [];
  const fields: Record<string, string> = {};
  let conversation: string | null | undefined;

  for await (const part of parts) {
    if (part.type !== 'file') {
      if (typeof part.value === 'string') fields[part.fieldname] = part.value;
      continue;
    }
    if (conversation === undefined) conversation = options.conversationFor ? await options.conversationFor(fields) : null;

    const ext = path.extname(part.filename ?? '.pdf') || '.pdf';
    const { fileId, filePath } = newUploadPath(userId, ext);
    // A zip may hold many files, so the request limit is its limit; anything else is one document or photo.
    const { checksum, truncated, zip } = await saveStream(part.file, filePath, { zip: MAX_UPLOAD_BYTES, other: MAX_FILE_BYTES });

    // A Word document is a zip too, but it is one document, not an archive of files.
    if (zip && !truncated && (await looksLikeDocx(filePath))) {
      results.push(await acceptFile(userId, { id: fileId, path: filePath, filename: part.filename ?? null, checksum, chatConversationId: conversation }));
      continue;
    }
    if (zip) {
      try {
        if (truncated) results.push({ skipped: true, reason: 'too_large', filename: part.filename ?? null });
        else results.push(...(await importZip(userId, filePath, part.filename ?? null)));
      } finally {
        fileSystem().rmSync(filePath); // the zip itself is not kept: its contents are
      }
      continue;
    }
    if (truncated) {
      fileSystem().rmSync(filePath);
      results.push({ skipped: true, reason: 'too_large', filename: part.filename ?? null });
      continue;
    }
    results.push(await acceptFile(userId, { id: fileId, path: filePath, filename: part.filename ?? null, checksum, chatConversationId: conversation }));
  }
  return results;
}

/**
 * Several photos of one document (a request whose files are all photos, in the order sent) become one upload whose pages they are.
 * Each is saved to a name of its own and checked by what is in it; if any is not a photo, is too large, or the operator has not
 * allowed images to be read by a model, nothing is made and the one result says why.
 */
export async function acceptPhotoParts(userId: string, parts: AsyncIterable<Part>): Promise<Array<UploadOutcome | Record<string, unknown>>> {
  const saved: Array<{ path: string; filename: string | null }> = [];
  // A scan session also sends each photo as it was taken, before straightening, in the same order, as `originals` (FR-ING-09).
  const raws: Array<{ path: string }> = [];
  let refusal: Record<string, unknown> | null = null;
  try {
    for await (const part of parts) {
      if (part.type !== 'file') continue;
      if (part.fieldname === 'originals') {
        if (raws.length >= MAX_PHOTOS_IN_SET) { void drain(part.file); continue; }
        const { filePath } = newUploadPath(userId, '.raw');
        raws.push({ path: filePath });
        const { truncated } = await saveStream(part.file, filePath, { zip: MAX_FILE_BYTES, other: MAX_FILE_BYTES });
        if (truncated && !refusal) refusal = { skipped: true, reason: 'too_large', filename: part.filename ?? null };
        continue;
      }
      if (saved.length > MAX_PHOTOS_IN_SET) { void drain(part.file); continue; } // one past the limit says "too many"; the rest are not kept
      const { filePath } = newUploadPath(userId, '.photo');
      saved.push({ path: filePath, filename: part.filename ?? null });
      const { truncated } = await saveStream(part.file, filePath, { zip: MAX_FILE_BYTES, other: MAX_FILE_BYTES });
      if (truncated && !refusal) refusal = { skipped: true, reason: 'too_large', filename: part.filename ?? null };
    }
    if (refusal) return [refusal];
    const outcome = await acceptPhotoSet(userId, saved);
    if ('id' in outcome && raws.length > 0) await keepUnprocessed(userId, outcome.id, raws.map(r => r.path));
    return [outcome];
  } finally {
    for (const file of saved) fileSystem().rmSync(file.path);
    for (const file of raws) fileSystem().rmSync(file.path);
  }
}

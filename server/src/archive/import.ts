import { rmSync } from 'fs';
import path from 'path';
import { getStore } from '../store/index.js';
import { acceptFile, newUploadPath } from '../ingestion/accept-upload.js';
import { detectFileKind, MIME_OF } from '../file-kind.js';
import { logger } from '../logger.js';
import { claimsToBeExport, documentFingerprint, READABLE_VERSIONS, MANIFEST_NAME, MAX_MANIFEST_BYTES, manifestSchema, type Manifest } from './manifest.js';
import { startRestore } from './import-file.js';
import { LinkRestore } from './import-links.js';
import { restoreDirectory } from './directory.js';
import { ZipReader, ZipTooLarge } from './zip-read.js';

/**
 * A zip that was uploaded. Two kinds, told apart by what is in it and not by its name:
 *
 *  - a **Spine export**: `manifest.json` at the top, in the export format. Its files are restored from what the
 *    manifest says was read from them, with no model and nothing sent anywhere; documents already in the archive
 *    are recognised and left out.
 *  - **anything else**: a folder of files someone zipped. Each PDF (and each photo, if photos are allowed) in it is
 *    uploaded as if it had been sent on its own, so it is read the way an upload is.
 *
 * What comes back is one entry per file found, shaped like the answer to a single upload, plus one `zip` entry
 * saying what the zip turned out to be.
 */
const MAX_FILE_BYTES = 200 * 1024 * 1024;
/** What a whole zip may expand to, however many files it holds. */
const MAX_TOTAL_BYTES = 4 * 1024 * 1024 * 1024;
/** Entries of a plain zip that are looked at; the rest are not read. */
const MAX_PLAIN_ENTRIES = 500;

type Entry = Record<string, unknown>;

export async function importZip(userId: string, zipPath: string, filename: string | null): Promise<Entry[]> {
  let zip: ZipReader;
  try {
    zip = await ZipReader.open(zipPath);
  } catch (err) {
    logger.warn('a zip could not be opened', { error: err instanceof Error ? err.message : String(err) });
    // Something not called a zip that only looks like one is just a file of a kind we do not keep.
    return [{ skipped: true, reason: /\.zip$/i.test(filename ?? '') ? 'zip_unreadable' : 'not_pdf', filename }];
  }
  try {
    // A Word, Excel or PowerPoint file is a zip of XML: a document of a kind we do not read, not a folder of files.
    if (zip.entries.some(e => e.name === '[Content_Types].xml')) {
      zip.close();
      return [{ skipped: true, reason: 'not_pdf', filename }];
    }
    if (zip.entries.some(e => e.name === MANIFEST_NAME)) {
      const spine = await importExport(userId, zip, filename);
      if (spine) return spine;
    }
    return await importPlain(userId, zip, filename);
  } catch (err) {
    logger.warn('a zip could not be imported', { error: err instanceof Error ? err.message : String(err) });
    return [{ skipped: true, reason: err instanceof ZipTooLarge ? 'too_large' : 'zip_unreadable', filename }];
  } finally {
    zip.close();
  }
}

/** Null when `manifest.json` is not a Spine export at all: the zip is then an ordinary one that happens to hold a file of that name. */
async function importExport(userId: string, zip: ZipReader, filename: string | null): Promise<Entry[] | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse((await zip.readBuffer(MANIFEST_NAME, MAX_MANIFEST_BYTES)).toString('utf8'));
  } catch (err) {
    if (err instanceof ZipTooLarge) throw err;
    return null;
  }
  const claim = claimsToBeExport(parsed);
  if (!claim) return null;
  // A newer export may mean something this version would misread: refuse rather than guess.
  if (!READABLE_VERSIONS.includes(claim.version)) return [{ skipped: true, reason: 'export_version', filename }];
  const checked = manifestSchema.safeParse(parsed);
  if (!checked.success) return [{ skipped: true, reason: 'export_invalid', filename }];
  const manifest: Manifest = checked.data;

  const store = getStore();
  const known = await knownFingerprints(userId);
  const results: Entry[] = [];
  const summary = { kind: 'spine', filename, exported_at: manifest.exported_at, files: manifest.files.length, documents: 0, restored: 0, duplicates: 0, failed: 0 };
  let total = 0;
  const links = new LinkRestore(userId, manifest.links);
  // The directory goes back first, so a document names the same person whichever file it is in.
  const people = await restoreDirectory(userId, manifest);

  for (const [fileIndex, file] of manifest.files.entries()) {
    summary.documents += file.documents.length;
    const ext = path.extname(file.path).toLowerCase().slice(0, 8);
    const { fileId, filePath } = newUploadPath(userId, /^\.[a-z0-9]+$/.test(ext) ? ext : '.bin');
    let saved: { checksum: string; bytes: number };
    try {
      saved = await zip.extractTo(file.path, filePath, Math.min(MAX_FILE_BYTES, MAX_TOTAL_BYTES - total));
    } catch (err) {
      rmSync(filePath, { force: true });
      summary.failed += file.documents.length;
      results.push({ skipped: true, reason: err instanceof ZipTooLarge ? 'too_large' : 'export_file_missing', filename: file.original_filename });
      continue;
    }
    total += saved.bytes;

    const kind = detectFileKind(filePath);
    if (kind === null) {
      rmSync(filePath, { force: true });
      summary.failed += file.documents.length;
      results.push({ skipped: true, reason: 'not_pdf', filename: file.original_filename });
      continue;
    }

    // The same file already held: nothing to restore.
    const existing = await store.sourceFiles.findByChecksumFor(userId, saved.checksum);
    if (existing) {
      rmSync(filePath, { force: true });
      summary.duplicates += file.documents.length;
      results.push({ skipped: true, reason: 'duplicate', existing_id: existing.id, filename: file.original_filename });
      continue;
    }

    // Documents whose words are already in the archive, from a file cut differently (one document exported on its own).
    const prints = file.documents.map(d => documentFingerprint(file.pages.filter(p => !p.hidden && p.number >= d.page_start && p.number <= d.page_end).sort((a, b) => a.number - b.number).map(p => p.raw_text)));
    const already = prints.map(p => (p ? known.get(p) ?? null : null));
    if (file.documents.length > 0 && already.every(a => a !== null)) {
      rmSync(filePath, { force: true });
      summary.duplicates += file.documents.length;
      results.push({ skipped: true, reason: 'duplicate', existing_id: already[0]!.sourceFileId, filename: file.original_filename });
      continue;
    }
    const setAside = new Set(already.flatMap((a, i) => (a ? [i] : [])));
    summary.duplicates += setAside.size;
    summary.restored += file.documents.length - setAside.size;
    for (const p of prints) if (p) known.set(p, { sourceFileId: fileId }); // two copies inside one zip are one document

    await store.sourceFiles.create(userId, {
      id: fileId, uploadedAt: new Date().toISOString(), originalFilename: file.original_filename, filePath, mimeType: MIME_OF[kind], checksum: saved.checksum, photoSet: file.photo_set,
    });
    links.expect();
    startRestore(userId, fileId, filePath, kind !== 'pdf', file, setAside, people, ids => links.finished(fileIndex, ids));
    results.push({ id: fileId, status: 'processing', restored: true });
  }
  // The links are written when the last file has been restored: one may join documents of two files.
  links.sealed();
  return [{ zip: summary }, ...results];
}

/** Every document's fingerprint in the archive, to recognise a copy. */
async function knownFingerprints(userId: string): Promise<Map<string, { sourceFileId: string }>> {
  const store = getStore();
  const known = new Map<string, { sourceFileId: string }>();
  for (const upload of await store.sourceFiles.listFor(userId)) {
    if (upload.status !== 'done') continue;
    const pages = await store.pages.listForSourceFile(userId, upload.id);
    const docs = await store.documents.listFor(userId, { sourceFileId: upload.id, includeHidden: true, limit: 1_000_000, offset: 0 });
    for (const d of docs) {
      const print = documentFingerprint(pages.filter(p => !p.hidden && p.page_number >= d.page_start && p.page_number <= d.page_end).sort((a, b) => a.page_number - b.page_number).map(p => p.raw_text));
      if (print) known.set(print, { sourceFileId: upload.id });
    }
  }
  return known;
}

/** Hidden files, folders, and what a Mac leaves in a zip. */
const ignorable = (name: string) => name.endsWith('/') || name.split('/').some(part => part.startsWith('.') || part === '__MACOSX');

async function importPlain(userId: string, zip: ZipReader, filename: string | null): Promise<Entry[]> {
  const candidates = zip.entries.filter(e => !ignorable(e.name));
  const results: Entry[] = [];
  const summary = { kind: 'plain', filename, files: 0, accepted: 0, duplicates: 0, refused: 0 };
  let total = 0;

  for (const entry of candidates.slice(0, MAX_PLAIN_ENTRIES)) {
    const ext = path.extname(entry.name).toLowerCase().slice(0, 8);
    const { fileId, filePath } = newUploadPath(userId, /^\.[a-z0-9]+$/.test(ext) ? ext : '.bin');
    const shown = path.basename(entry.name);
    summary.files += 1;
    try {
      const saved = await zip.extractTo(entry.name, filePath, Math.min(MAX_FILE_BYTES, MAX_TOTAL_BYTES - total));
      total += saved.bytes;
      const outcome = await acceptFile(userId, { id: fileId, path: filePath, filename: shown, checksum: saved.checksum });
      if ('id' in outcome) summary.accepted += 1;
      else if (outcome.reason === 'duplicate') summary.duplicates += 1;
      else summary.refused += 1;
      results.push(outcome);
    } catch (err) {
      rmSync(filePath, { force: true });
      summary.refused += 1;
      results.push({ skipped: true, reason: err instanceof ZipTooLarge ? 'too_large' : 'not_pdf', filename: shown });
      if (total >= MAX_TOTAL_BYTES) break;
    }
  }
  if (candidates.length > MAX_PLAIN_ENTRIES) summary.refused += candidates.length - MAX_PLAIN_ENTRIES;
  if (summary.files === 0) return [{ skipped: true, reason: 'zip_empty', filename }];
  return [{ zip: summary }, ...results];
}

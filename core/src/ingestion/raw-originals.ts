import { fileSystem } from '../files.js';
import path from 'path';
import { resolveDataDir } from '../config.js';
import { detectFileKind, isImage } from '../file-kind.js';
import { getStore } from '../store/index.js';
import { rawDirOf } from './remove-upload.js';

/**
 * The photos of a scan session as they were taken (FR-ING-09: "the unprocessed photo is kept as the original"). The PDF is what is
 * read; these are what the camera gave, kept beside it in `<id>.raw/`, numbered in page order. Only images are kept, and only up to
 * as many as the session has pages; anything else sent under that name is dropped.
 */
export async function keepUnprocessed(userId: string, sourceFileId: string, files: string[]): Promise<number> {
  const store = getStore();
  const upload = await store.sourceFiles.findFor(userId, sourceFileId);
  if (!upload) return 0;
  const root = path.join(resolveDataDir(), 'originals', userId);
  const relative = path.relative(root, path.resolve(upload.file_path));
  if (relative.startsWith('..') || path.isAbsolute(relative)) return 0;
  const dir = path.join(root, rawDirOf(relative));
  let kept = 0;
  for (const file of files) {
    const kind = detectFileKind(file);
    if (!isImage(kind)) continue;
    if (kept === 0) fileSystem().mkdirSync(dir);
    kept += 1;
    fileSystem().copyFileSync(file, path.join(dir, `${String(kept).padStart(2, '0')}.${kind === 'png' ? 'png' : 'jpg'}`));
  }
  if (kept > 0) await store.sourceFiles.setRawCount(userId, sourceFileId, kept);
  return kept;
}

/** The path of the nth unprocessed photo (from 1), or null if there is none. Never a path the caller chose. */
export function rawPhotoPath(userId: string, upload: { file_path: string; raw_count: number }, n: number): { file: string; type: string } | null {
  if (!Number.isInteger(n) || n < 1 || n > upload.raw_count) return null;
  const root = path.join(resolveDataDir(), 'originals', userId);
  const relative = path.relative(root, path.resolve(upload.file_path));
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  const dir = path.join(root, rawDirOf(relative));
  for (const ext of ['jpg', 'png']) {
    const file = path.join(dir, `${String(n).padStart(2, '0')}.${ext}`);
    if (fileSystem().existsSync(file)) return { file, type: ext === 'png' ? 'image/png' : 'image/jpeg' };
  }
  return null;
}

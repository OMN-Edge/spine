import { fileSystem } from '../files.js';
import path from 'path';
import { resolveBackupDir, resolveDataDir } from '../config.js';
import type { SourceFile } from '../types.js';

/** Where an upload's unprocessed photos are, relative to the user's originals: `…/<id>.pdf` keeps them in `…/<id>.raw/`. */
export const rawDirOf = (relativePdfPath: string): string => relativePdfPath.replace(/\.[^./\\]+$/, '') + '.raw';

/**
 * What an upload left on disk: its page images, its original, and the backup mirror's copy of
 * the original. Removed before the rows go, as `deleteAccount` does, so a failure leaves the
 * upload listed and deleting it again finishes the job. A stored path outside the user's
 * originals directory is never touched.
 */
export function removeUploadFiles(userId: string, file: Pick<SourceFile, 'id' | 'file_path'>): void {
  const dataDir = resolveDataDir();
  fileSystem().rmSync(path.join(dataDir, 'pages', file.id));

  const inside = path.relative(path.join(dataDir, 'originals', userId), path.resolve(file.file_path));
  if (inside === '' || inside.startsWith('..') || path.isAbsolute(inside)) return;
  fileSystem().rmSync(path.join(dataDir, 'originals', userId, inside));
  fileSystem().rmSync(path.join(resolveBackupDir(), 'originals', userId, inside));
  // The unprocessed photos of a scan session sit in a directory named like the PDF.
  const raw = rawDirOf(inside);
  fileSystem().rmSync(path.join(dataDir, 'originals', userId, raw));
  fileSystem().rmSync(path.join(resolveBackupDir(), 'originals', userId, raw));
}

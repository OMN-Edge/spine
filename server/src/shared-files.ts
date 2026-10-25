import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { resolveDataDir } from 'spine-core/config.js';

/**
 * The sealed copies a share is made of, under `<data>/shares/<id>/`: `db` and numbered `blob-N` files. The server cannot read them;
 * this module moves bytes. The id is the owner's device's own and reaches the file system, so it is held to a safe alphabet first.
 */
export const SHARE_ID = /^[A-Za-z0-9_-]{22,64}$/;

const dirOf = (id: string): string => {
  if (!SHARE_ID.test(id)) throw new Error('invalid share id');
  return path.join(resolveDataDir(), 'shares', id);
};

function write(file: string, bytes: Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const staged = `${file}.${randomUUID()}.part`;
  fs.writeFileSync(staged, bytes);
  fs.renameSync(staged, file);
}

export const writeBundle = (id: string, bytes: Buffer): void => write(path.join(dirOf(id), 'db'), bytes);
export const writeBlob = (id: string, n: number, bytes: Buffer): void => write(path.join(dirOf(id), `blob-${n}`), bytes);

const read = (file: string): Buffer | null => {
  try { return fs.readFileSync(file); } catch { return null; }
};
export const readBundle = (id: string): Buffer | null => read(path.join(dirOf(id), 'db'));
export const readBlob = (id: string, n: number): Buffer | null => read(path.join(dirOf(id), `blob-${n}`));

/** The page images of an earlier publish, when the same share is published again. */
export const removeBlobs = (id: string): void => {
  const dir = dirOf(id);
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) if (f.startsWith('blob-')) fs.rmSync(path.join(dir, f), { force: true });
};

export const removeShare = (id: string): void => fs.rmSync(dirOf(id), { recursive: true, force: true });

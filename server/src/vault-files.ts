import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { resolveDataDir } from './config.js';

/**
 * The ciphertext of the vault's objects, one file each under `<data>/vault/<user>/<id>`. The server cannot read them; this module only
 * moves bytes. An id is the client's own and reaches the file system, so it is held to a safe alphabet before it is used as a name.
 */
export const OBJECT_ID = /^[A-Za-z0-9_-]{8,64}$/;

export const vaultDirOf = (userId: string): string => path.join(resolveDataDir(), 'vault', userId);

export function objectPath(userId: string, id: string): string {
  if (!OBJECT_ID.test(id)) throw new Error('invalid object id');
  return path.join(vaultDirOf(userId), id);
}

/** Written beside and renamed over, so a reader never sees half an object and a failed write leaves the old one. */
export function writeObject(userId: string, id: string, bytes: Buffer): void {
  const target = objectPath(userId, id);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const staged = `${target}.${randomUUID()}.part`;
  fs.writeFileSync(staged, bytes);
  fs.renameSync(staged, target);
}

export const readObject = (userId: string, id: string): Buffer | null => {
  try {
    return fs.readFileSync(objectPath(userId, id));
  } catch {
    return null;
  }
};

export const removeObject = (userId: string, id: string): void => fs.rmSync(objectPath(userId, id), { force: true });

export const removeAllObjects = (userId: string): void => fs.rmSync(vaultDirOf(userId), { recursive: true, force: true });

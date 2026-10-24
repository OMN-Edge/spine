import type { Database } from './driver.js';
import { owner } from './owner.js';
import type { FileRegistryRepository, RegisteredFile } from '../types.js';

/** Every statement filters by `user_id` (SECURITY.md P12). */
export function fileRegistryRepository(db: Database): FileRegistryRepository {
  const list = db.prepare('SELECT path, object_id AS objectId, hash, size, seq FROM vault_files WHERE user_id = ? ORDER BY path');
  const put = db.prepare('INSERT INTO vault_files (path, user_id, object_id, hash, size, seq) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (path) DO UPDATE SET object_id = excluded.object_id, hash = excluded.hash, size = excluded.size, seq = excluded.seq WHERE user_id = excluded.user_id');
  const remove = db.prepare('DELETE FROM vault_files WHERE path = ? AND user_id = ?');
  return {
    async list(userId) { return list.all(owner(userId)) as RegisteredFile[]; },
    async put(userId, file) { put.run(file.path, owner(userId), file.objectId, file.hash, file.size, file.seq); },
    async remove(userId, path) { remove.run(path, owner(userId)); },
  };
}

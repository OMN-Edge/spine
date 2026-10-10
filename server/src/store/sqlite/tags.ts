import type { Database } from 'better-sqlite3';
import type { TagRepository } from '../types.js';
import { owner } from './owner.js';

/**
 * Tags are per-user: a shared vocabulary would leak the existence of other
 * users' categories and let one user's rename affect another's records.
 * Every statement filters by `user_id` (SECURITY.md P12).
 */
export function tagRepository(db: Database): TagRepository {
  const list = db.prepare('SELECT id, name FROM tags WHERE user_id = ? ORDER BY name');
  const namesForDocument = db.prepare(`
    SELECT t.name FROM tags t
    JOIN document_tags dt ON dt.tag_id = t.id
    WHERE dt.document_id = ? AND dt.user_id = ? AND t.user_id = ?
  `);
  const ownsDocument = db.prepare('SELECT 1 FROM documents WHERE id = ? AND user_id = ?');
  const ensure = db.prepare('INSERT OR IGNORE INTO tags (user_id, name) VALUES (?, ?)');
  const link = db.prepare(`
    INSERT OR IGNORE INTO document_tags (user_id, document_id, tag_id)
    SELECT ?, ?, id FROM tags WHERE user_id = ? AND name = ?
  `);
  const unlinkAll = db.prepare('DELETE FROM document_tags WHERE document_id = ? AND user_id = ?');

  return {
    async listFor(userId) {
      return list.all(owner(userId)) as Array<{ id: number; name: string }>;
    },

    async namesForDocument(userId, documentId) {
      const uid = owner(userId);
      return (namesForDocument.all(documentId, uid, uid) as Array<{ name: string }>).map(
        row => row.name,
      );
    },

    async setForDocument(userId, documentId, names) {
      const uid = owner(userId);
      // A document the user does not own is left alone — and no tag rows are
      // created in their vocabulary for it either.
      if (!ownsDocument.get(documentId, uid)) return;

      unlinkAll.run(documentId, uid);
      for (const name of names) {
        ensure.run(uid, name);
        link.run(uid, documentId, uid, name);
      }
    },

    async removeAllForDocument(userId, documentId) {
      unlinkAll.run(documentId, owner(userId));
    },
  };
}

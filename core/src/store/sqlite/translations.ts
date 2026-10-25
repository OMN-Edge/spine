import type { Database } from './driver.js';
import type { TranslationRepository } from '../types.js';
import { owner } from './owner.js';

/** Every statement filters by `user_id` (SECURITY.md P12). The cache holds the owner's medical text, so it is theirs like the rest. */
export function translationRepository(db: Database): TranslationRepository {
  const find = db.prepare(`
    SELECT source_hash, content, created_at FROM document_translations
    WHERE document_id = ? AND language = ? AND user_id = ?
  `);
  // Only for a document that is the user's.
  const upsert = db.prepare(`
    INSERT INTO document_translations (user_id, document_id, language, source_hash, content, created_at)
    SELECT ?, id, ?, ?, ?, ? FROM documents WHERE id = ? AND user_id = ?
    ON CONFLICT (document_id, language) DO UPDATE SET
      source_hash = excluded.source_hash, content = excluded.content, created_at = excluded.created_at
  `);

  return {
    async get(userId, documentId, language) {
      const row = find.get(documentId, language, owner(userId)) as { source_hash: string; content: string; created_at: string } | undefined;
      return row ? { sourceHash: row.source_hash, content: row.content, createdAt: row.created_at } : null;
    },

    async put(userId, documentId, language, sourceHash, content, createdAt) {
      const uid = owner(userId);
      upsert.run(uid, language, sourceHash, content, createdAt, documentId, uid);
    },
  };
}

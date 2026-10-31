import type { Database } from './driver.js';
import type { EmbeddingRepository, StoredEmbedding } from '../types.js';
import { owner } from '../owner.js';
import { VISIBLE } from './visibility.js';

/** Every statement filters by `user_id` (SECURITY.md P12). A vector can be read back into the text it came from, so it is as private as the document. */
export function embeddingRepository(db: Database): EmbeddingRepository {
  const list = db.prepare(`
    SELECT e.document_id, e.model, e.dims, e.text_hash, e.vector
    FROM document_embeddings e JOIN documents d ON d.id = e.document_id AND d.user_id = e.user_id
    WHERE e.user_id = ? AND e.model = ? AND ${VISIBLE}
  `);
  const hashes = db.prepare('SELECT document_id, text_hash FROM document_embeddings WHERE user_id = ? AND model = ?');
  const upsert = db.prepare(`
    INSERT INTO document_embeddings (user_id, document_id, model, dims, text_hash, vector, created_at)
    SELECT ?, id, ?, ?, ?, ?, ? FROM documents WHERE id = ? AND user_id = ?
    ON CONFLICT (document_id, model) DO UPDATE SET
      dims = excluded.dims, text_hash = excluded.text_hash, vector = excluded.vector, created_at = excluded.created_at
  `);
  const prune = db.prepare('DELETE FROM document_embeddings WHERE user_id = ? AND model <> ?');

  return {
    async listFor(userId, model) {
      return (list.all(owner(userId), model) as Array<{ document_id: string; model: string; dims: number; text_hash: string; vector: Buffer }>)
        .map((r): StoredEmbedding => ({ documentId: r.document_id, model: r.model, dims: r.dims, textHash: r.text_hash, vector: r.vector }));
    },

    async hashesFor(userId, model) {
      const rows = hashes.all(owner(userId), model) as Array<{ document_id: string; text_hash: string }>;
      return new Map(rows.map(r => [r.document_id, r.text_hash]));
    },

    async put(userId, e, createdAt) {
      const uid = owner(userId);
      upsert.run(uid, e.model, e.dims, e.textHash, e.vector, createdAt, e.documentId, uid);
    },

    async pruneOtherModels(userId, keepModel) {
      return prune.run(owner(userId), keepModel).changes;
    },
  };
}

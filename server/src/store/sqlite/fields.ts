import type { Database } from 'better-sqlite3';
import type { ExtractedField } from '../../types.js';
import type { ExtractedFieldRepository, NewExtractedField } from '../types.js';
import { expectInserted, owner } from './owner.js';

/** Every statement filters by `user_id` (SECURITY.md P12). */
export function extractedFieldRepository(db: Database): ExtractedFieldRepository {
  // Explicit columns: user_id is not for clients (S-8).
  const listForDocument = db.prepare(`
    SELECT id, document_id, page_id, label, value, source_snippet,
           bbox_x0, bbox_y0, bbox_x1, bbox_y1, confidence
    FROM extracted_fields WHERE document_id = ? AND user_id = ?
  `);

  // Inserts only if both the document and the page are the user's, so a field
  // cannot be attached to someone else's record.
  const insert = db.prepare(`
    INSERT INTO extracted_fields (
      id, user_id, document_id, page_id, label, value, source_snippet,
      bbox_x0, bbox_y0, bbox_x1, bbox_y1, confidence
    )
    SELECT ?, ?, d.id, p.id, ?, ?, ?, ?, ?, ?, ?, ?
    FROM documents d, pages p
    WHERE d.id = ? AND d.user_id = ? AND p.id = ? AND p.user_id = ?
  `);

  // The target must also be the user's.
  const reassign = db.prepare(`
    UPDATE extracted_fields SET document_id = ?
    WHERE document_id = ? AND user_id = ?
      AND EXISTS (SELECT 1 FROM documents WHERE id = ? AND user_id = ?)
  `);

  // Only fields on the document's own pages from that number on, and only into a
  // document that is the user's.
  const reassignFromPage = db.prepare(`
    UPDATE extracted_fields SET document_id = ?
    WHERE document_id = ? AND user_id = ?
      AND page_id IN (
        SELECT p.id FROM pages p JOIN documents d ON d.source_file_id = p.source_file_id
        WHERE d.id = ? AND d.user_id = ? AND p.user_id = ? AND p.page_number >= ?
      )
      AND EXISTS (SELECT 1 FROM documents WHERE id = ? AND user_id = ?)
  `);
  const deleteForDocument = db.prepare('DELETE FROM extracted_fields WHERE document_id = ? AND user_id = ?');
  const updateOne = db.prepare(
    'UPDATE extracted_fields SET label = ?, value = ? WHERE id = ? AND document_id = ? AND user_id = ?',
  );
  const removeOne = db.prepare('DELETE FROM extracted_fields WHERE id = ? AND document_id = ? AND user_id = ?');

  return {
    async listForDocument(userId, documentId) {
      return listForDocument.all(documentId, owner(userId)) as ExtractedField[];
    },

    async create(userId, field: NewExtractedField) {
      const uid = owner(userId);
      const result = insert.run(
        field.id,
        uid,
        field.label,
        field.value,
        field.sourceSnippet,
        field.bbox?.x0 ?? null,
        field.bbox?.y0 ?? null,
        field.bbox?.x1 ?? null,
        field.bbox?.y1 ?? null,
        field.confidence,
        field.documentId,
        uid,
        field.pageId,
        uid,
      );
      expectInserted(result.changes, 'document or page');
    },

    async reassignDocument(userId, fromDocumentId, toDocumentId) {
      const uid = owner(userId);
      reassign.run(toDocumentId, fromDocumentId, uid, toDocumentId, uid);
    },

    async reassignFromPage(userId, fromDocumentId, toDocumentId, fromPageNumber) {
      const uid = owner(userId);
      reassignFromPage.run(toDocumentId, fromDocumentId, uid, fromDocumentId, uid, uid, fromPageNumber, toDocumentId, uid);
    },

    async deleteForDocument(userId, documentId) {
      deleteForDocument.run(documentId, owner(userId));
    },

    async update(userId, documentId, fieldId, change) {
      return updateOne.run(change.label, change.value, fieldId, documentId, owner(userId)).changes === 1;
    },

    async remove(userId, documentId, fieldId) {
      return removeOne.run(fieldId, documentId, owner(userId)).changes === 1;
    },
  };
}

import type { Database } from './driver.js';
import type { SourceFile } from '../../types.js';
import type { NewSourceFile, SourceFileRepository, SourceFileSummary } from '../types.js';
import { owner } from './owner.js';

type RawUpload = Omit<SourceFile, 'grouping_confirmed' | 'photo_set' | 'sample' | 'from_export'> & { grouping_confirmed: number; photo_set: number; sample: number; from_export: number };
const asUpload = (row: RawUpload): SourceFile => ({ ...row, grouping_confirmed: row.grouping_confirmed === 1, photo_set: row.photo_set === 1, sample: row.sample === 1, from_export: row.from_export === 1 });

/** Every statement filters by `user_id` (SECURITY.md P12). */
export function sourceFileRepository(db: Database): SourceFileRepository {
  // The list goes to the client, so: no `file_path` (an absolute server path), no
  // checksum, no user_id (S-8). `findFor` below returns the full row because the
  // pipeline needs the path — its callers must not send it on.
  const list = db.prepare(`
    SELECT id, uploaded_at, original_filename, mime_type, page_count, status, error_message, grouping_confirmed, sample, raw_count
    FROM source_files WHERE user_id = ? ORDER BY uploaded_at DESC
  `);
  const find = db.prepare('SELECT * FROM source_files WHERE id = ? AND user_id = ?');
  const findByChecksum = db.prepare('SELECT * FROM source_files WHERE checksum = ? AND user_id = ?');
  const insert = db.prepare(`
    INSERT INTO source_files (id, user_id, uploaded_at, original_filename, file_path, mime_type, checksum, status, chat_conversation_id, photo_set, sample, from_export)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
  `);
  const setStatus = db.prepare(
    'UPDATE source_files SET status = ?, error_message = ? WHERE id = ? AND user_id = ?',
  );
  const setChat = db.prepare('UPDATE source_files SET chat_conversation_id = ? WHERE id = ? AND user_id = ? AND EXISTS (SELECT 1 FROM chat_conversations WHERE id = ? AND user_id = ?)');
  const setConfirmed = db.prepare('UPDATE source_files SET grouping_confirmed = ? WHERE id = ? AND user_id = ?');
  const setRawCount = db.prepare('UPDATE source_files SET raw_count = ? WHERE id = ? AND user_id = ?');
  const setPageCount = db.prepare(
    'UPDATE source_files SET page_count = ? WHERE id = ? AND user_id = ?',
  );

  // What ingestion made from one upload, children before parents. Every statement
  // filters by user_id, so another user's upload id removes nothing.
  const deleteFields = db.prepare(`
    DELETE FROM extracted_fields WHERE user_id = ?
      AND document_id IN (SELECT id FROM documents WHERE source_file_id = ? AND user_id = ?)
  `);
  const deleteMeasurements = db.prepare(`
    DELETE FROM measurements WHERE user_id = ?
      AND document_id IN (SELECT id FROM documents WHERE source_file_id = ? AND user_id = ?)
  `);
  // The doctors stay: they are the user's directory, and outlive any one reading.
  const deleteDoctorLinks = db.prepare(`
    DELETE FROM document_doctors WHERE user_id = ?
      AND document_id IN (SELECT id FROM documents WHERE source_file_id = ? AND user_id = ?)
  `);
  const deleteDocumentTags = db.prepare(`
    DELETE FROM document_tags WHERE user_id = ?
      AND document_id IN (SELECT id FROM documents WHERE source_file_id = ? AND user_id = ?)
  `);
  const deleteTranslations = db.prepare(`
    DELETE FROM document_translations WHERE user_id = ?
      AND document_id IN (SELECT id FROM documents WHERE source_file_id = ? AND user_id = ?)
  `);
  const deleteEmbeddings = db.prepare(`
    DELETE FROM document_embeddings WHERE user_id = ?
      AND document_id IN (SELECT id FROM documents WHERE source_file_id = ? AND user_id = ?)
  `);
  const deleteLinks = db.prepare(`
    DELETE FROM document_links WHERE user_id = ?
      AND (from_document_id IN (SELECT id FROM documents WHERE source_file_id = ? AND user_id = ?)
        OR to_document_id IN (SELECT id FROM documents WHERE source_file_id = ? AND user_id = ?))
  `);
  const deleteRemoved = db.prepare(`
    DELETE FROM removed_readings WHERE user_id = ?
      AND document_id IN (SELECT id FROM documents WHERE source_file_id = ? AND user_id = ?)
  `);
  const deletePlan = db.prepare('DELETE FROM regroup_plans WHERE source_file_id = ? AND user_id = ?');
  const deleteDocuments = db.prepare('DELETE FROM documents WHERE source_file_id = ? AND user_id = ?');
  const deletePages = db.prepare('DELETE FROM pages WHERE source_file_id = ? AND user_id = ?');
  const clearDerived = db.transaction((userId: string, id: string) => {
    deleteFields.run(userId, id, userId);
    deleteMeasurements.run(userId, id, userId);
    deleteDoctorLinks.run(userId, id, userId);
    deleteDocumentTags.run(userId, id, userId);
    deleteTranslations.run(userId, id, userId);
    deleteEmbeddings.run(userId, id, userId);
    deleteLinks.run(userId, id, userId, id, userId);
    deleteRemoved.run(userId, id, userId);
    deletePlan.run(id, userId);
    const removed = deleteDocuments.run(id, userId).changes;
    deletePages.run(id, userId);
    return removed;
  });
  const deleteUpload = db.prepare('DELETE FROM source_files WHERE id = ? AND user_id = ?');
  const remove = db.transaction((userId: string, id: string) => {
    clearDerived(userId, id);
    return deleteUpload.run(id, userId).changes > 0;
  });

  return {
    async listFor(userId) {
      return list.all(owner(userId)).map(row => asUpload(row as RawUpload)) as SourceFileSummary[];
    },

    async findFor(userId, id) {
      const row = find.get(id, owner(userId)) as RawUpload | undefined;
      return row ? asUpload(row) : null;
    },

    async findByChecksumFor(userId, checksum) {
      const row = findByChecksum.get(checksum, owner(userId)) as RawUpload | undefined;
      return row ? asUpload(row) : null;
    },

    async create(userId, input: NewSourceFile) {
      insert.run(
        input.id,
        owner(userId),
        input.uploadedAt,
        input.originalFilename,
        input.filePath,
        input.mimeType,
        input.checksum,
        input.chatConversationId ?? null,
        input.photoSet ? 1 : 0,
        input.sample ? 1 : 0,
        input.fromExport ? 1 : 0,
      );
    },

    async setRawCount(userId, id, count) {
      setRawCount.run(count, id, owner(userId));
    },

    async setStatus(userId, id, status, errorMessage = null) {
      setStatus.run(status, errorMessage, id, owner(userId));
    },

    async setGroupingConfirmed(userId, id, confirmed) {
      setConfirmed.run(confirmed ? 1 : 0, id, owner(userId));
    },

    async setChatConversation(userId, id, conversationId) {
      setChat.run(conversationId, id, owner(userId), conversationId, owner(userId));
    },

    async setPageCount(userId, id, pageCount) {
      setPageCount.run(pageCount, id, owner(userId));
    },

    async clearDerived(userId, id) {
      return clearDerived(owner(userId), id);
    },

    async delete(userId, id) {
      return remove(owner(userId), id);
    },
  };
}

import type { Database } from 'better-sqlite3';
import type { SourceFile } from '../../types.js';
import type { NewSourceFile, SourceFileRepository, SourceFileSummary } from '../types.js';
import { owner } from './owner.js';

/** Every statement filters by `user_id` (SECURITY.md P12). */
export function sourceFileRepository(db: Database): SourceFileRepository {
  // The list goes to the client, so: no `file_path` (an absolute server path), no
  // checksum, no user_id (S-8). `findFor` below returns the full row because the
  // pipeline needs the path — its callers must not send it on.
  const list = db.prepare(`
    SELECT id, uploaded_at, original_filename, mime_type, page_count, status, error_message
    FROM source_files WHERE user_id = ? ORDER BY uploaded_at DESC
  `);
  const find = db.prepare('SELECT * FROM source_files WHERE id = ? AND user_id = ?');
  const findByChecksum = db.prepare('SELECT * FROM source_files WHERE checksum = ? AND user_id = ?');
  const insert = db.prepare(`
    INSERT INTO source_files (id, user_id, uploaded_at, original_filename, file_path, mime_type, checksum, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
  `);
  const setStatus = db.prepare(
    'UPDATE source_files SET status = ?, error_message = ? WHERE id = ? AND user_id = ?',
  );
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
  const deleteDocuments = db.prepare('DELETE FROM documents WHERE source_file_id = ? AND user_id = ?');
  const deletePages = db.prepare('DELETE FROM pages WHERE source_file_id = ? AND user_id = ?');
  const clearDerived = db.transaction((userId: string, id: string) => {
    deleteFields.run(userId, id, userId);
    deleteMeasurements.run(userId, id, userId);
    deleteDoctorLinks.run(userId, id, userId);
    deleteDocumentTags.run(userId, id, userId);
    const removed = deleteDocuments.run(id, userId).changes;
    deletePages.run(id, userId);
    return removed;
  });

  return {
    async listFor(userId) {
      return list.all(owner(userId)) as SourceFileSummary[];
    },

    async findFor(userId, id) {
      return (find.get(id, owner(userId)) as SourceFile | undefined) ?? null;
    },

    async findByChecksumFor(userId, checksum) {
      return (findByChecksum.get(checksum, owner(userId)) as SourceFile | undefined) ?? null;
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
      );
    },

    async setStatus(userId, id, status, errorMessage = null) {
      setStatus.run(status, errorMessage, id, owner(userId));
    },

    async setPageCount(userId, id, pageCount) {
      setPageCount.run(pageCount, id, owner(userId));
    },

    async clearDerived(userId, id) {
      return clearDerived(owner(userId), id);
    },
  };
}

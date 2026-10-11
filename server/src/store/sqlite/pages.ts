import type { Database } from 'better-sqlite3';
import type { UnstructuredElement, Page } from '../../types.js';
import type {
  GroundingContext,
  NewPage,
  PageRepository,
  PageSummary,
  PageWithoutPath,
} from '../types.js';
import { expectInserted, owner } from './owner.js';

/** Every statement filters by `user_id` (SECURITY.md P12). */
export function pageRepository(db: Database): PageRepository {
  // Inserts only if the source file is the user's, so a page cannot be attached
  // to someone else's upload.
  const insert = db.prepare(`
    INSERT INTO pages (
      id, user_id, source_file_id, page_number, image_path, image_width, image_height,
      raw_text, elements, extraction_source,
      is_continuation, continuation_confidence, continuation_reasoning
    )
    SELECT ?, ?, id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    FROM source_files WHERE id = ? AND user_id = ?
  `);

  const updateReading = db.prepare(
    'UPDATE pages SET raw_text = ?, elements = ?, extraction_source = ? WHERE id = ? AND user_id = ?',
  );
  const listForSourceFile = db.prepare(`
    SELECT id, page_number, raw_text, is_continuation, image_width, image_height, extraction_source
    FROM pages WHERE source_file_id = ? AND user_id = ? ORDER BY page_number
  `);

  // Explicit columns: image_path is an absolute server path and no client has a
  // use for it (S-8).
  const listForDocument = db.prepare(`
    SELECT p.id, p.source_file_id, p.page_number, p.image_width, p.image_height, p.raw_text,
           p.elements, p.extraction_source, p.is_continuation, p.continuation_confidence,
           p.continuation_reasoning, p.reviewed
    FROM documents d
    JOIN pages p
      ON p.source_file_id = d.source_file_id
     AND p.page_number BETWEEN d.page_start AND d.page_end
    WHERE d.id = ? AND d.user_id = ? AND p.user_id = ?
    ORDER BY p.page_number
  `);

  const findGrounding = db.prepare(
    'SELECT elements, image_width, image_height FROM pages WHERE id = ? AND user_id = ?',
  );
  const findImagePath = db.prepare('SELECT image_path FROM pages WHERE id = ? AND user_id = ?');

  return {
    async create(userId, page: NewPage) {
      const uid = owner(userId);
      const result = insert.run(
        page.id,
        uid,
        page.pageNumber,
        page.imagePath,
        page.imageWidth,
        page.imageHeight,
        page.rawText,
        JSON.stringify(page.elements),
        page.extractionSource,
        page.isContinuation === null ? null : page.isContinuation ? 1 : 0,
        page.continuationConfidence,
        page.continuationReasoning,
        page.sourceFileId,
        uid,
      );
      expectInserted(result.changes, 'source file');
    },

    async updateReading(userId, pageId, reading) {
      return updateReading.run(
        reading.rawText, JSON.stringify(reading.elements), reading.extractionSource, pageId, owner(userId),
      ).changes === 1;
    },

    async listForSourceFile(userId, sourceFileId) {
      return listForSourceFile.all(sourceFileId, owner(userId)) as PageSummary[];
    },

    async listForDocument(userId, documentId) {
      const uid = owner(userId);
      return listForDocument.all(documentId, uid, uid) as PageWithoutPath[];
    },

    async findGroundingContext(userId, pageId): Promise<GroundingContext | null> {
      const row = findGrounding.get(pageId, owner(userId)) as
        | { elements: string | null; image_width: number; image_height: number }
        | undefined;
      if (!row) return null;

      return {
        elements: row.elements ? (JSON.parse(row.elements) as UnstructuredElement[]) : [],
        imageWidth: row.image_width,
        imageHeight: row.image_height,
      };
    },

    async findImagePathFor(userId, pageId) {
      const row = findImagePath.get(pageId, owner(userId)) as { image_path: string } | undefined;
      return row?.image_path ?? null;
    },
  };
}

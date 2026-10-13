import type { Database } from 'better-sqlite3';
import type { Document } from '../../types.js';
import type {
  DocumentFilter,
  DocumentPatch,
  DocumentRepository,
  NewDocument,
  ResolvedShareLink,
} from '../types.js';
import { expectInserted, owner } from './owner.js';
import { ftsQuery } from '../../search-query.js';

/**
 * The only columns a client may write. The caller passes a patch object, never
 * a column name, so there is no path by which a request key reaches the SQL
 * (S-12).
 */
const UPDATABLE_COLUMNS = ['title', 'doc_date', 'provider', 'doc_type', 'ai_summary', 'user_notes'] as const;
type UpdatableColumn = (typeof UPDATABLE_COLUMNS)[number];

const ORDER = 'ORDER BY d.doc_date DESC NULLS LAST';

/**
 * Explicit, never `d.*`: the table carries `user_id`, which no client — least of
 * all a share recipient — has any use for (S-8).
 */
const COLUMNS =
  'd.id, d.source_file_id, d.page_start, d.page_end, d.title, d.doc_date, d.provider, ' +
  'd.doc_type, d.ai_summary, d.user_notes, d.reviewed';

/** Every statement filters by `user_id` (SECURITY.md P12). */
export function documentRepository(db: Database): DocumentRepository {
  const find = db.prepare(`SELECT ${COLUMNS} FROM documents d WHERE d.id = ? AND d.user_id = ?`);

  // Inserts only if the source file is the user's.
  const insert = db.prepare(`
    INSERT INTO documents (id, user_id, source_file_id, page_start, page_end, title, doc_date, provider, doc_type, ai_summary)
    SELECT ?, ?, id, ?, ?, ?, ?, ?, ?, ?
    FROM source_files WHERE id = ? AND user_id = ?
  `);
  const setPageEnd = db.prepare('UPDATE documents SET page_end = ? WHERE id = ? AND user_id = ?');
  const remove = db.prepare('DELETE FROM documents WHERE id = ? AND user_id = ?');

  const forShareAll = db.prepare(`SELECT ${COLUMNS} FROM documents d WHERE d.user_id = ? ${ORDER}`);
  const forShareTag = db.prepare(`
    SELECT ${COLUMNS} FROM documents d
    WHERE d.user_id = ?
      AND d.id IN (
        SELECT dt.document_id FROM document_tags dt
        JOIN tags t ON t.id = dt.tag_id
        WHERE t.name = ? AND t.user_id = ?
      )
    ${ORDER}
  `);
  const forShareDateRange = db.prepare(`
    SELECT ${COLUMNS} FROM documents d
    WHERE d.user_id = ? AND d.doc_date >= ? AND d.doc_date <= ?
    ${ORDER}
  `);

  return {
    async listFor(userId, filter: DocumentFilter) {
      const uid = owner(userId);
      const params: unknown[] = [];
      let sql: string;

      const match = filter.q ? ftsQuery(filter.q) : null;
      if (filter.q && match === null) return []; // typed only punctuation: nothing to look for

      if (match !== null) {
        // The full-text index is shared across users; results are filtered by
        // joining back to documents.user_id, so the index itself leaks nothing
        // (M-2). The snippet is cut from the matching column of the caller's own row, and the matched
        // words are wrapped in control characters (never in markup) that the page turns into emphasis.
        sql = `
          SELECT ${COLUMNS},
            snippet(documents_fts, -1, char(1), char(2), '…', 16) AS snippet
          FROM documents d
          JOIN documents_fts ON documents_fts.rowid = d.rowid
          WHERE d.user_id = ? AND documents_fts MATCH ?
        `;
        params.push(uid, match);
      } else {
        sql = `SELECT ${COLUMNS} FROM documents d WHERE d.user_id = ?`;
        params.push(uid);
      }

      if (filter.tag) {
        sql += ` AND d.id IN (
          SELECT dt.document_id FROM document_tags dt
          JOIN tags t ON t.id = dt.tag_id WHERE t.name = ? AND t.user_id = ?
        )`;
        params.push(filter.tag, uid);
      }
      if (filter.docType) { sql += ' AND d.doc_type = ?'; params.push(filter.docType); }
      if (filter.provider) { sql += ' AND d.provider LIKE ?'; params.push(`%${filter.provider}%`); }
      if (filter.dateFrom) { sql += ' AND d.doc_date >= ?'; params.push(filter.dateFrom); }
      if (filter.dateTo) { sql += ' AND d.doc_date <= ?'; params.push(filter.dateTo); }
      if (filter.sourceFileId) { sql += ' AND d.source_file_id = ?'; params.push(filter.sourceFileId); }
      if (filter.reviewed !== undefined) {
        sql += ' AND d.reviewed = ?';
        params.push(filter.reviewed ? 1 : 0);
      }

      // Best match first: a hit in the title counts for more than one deep in a page.
      sql += match !== null
        ? ' ORDER BY bm25(documents_fts, 10.0, 1.0, 3.0, 4.0, 3.0, 1.0), d.rowid DESC'
        : ` ${ORDER}, d.rowid DESC`;
      sql += ' LIMIT ? OFFSET ?';
      params.push(filter.limit, filter.offset);

      return db.prepare(sql).all(...params) as Document[];
    },

    async findFor(userId, id) {
      return (find.get(id, owner(userId)) as Document | undefined) ?? null;
    },

    async create(userId, doc: NewDocument) {
      const uid = owner(userId);
      const result = insert.run(
        doc.id,
        uid,
        doc.pageStart,
        doc.pageEnd,
        doc.title ?? null,
        doc.docDate ?? null,
        doc.provider ?? null,
        doc.docType ?? null,
        doc.aiSummary ?? null,
        doc.sourceFileId,
        uid,
      );
      expectInserted(result.changes, 'source file');
    },

    async update(userId, id, patch: DocumentPatch) {
      const uid = owner(userId);
      const columns = (Object.keys(patch) as Array<keyof DocumentPatch>).filter(
        (key): key is UpdatableColumn | 'reviewed' =>
          key === 'reviewed' || (UPDATABLE_COLUMNS as readonly string[]).includes(key),
      );
      if (columns.length === 0) return;

      const values = columns.map(key =>
        key === 'reviewed' ? (patch.reviewed ? 1 : 0) : (patch[key] as string | null),
      );
      const sets = columns.map(key => `${key} = ?`).join(', ');
      db.prepare(`UPDATE documents SET ${sets} WHERE id = ? AND user_id = ?`).run(...values, id, uid);
    },

    async setPageEnd(userId, id, pageEnd) {
      setPageEnd.run(pageEnd, id, owner(userId));
    },

    async delete(userId, id) {
      remove.run(id, owner(userId));
    },

    async ownedIds(userId, ids) {
      const uid = owner(userId);
      if (ids.length === 0) return [];
      const rows = db
        .prepare(`SELECT id FROM documents WHERE user_id = ? AND id IN (${ids.map(() => '?').join(',')})`)
        .all(uid, ...ids) as Array<{ id: string }>;
      return rows.map(row => row.id);
    },

    /**
     * P12's exception: scoped by the *link's* owner and scope, both resolved
     * from the token. Every branch narrows and every branch filters by the
     * link's owner, so a link can never return another user's document. A scope
     * that cannot be resolved never reaches here (P2 — the caller rejects it).
     */
    async listForShare(link: ResolvedShareLink) {
      const uid = owner(link.userId);
      const value: unknown = link.scopeValue === null ? null : JSON.parse(link.scopeValue);

      switch (link.scope) {
        case 'all':
          return forShareAll.all(uid) as Document[];

        case 'tag':
          return forShareTag.all(uid, value as string, uid) as Document[];

        case 'document_ids': {
          const ids = value as string[];
          return db
            .prepare(
              `SELECT ${COLUMNS} FROM documents d
               WHERE d.user_id = ? AND d.id IN (${ids.map(() => '?').join(',')}) ${ORDER}`,
            )
            .all(uid, ...ids) as Document[];
        }

        case 'date_range': {
          const { from, to } = value as { from: string; to: string };
          return forShareDateRange.all(uid, from, to) as Document[];
        }

        default:
          // Unreachable: the scope was resolved before this call. Fail closed.
          throw new Error(`unresolvable share scope "${link.scope}" reached the store`);
      }
    },
  };
}

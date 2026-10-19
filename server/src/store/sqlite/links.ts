import type { Database } from 'better-sqlite3';
import type { DocumentLink, LinkRepository } from '../types.js';
import { owner } from './owner.js';
import { VISIBLE } from './visibility.js';

const COLUMNS = 'l.from_document_id, l.to_document_id, l.kind, l.source, l.state, l.reason, l.confidence';
/** A link is shown only while both ends are documents the owner has not set aside. */
const BOTH_SHOWN = `EXISTS (SELECT 1 FROM documents d WHERE d.id = l.from_document_id AND d.user_id = l.user_id AND ${VISIBLE})
  AND EXISTS (SELECT 1 FROM documents d WHERE d.id = l.to_document_id AND d.user_id = l.user_id AND ${VISIBLE})`;

/** Every statement filters by `user_id` (SECURITY.md P12), and a link is written only between two documents that are the user's. */
export function linkRepository(db: Database): LinkRepository {
  const forDocument = db.prepare(`
    SELECT ${COLUMNS} FROM document_links l
    WHERE l.user_id = ? AND (l.from_document_id = ? OR l.to_document_id = ?) AND ${BOTH_SHOWN}
  `);
  const insert = db.prepare(`
    INSERT INTO document_links (user_id, from_document_id, to_document_id, kind, source, state, reason, confidence, created_at)
    SELECT ?, a.id, b.id, ?, ?, ?, ?, ?, ? FROM documents a, documents b
    WHERE a.id = ? AND a.user_id = ? AND b.id = ? AND b.user_id = ? AND a.id <> b.id
    ON CONFLICT (from_document_id, to_document_id, kind) DO NOTHING
  `);
  const confirmByOwner = db.prepare(`
    UPDATE document_links SET state = 'confirmed', source = 'owner'
    WHERE user_id = ? AND from_document_id = ? AND to_document_id = ? AND kind = ?
  `);
  const exists = db.prepare('SELECT 1 FROM documents a, documents b WHERE a.id = ? AND a.user_id = ? AND b.id = ? AND b.user_id = ? AND a.id <> b.id');
  const setState = db.prepare(`
    UPDATE document_links SET state = ?
    WHERE user_id = ? AND from_document_id = ? AND to_document_id = ? AND kind = ?
  `);
  const clearProposed = db.prepare(`
    DELETE FROM document_links
    WHERE user_id = ? AND source = 'auto' AND state = 'proposed'
      AND ((from_document_id = ? AND to_document_id = ?) OR (from_document_id = ? AND to_document_id = ?))
  `);
  const removeAuto = db.prepare(`
    DELETE FROM document_links
    WHERE user_id = ? AND source = 'auto' AND state <> 'dismissed' AND from_document_id = ? AND to_document_id = ? AND kind = ?
  `);
  const everything = db.prepare(`SELECT ${COLUMNS} FROM document_links l WHERE l.user_id = ?`);
  const dismissed = db.prepare(`
    SELECT from_document_id, to_document_id FROM document_links
    WHERE user_id = ? AND state = 'dismissed' AND (from_document_id = ? OR to_document_id = ?)
  `);

  return {
    async forDocument(userId, documentId) {
      return forDocument.all(owner(userId), documentId, documentId) as DocumentLink[];
    },

    async among(userId, documentIds) {
      if (documentIds.length === 0) return [];
      const marks = documentIds.map(() => '?').join(',');
      return db.prepare(`
        SELECT ${COLUMNS} FROM document_links l
        WHERE l.user_id = ? AND l.from_document_id IN (${marks}) AND l.to_document_id IN (${marks}) AND ${BOTH_SHOWN}
      `).all(owner(userId), ...documentIds, ...documentIds) as DocumentLink[];
    },

    async add(userId, link, createdAt) {
      const uid = owner(userId);
      if (!exists.get(link.from_document_id, uid, link.to_document_id, uid)) return false;
      insert.run(uid, link.kind, link.source, link.state, link.reason, link.confidence ?? null, createdAt,
        link.from_document_id, uid, link.to_document_id, uid);
      if (link.source === 'owner') confirmByOwner.run(uid, link.from_document_id, link.to_document_id, link.kind);
      return true;
    },

    async setState(userId, fromDocumentId, toDocumentId, kind, state) {
      return setState.run(state, owner(userId), fromDocumentId, toDocumentId, kind).changes > 0;
    },

    async clearProposedBetween(userId, documentId, otherIds) {
      const uid = owner(userId);
      let removed = 0;
      for (const other of otherIds) removed += clearProposed.run(uid, documentId, other, other, documentId).changes;
      return removed;
    },

    async removeAuto(userId, fromDocumentId, toDocumentId, kind) {
      return removeAuto.run(owner(userId), fromDocumentId, toDocumentId, kind).changes > 0;
    },

    async all(userId) {
      return everything.all(owner(userId)) as DocumentLink[];
    },

    async restore(userId, link, createdAt) {
      const uid = owner(userId);
      if (!exists.get(link.from_document_id, uid, link.to_document_id, uid)) return false;
      insert.run(uid, link.kind, link.source, link.state, link.reason, link.confidence ?? null, createdAt,
        link.from_document_id, uid, link.to_document_id, uid);
      return true;
    },

    async dismissedPairs(userId, documentId) {
      const rows = dismissed.all(owner(userId), documentId, documentId) as Array<{ from_document_id: string; to_document_id: string }>;
      return new Set(rows.map(r => (r.from_document_id === documentId ? r.to_document_id : r.from_document_id)));
    },
  };
}

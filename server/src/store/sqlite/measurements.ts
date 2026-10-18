import type { Database } from 'better-sqlite3';
import type { Measurement } from '../../types.js';
import type {
  MeasurementChange,
  MeasurementName,
  MeasurementPoint,
  MeasurementRepository,
  NewMeasurement,
} from '../types.js';
import { expectInserted, owner } from './owner.js';
import { measurementKey } from '../reading-keys.js';
import { VISIBLE } from './visibility.js';

/** Every statement filters by `user_id` (SECURITY.md P12). */
export function measurementRepository(db: Database): MeasurementRepository {
  // Explicit columns: user_id is not for clients (S-8).
  const COLUMNS = `id, document_id, page_id, name, canonical, value_text, value_num, unit, ref_low, ref_high,
    flag, taken_on, source_snippet, bbox_x0, bbox_y0, bbox_x1, bbox_y1, confidence`;
  const listForDocument = db.prepare(`SELECT ${COLUMNS} FROM measurements WHERE document_id = ? AND user_id = ? ORDER BY rowid`);

  // Only if both the document and the page are the user's.
  const insert = db.prepare(`
    INSERT INTO measurements (
      id, user_id, document_id, page_id, name, canonical, value_text, value_num, unit, ref_low, ref_high,
      flag, taken_on, source_snippet, bbox_x0, bbox_y0, bbox_x1, bbox_y1, confidence, owner_edited
    )
    SELECT ?, ?, d.id, p.id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    FROM documents d, pages p
    WHERE d.id = ? AND d.user_id = ? AND p.id = ? AND p.user_id = ?
  `);
  const updateOne = db.prepare(`
    UPDATE measurements SET name = ?, canonical = ?, value_text = ?, value_num = ?, unit = ?,
      ref_low = ?, ref_high = ?, flag = ?, taken_on = ?, owner_edited = 1
    WHERE id = ? AND document_id = ? AND user_id = ?
  `);
  const removeOne = db.prepare('DELETE FROM measurements WHERE id = ? AND document_id = ? AND user_id = ?');
  const findOne = db.prepare('SELECT canonical, value_text, taken_on FROM measurements WHERE id = ? AND document_id = ? AND user_id = ?');
  const remember = db.prepare("INSERT OR IGNORE INTO removed_readings (user_id, document_id, kind, key) VALUES (?, ?, 'measurement', ?)");
  const removed = db.prepare("SELECT key FROM removed_readings WHERE document_id = ? AND user_id = ? AND kind = 'measurement'");
  const deleteUnedited = db.prepare('DELETE FROM measurements WHERE document_id = ? AND user_id = ? AND owner_edited = 0');
  const deleteForDocument = db.prepare('DELETE FROM measurements WHERE document_id = ? AND user_id = ?');
  const reassign = db.prepare(`
    UPDATE measurements SET document_id = ?
    WHERE document_id = ? AND user_id = ?
      AND EXISTS (SELECT 1 FROM documents WHERE id = ? AND user_id = ?)
  `);
  const reassignFromPage = db.prepare(`
    UPDATE measurements SET document_id = ?
    WHERE document_id = ? AND user_id = ?
      AND page_id IN (
        SELECT p.id FROM pages p JOIN documents d ON d.source_file_id = p.source_file_id
        WHERE d.id = ? AND d.user_id = ? AND p.user_id = ? AND p.page_number >= ?
      )
      AND EXISTS (SELECT 1 FROM documents WHERE id = ? AND user_id = ?)
  `);
  const reassignPage = db.prepare(`
    UPDATE measurements SET document_id = ?
    WHERE page_id = ? AND user_id = ?
      AND EXISTS (SELECT 1 FROM documents WHERE id = ? AND user_id = ?)
  `);
  const all = db.prepare(`
    SELECT m.canonical, m.name, m.unit, m.value_text, m.taken_on, m.flag
    FROM measurements m JOIN documents d ON d.id = m.document_id AND d.user_id = m.user_id
    WHERE m.user_id = ? AND ${VISIBLE}
    ORDER BY m.taken_on IS NULL, m.taken_on, m.rowid
  `);
  const aliasOf = db.prepare('SELECT canonical FROM measurement_aliases WHERE user_id = ? AND alias = ?');
  const hasTest = db.prepare('SELECT 1 FROM measurements WHERE user_id = ? AND canonical = ? LIMIT 1');
  const moveValues = db.prepare('UPDATE measurements SET canonical = ? WHERE user_id = ? AND canonical = ?');
  const repointAliases = db.prepare('UPDATE measurement_aliases SET canonical = ? WHERE user_id = ? AND canonical = ?');
  const rememberAlias = db.prepare('INSERT OR REPLACE INTO measurement_aliases (user_id, alias, canonical) VALUES (?, ?, ?)');
  const merge = db.transaction((uid: string, from: string, into: string) => {
    moveValues.run(into, uid, from);
    repointAliases.run(into, uid, from); // an alias that led to `from` now leads to `into`
    rememberAlias.run(uid, from, into);
  });
  const renameValues = db.prepare('UPDATE measurements SET canonical = ?, name = ? WHERE user_id = ? AND canonical = ?');
  const dropValues = db.prepare('DELETE FROM measurements WHERE user_id = ? AND canonical = ?');
  const dropAliases = db.prepare('DELETE FROM measurement_aliases WHERE user_id = ? AND (canonical = ? OR alias = ?)');
  const rename = db.transaction((uid: string, from: string, to: string, shown: string) => {
    renameValues.run(to, shown, uid, from);
    repointAliases.run(to, uid, from);
    rememberAlias.run(uid, from, to);
  });
  const remove = db.transaction((uid: string, canonical: string) => {
    const gone = dropValues.run(uid, canonical).changes;
    dropAliases.run(uid, canonical, canonical);
    return gone;
  });
  const series = db.prepare(`
    SELECT m.id, m.document_id, d.title AS document_title, m.taken_on, m.name, m.value_text, m.value_num,
           m.unit, m.ref_low, m.ref_high, m.flag
    FROM measurements m JOIN documents d ON d.id = m.document_id AND d.user_id = m.user_id
    WHERE m.user_id = ? AND m.canonical = ? AND ${VISIBLE}
    ORDER BY m.taken_on IS NULL, m.taken_on, m.rowid
  `);

  return {
    async listForDocument(userId, documentId) {
      return listForDocument.all(documentId, owner(userId)) as Measurement[];
    },

    async create(userId, m: NewMeasurement) {
      const uid = owner(userId);
      const result = insert.run(
        m.id, uid, m.name, m.canonical, m.valueText, m.valueNum, m.unit, m.refLow, m.refHigh, m.flag, m.takenOn,
        m.sourceSnippet, m.bbox?.x0 ?? null, m.bbox?.y0 ?? null, m.bbox?.x1 ?? null, m.bbox?.y1 ?? null, m.confidence, m.ownerEdited ? 1 : 0,
        m.documentId, uid, m.pageId, uid,
      );
      expectInserted(result.changes, 'document or page');
    },

    async update(userId, documentId, id, c: MeasurementChange) {
      return updateOne.run(
        c.name, c.canonical, c.valueText, c.valueNum, c.unit, c.refLow, c.refHigh, c.flag, c.takenOn,
        id, documentId, owner(userId),
      ).changes === 1;
    },

    async remove(userId, documentId, id) {
      const uid = owner(userId);
      const row = findOne.get(id, documentId, uid) as { canonical: string; value_text: string; taken_on: string | null } | undefined;
      if (!row || removeOne.run(id, documentId, uid).changes !== 1) return false;
      remember.run(uid, documentId, measurementKey(row.canonical, row.value_text, row.taken_on));
      return true;
    },

    async deleteUnedited(userId, documentId) {
      deleteUnedited.run(documentId, owner(userId));
    },

    async removedKeys(userId, documentId) {
      return new Set((removed.all(documentId, owner(userId)) as Array<{ key: string }>).map(r => r.key));
    },

    async deleteForDocument(userId, documentId) {
      deleteForDocument.run(documentId, owner(userId));
    },

    async reassignDocument(userId, fromDocumentId, toDocumentId) {
      const uid = owner(userId);
      reassign.run(toDocumentId, fromDocumentId, uid, toDocumentId, uid);
    },

    async reassignPage(userId, pageId, toDocumentId) {
      const uid = owner(userId);
      reassignPage.run(toDocumentId, pageId, uid, toDocumentId, uid);
    },

    async reassignFromPage(userId, fromDocumentId, toDocumentId, fromPageNumber) {
      const uid = owner(userId);
      reassignFromPage.run(toDocumentId, fromDocumentId, uid, fromDocumentId, uid, uid, fromPageNumber, toDocumentId, uid);
    },

    async resolveCanonical(userId, canonical) {
      const row = aliasOf.get(owner(userId), canonical) as { canonical: string } | undefined;
      return row?.canonical ?? canonical;
    },

    async mergeTests(userId, from, into) {
      const uid = owner(userId);
      if (from === into) return 'same';
      if (!hasTest.get(uid, from) || !hasTest.get(uid, into)) return 'not_found';
      merge(uid, from, into);
      return 'ok';
    },

    async renameTest(userId, from, to) {
      const uid = owner(userId);
      const shown = to.trim().replace(/\s+/g, ' ').slice(0, 120);
      const target = shown.toLowerCase();
      if (!target) return 'invalid';
      if (!hasTest.get(uid, from)) return 'not_found';
      if (target === from) return 'same';
      // Another test's name: the two become one and the values keep the names they were printed with.
      if (hasTest.get(uid, target)) { merge(uid, from, target); return 'merged'; }
      rename(uid, from, target, shown);
      return 'ok';
    },

    async removeTest(userId, canonical) {
      return remove(owner(userId), canonical);
    },

    async names(userId) {
      // Oldest first, so the last row of a test is its latest value.
      const rows = all.all(owner(userId)) as Array<{
        canonical: string; name: string; unit: string | null; value_text: string; taken_on: string | null; flag: MeasurementName['latest_flag'];
      }>;
      const byTest = new Map<string, MeasurementName>();
      for (const row of rows) {
        const seen = byTest.get(row.canonical);
        byTest.set(row.canonical, {
          canonical: row.canonical,
          name: row.name,
          unit: row.unit ?? seen?.unit ?? null,
          count: (seen?.count ?? 0) + 1,
          latest_value_text: row.value_text,
          latest_taken_on: row.taken_on,
          latest_flag: row.flag,
        });
      }
      return [...byTest.values()].sort((a, b) => a.canonical.localeCompare(b.canonical));
    },

    async series(userId, canonical) {
      return series.all(owner(userId), canonical) as MeasurementPoint[];
    },
  };
}

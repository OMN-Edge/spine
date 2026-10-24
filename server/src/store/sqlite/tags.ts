import { randomRowId, starterTagId } from './ids.js';
import { STARTER_TAGS } from '../../tags.js';
import type { Database } from './driver.js';
import type { TagRepository } from '../types.js';
import { owner } from './owner.js';
import { cleanTag } from '../../tags.js';

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
  const insertTag = db.prepare('INSERT OR IGNORE INTO tags (id, user_id, name) VALUES (?, ?, ?)');
  // A starter tag has the same key on every device, so two devices that make it make one row.
  const ensure = { run: (userId: string, name: string) => insertTag.run((STARTER_TAGS as readonly string[]).includes(name) ? starterTagId(userId, name) : randomRowId(), userId, name) };
  const link = db.prepare(`
    INSERT OR IGNORE INTO document_tags (user_id, document_id, tag_id)
    SELECT ?, ?, id FROM tags WHERE user_id = ? AND name = ?
  `);
  const unlinkAll = db.prepare('DELETE FROM document_tags WHERE document_id = ? AND user_id = ?');
  const counts = db.prepare(`
    SELECT t.id, t.name, COUNT(d.id) AS document_count
    FROM tags t
    LEFT JOIN document_tags dt ON dt.tag_id = t.id AND dt.user_id = t.user_id
    LEFT JOIN documents d ON d.id = dt.document_id AND d.user_id = t.user_id
    WHERE t.user_id = ?
    GROUP BY t.id ORDER BY t.name
  `);
  const find = db.prepare('SELECT id, name FROM tags WHERE id = ? AND user_id = ?');
  const byName = db.prepare('SELECT id FROM tags WHERE user_id = ? AND name = ?');
  const setName = db.prepare('UPDATE tags SET name = ? WHERE id = ? AND user_id = ?');
  // A document that has both tags keeps one link: the insert ignores the pair it already has.
  const moveLinks = db.prepare(`
    INSERT OR IGNORE INTO document_tags (user_id, document_id, tag_id)
    SELECT user_id, document_id, ? FROM document_tags WHERE tag_id = ? AND user_id = ?
  `);
  const dropLinks = db.prepare('DELETE FROM document_tags WHERE tag_id = ? AND user_id = ?');
  const dropTag = db.prepare('DELETE FROM tags WHERE id = ? AND user_id = ?');
  // A link that shares by a tag names it, as JSON. It follows a rename or a merge; after a removal it names nothing.
  const followInLinks = db.prepare("UPDATE share_links SET scope_value = ? WHERE user_id = ? AND scope = 'tag' AND scope_value = ?");

  const fold = db.transaction((uid: string, from: { id: number; name: string }, into: { id: number; name: string }) => {
    moveLinks.run(into.id, from.id, uid);
    dropLinks.run(from.id, uid);
    dropTag.run(from.id, uid);
    followInLinks.run(JSON.stringify(into.name), uid, JSON.stringify(from.name));
  });
  const renameOne = db.transaction((uid: string, tag: { id: number; name: string }, name: string) => {
    setName.run(name, tag.id, uid);
    followInLinks.run(JSON.stringify(name), uid, JSON.stringify(tag.name));
  });
  const removeOne = db.transaction((uid: string, id: number) => {
    dropLinks.run(id, uid);
    return dropTag.run(id, uid).changes === 1;
  });

  return {
    async listFor(userId) {
      return list.all(owner(userId)) as Array<{ id: number; name: string }>;
    },

    async listWithCounts(userId) {
      return counts.all(owner(userId)) as Array<{ id: number; name: string; document_count: number }>;
    },

    async rename(userId, id, name) {
      const uid = owner(userId);
      const tag = find.get(id, uid) as { id: number; name: string } | undefined;
      if (!tag) return 'not_found';
      const cleaned = cleanTag(name);
      if (!cleaned) return 'invalid';
      if (cleaned === tag.name) return 'ok';
      const existing = byName.get(uid, cleaned) as { id: number } | undefined;
      if (existing) {
        fold(uid, tag, { id: existing.id, name: cleaned });
        return 'merged';
      }
      renameOne(uid, tag, cleaned);
      return 'ok';
    },

    async merge(userId, fromId, intoId) {
      const uid = owner(userId);
      if (fromId === intoId) return 'same';
      const from = find.get(fromId, uid) as { id: number; name: string } | undefined;
      const into = find.get(intoId, uid) as { id: number; name: string } | undefined;
      if (!from || !into) return 'not_found';
      fold(uid, from, into);
      return 'ok';
    },

    async remove(userId, id) {
      return removeOne(owner(userId), id);
    },

    async ensure(userId, names) {
      const uid = owner(userId);
      for (const name of names) { const clean = cleanTag(name); if (clean) ensure.run(uid, clean); }
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
      for (const raw of names) {
        const name = cleanTag(raw);
        if (!name) continue;
        ensure.run(uid, name);
        link.run(uid, documentId, uid, name);
      }
    },

    async removeAllForDocument(userId, documentId) {
      unlinkAll.run(documentId, owner(userId));
    },
  };
}

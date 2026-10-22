import type { Database } from 'better-sqlite3';
import type { Episode, EpisodeRepository, EpisodeState } from '../types.js';
import { owner } from './owner.js';
import { VISIBLE } from './visibility.js';

interface Row { id: string; title: string; state: EpisodeState; source: 'auto' | 'owner'; created_at: string }

/** Every statement filters by `user_id` (SECURITY.md P12); an episode names only documents that are the user's. */
export function episodeRepository(db: Database): EpisodeRepository {
  const rows = db.prepare('SELECT id, title, state, source, created_at FROM episodes WHERE user_id = ? ORDER BY created_at DESC, id');
  const row = db.prepare('SELECT id, title, state, source, created_at FROM episodes WHERE id = ? AND user_id = ?');
  const insert = db.prepare('INSERT INTO episodes (id, user_id, title, state, source, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  const membersOf = db.prepare(`
    SELECT d.id, d.doc_date, d.provider FROM episode_documents ed
    JOIN documents d ON d.id = ed.document_id AND d.user_id = ed.user_id
    WHERE ed.episode_id = ? AND ed.user_id = ? AND ${VISIBLE}
    ORDER BY d.doc_date IS NULL, d.doc_date, d.id
  `);
  const owned = db.prepare('SELECT 1 FROM documents WHERE id = ? AND user_id = ?');
  const addMember = db.prepare('INSERT OR IGNORE INTO episode_documents (episode_id, document_id, user_id) VALUES (?, ?, ?)');
  const dropMembers = db.prepare('DELETE FROM episode_documents WHERE episode_id = ? AND user_id = ?');
  // A document is in one live episode: joining another takes it out of the rest.
  const leaveOthers = db.prepare(`
    DELETE FROM episode_documents
    WHERE user_id = ? AND document_id = ? AND episode_id <> ?
      AND episode_id IN (SELECT id FROM episodes WHERE user_id = ? AND state <> 'dismissed')
  `);
  const emptied = db.prepare(`
    DELETE FROM episodes WHERE user_id = ? AND state <> 'dismissed'
      AND NOT EXISTS (SELECT 1 FROM episode_documents ed WHERE ed.episode_id = episodes.id)
  `);
  const setTitle = db.prepare('UPDATE episodes SET title = ? WHERE id = ? AND user_id = ?');
  const setState = db.prepare('UPDATE episodes SET state = ? WHERE id = ? AND user_id = ?');
  const remove = db.prepare('DELETE FROM episodes WHERE id = ? AND user_id = ?');

  const shape = (r: Row, uid: string): Episode => {
    const docs = membersOf.all(r.id, uid) as Array<{ id: string; doc_date: string | null; provider: string | null }>;
    const dates = docs.map(d => d.doc_date).filter((d): d is string => !!d);
    const counts = new Map<string, number>();
    for (const d of docs) if (d.provider) counts.set(d.provider, (counts.get(d.provider) ?? 0) + 1);
    const provider = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
    return { ...r, document_ids: docs.map(d => d.id), first_date: dates[0] ?? null, last_date: dates[dates.length - 1] ?? null, provider };
  };

  const fill = db.transaction((uid: string, episodeId: string, documentIds: string[]): boolean => {
    const unique = [...new Set(documentIds)];
    if (unique.some(id => !owned.get(id, uid))) return false;
    dropMembers.run(episodeId, uid);
    for (const id of unique) {
      leaveOthers.run(uid, id, episodeId, uid);
      addMember.run(episodeId, id, uid);
    }
    emptied.run(uid);
    return true;
  });

  const make = db.transaction((uid: string, e: { id: string; title: string; state: EpisodeState; source: 'auto' | 'owner'; documentIds: string[] }, createdAt: string): boolean => {
    insert.run(e.id, uid, e.title, e.state, e.source, createdAt);
    if (!fill(uid, e.id, e.documentIds)) throw new Error('not owned');
    return true;
  });

  return {
    async list(userId, states) {
      const uid = owner(userId);
      return (rows.all(uid) as Row[]).filter(r => !states || states.includes(r.state)).map(r => shape(r, uid));
    },

    async find(userId, id) {
      const uid = owner(userId);
      const r = row.get(id, uid) as Row | undefined;
      return r ? shape(r, uid) : null;
    },

    async create(userId, episode, createdAt) {
      try { return make(owner(userId), episode, createdAt); } catch (err) {
        if (err instanceof Error && err.message === 'not owned') return false;
        throw err;
      }
    },

    async rename(userId, id, title) {
      return setTitle.run(title, id, owner(userId)).changes === 1;
    },

    async setState(userId, id, state) {
      return setState.run(state, id, owner(userId)).changes === 1;
    },

    async setDocuments(userId, id, documentIds) {
      const uid = owner(userId);
      if (!row.get(id, uid)) return false;
      return fill(uid, id, documentIds);
    },

    async remove(userId, id) {
      return remove.run(id, owner(userId)).changes === 1;
    },

    async confirmedAmong(userId, ids) {
      if (ids.length === 0) return [];
      const uid = owner(userId);
      const marks = ids.map(() => '?').join(',');
      return (db.prepare(`SELECT id FROM episodes WHERE user_id = ? AND state = 'confirmed' AND id IN (${marks})`).all(uid, ...ids) as Array<{ id: string }>).map(r => r.id);
    },
  };
}

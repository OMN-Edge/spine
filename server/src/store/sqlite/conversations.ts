import type { Database } from 'better-sqlite3';
import { MAX_CONVERSATIONS, type ConversationRepository, type ConversationSummary, type StoredMessage } from '../types.js';
import { owner } from './owner.js';

/** Every statement filters by `user_id` (SECURITY.md P12). A conversation is medical text, as private as the documents it quotes. */
export function conversationRepository(db: Database): ConversationRepository {
  const list = db.prepare(`
    SELECT c.id, c.title, c.created_at, c.updated_at, c.unread, c.origin,
           (SELECT COUNT(*) FROM chat_messages m WHERE m.conversation_id = c.id AND m.user_id = c.user_id) AS message_count
    FROM chat_conversations c WHERE c.user_id = ? ORDER BY c.updated_at DESC, c.rowid DESC LIMIT ?
  `);
  const find = db.prepare(`
    SELECT c.id, c.title, c.created_at, c.updated_at, c.unread, c.origin,
           (SELECT COUNT(*) FROM chat_messages m WHERE m.conversation_id = c.id AND m.user_id = c.user_id) AS message_count
    FROM chat_conversations c WHERE c.id = ? AND c.user_id = ?
  `);
  const insert = db.prepare('INSERT INTO chat_conversations (id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)');
  const count = db.prepare('SELECT COUNT(*) AS n FROM chat_conversations WHERE user_id = ?');
  const oldest = db.prepare('SELECT id FROM chat_conversations WHERE user_id = ? ORDER BY updated_at ASC, rowid ASC LIMIT ?');
  const messages = db.prepare(`
    SELECT id, role, content, sources, note, created_at, kind, data FROM chat_messages
    WHERE conversation_id = ? AND user_id = ? ORDER BY seq ASC
  `);
  const lastMessages = db.prepare(`
    SELECT * FROM (
      SELECT id, role, content, sources, note, created_at, kind, data, seq FROM chat_messages
      WHERE conversation_id = ? AND user_id = ? ORDER BY seq DESC LIMIT ?
    ) ORDER BY seq ASC
  `);
  const nextSeq = db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM chat_messages WHERE conversation_id = ? AND user_id = ?');
  const insertMessage = db.prepare(`
    INSERT INTO chat_messages (id, user_id, conversation_id, seq, role, content, sources, note, created_at, kind, data)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const touch = db.prepare('UPDATE chat_conversations SET updated_at = ? WHERE id = ? AND user_id = ?');
  const rename = db.prepare('UPDATE chat_conversations SET title = ? WHERE id = ? AND user_id = ?');
  const removeMessages = db.prepare('DELETE FROM chat_messages WHERE conversation_id = ? AND user_id = ?');
  const removeOne = db.prepare('DELETE FROM chat_conversations WHERE id = ? AND user_id = ?');
  const removeAllMessages = db.prepare('DELETE FROM chat_messages WHERE user_id = ?');
  const removeAll = db.prepare('DELETE FROM chat_conversations WHERE user_id = ?');

  const drop = db.transaction((uid: string, id: string) => {
    removeMessages.run(id, uid);
    return removeOne.run(id, uid).changes > 0;
  });
  const append = db.transaction((uid: string, id: string, rows: Array<Parameters<ConversationRepository['append']>[2][number]>) => {
    if (!find.get(id, uid)) return false;
    let seq = (nextSeq.get(id, uid) as { n: number }).n;
    for (const m of rows) insertMessage.run(m.id, uid, id, seq++, m.role, m.content, JSON.stringify(m.sources), m.note, m.createdAt, m.kind ?? null, m.data === undefined ? null : JSON.stringify(m.data));
    touch.run(rows.at(-1)?.createdAt ?? new Date().toISOString(), id, uid);
    return true;
  });
  const create = db.transaction((uid: string, c: { id: string; title: string; createdAt: string }) => {
    insert.run(c.id, uid, c.title, c.createdAt, c.createdAt);
    const over = (count.get(uid) as { n: number }).n - MAX_CONVERSATIONS;
    if (over > 0) for (const old of oldest.all(uid, over) as Array<{ id: string }>) drop(uid, old.id);
  });
  const asMessage = (row: { id: string; role: 'user' | 'assistant'; content: string; sources: string | null; note: StoredMessage['note']; created_at: string; kind: 'upload' | 'regroup' | 'attachment' | null; data: string | null }): StoredMessage => ({
    id: row.id, role: row.role, content: row.content, sources: row.sources ? (JSON.parse(row.sources) as unknown[]) : [], note: row.note, created_at: row.created_at,
    kind: row.kind, data: row.data ? (JSON.parse(row.data) as unknown) : null,
  });
  const asSummary = (row: Omit<ConversationSummary, 'unread'> & { unread: number }): ConversationSummary => ({ ...row, unread: !!row.unread });
  const insertNotice = db.prepare('INSERT INTO chat_conversations (id, user_id, title, created_at, updated_at, unread, origin) VALUES (?, ?, ?, ?, ?, 1, ?)');
  const unreadCount = db.prepare('SELECT COUNT(*) AS n FROM chat_conversations WHERE user_id = ? AND unread = 1');
  const markUnread = db.prepare('UPDATE chat_conversations SET unread = 1 WHERE id = ? AND user_id = ?');
  const markRead = db.prepare('UPDATE chat_conversations SET unread = 0 WHERE id = ? AND user_id = ?');
  const createNotice = db.transaction((uid: string, n: { id: string; title: string; origin: 'upload' | 'regroup'; createdAt: string; message: { id: string; content: string; kind: 'upload' | 'regroup'; data: unknown } }) => {
    insertNotice.run(n.id, uid, n.title, n.createdAt, n.createdAt, n.origin);
    insertMessage.run(n.message.id, uid, n.id, 1, 'assistant', n.message.content, '[]', null, n.createdAt, n.message.kind, JSON.stringify(n.message.data));
    const over = (count.get(uid) as { n: number }).n - MAX_CONVERSATIONS;
    if (over > 0) for (const old of oldest.all(uid, over) as Array<{ id: string }>) drop(uid, old.id);
  });

  return {
    async list(userId, limit) { return (list.all(owner(userId), limit) as Parameters<typeof asSummary>[0][]).map(asSummary); },
    async find(userId, id) {
      const row = find.get(id, owner(userId)) as Parameters<typeof asSummary>[0] | undefined;
      return row ? asSummary(row) : null;
    },
    async createNotice(userId, notice) { createNotice(owner(userId), notice); },
    async appendNotice(userId, conversationId, m) {
      const uid = owner(userId);
      return db.transaction(() => {
        const ok = append(uid, conversationId, [{ id: m.id, role: 'assistant', content: m.content, sources: [], note: null, createdAt: m.createdAt, kind: m.kind, data: m.data }]);
        if (ok) markUnread.run(conversationId, uid);
        return ok;
      })();
    },
    async unreadCount(userId) { return (unreadCount.get(owner(userId)) as { n: number }).n; },
    async markRead(userId, id) { return markRead.run(id, owner(userId)).changes > 0; },
    async create(userId, c) { create(owner(userId), c); },
    async messages(userId, id, last) {
      const uid = owner(userId);
      const rows = (last === undefined ? messages.all(id, uid) : lastMessages.all(id, uid, last)) as Parameters<typeof asMessage>[0][];
      return rows.map(asMessage);
    },
    async append(userId, id, rows) { return append(owner(userId), id, rows); },
    async rename(userId, id, title) { return rename.run(title, id, owner(userId)).changes > 0; },
    async remove(userId, id) { return drop(owner(userId), id); },
    async removeAll(userId) {
      const uid = owner(userId);
      return db.transaction(() => { removeAllMessages.run(uid); return removeAll.run(uid).changes; })();
    },
  };
}

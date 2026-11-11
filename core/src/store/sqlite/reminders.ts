import type { Database } from './driver.js';
import { owner } from '../owner.js';
import { VISIBLE } from './visibility.js';
import type { ReminderRepository, ReminderRow } from '../types.js';

const COLUMNS = 'id, document_id, text, due_on, status, on_page, created_at, updated_at';

/** Every statement filters by `user_id` (SECURITY.md P12). */
export function reminderRepository(db: Database): ReminderRepository {
  const list = db.prepare(`SELECT ${COLUMNS} FROM reminders WHERE user_id = ? ORDER BY CASE status WHEN 'proposed' THEN 0 WHEN 'confirmed' THEN 1 WHEN 'done' THEN 2 ELSE 3 END, due_on, created_at`);
  const get = db.prepare(`SELECT ${COLUMNS} FROM reminders WHERE user_id = ? AND id = ?`);
  const insert = db.prepare('INSERT OR IGNORE INTO reminders (id, user_id, document_id, text, due_on, status, on_page, created_at, updated_at) VALUES (?, ?, ?, ?, ?, \'proposed\', ?, ?, ?)');
  const remove = db.prepare('DELETE FROM reminders WHERE user_id = ? AND id = ?');
  // Only those whose document is still shown count: a document set aside, regrouped away or deleted takes its reminders out of what the server is told.
  const confirmed = db.prepare(`SELECT r.id AS id, r.due_on AS due_on FROM reminders r JOIN documents d ON d.id = r.document_id AND d.user_id = r.user_id WHERE r.user_id = ? AND r.status = 'confirmed' AND ${VISIBLE} ORDER BY r.due_on, r.id`);

  return {
    async list(userId) { return list.all(owner(userId)) as ReminderRow[]; },
    async get(userId, id) { return (get.get(owner(userId), id) as ReminderRow | undefined) ?? null; },
    async propose(userId, documentId, items, now) {
      const id = owner(userId);
      let added = 0;
      for (const i of items) added += insert.run(i.id, id, documentId, i.text, i.dueOn, i.sourcePage, now, now).changes;
      return added;
    },
    async update(userId, id, changes, now) {
      const uid = owner(userId);
      const row = get.get(uid, id) as ReminderRow | undefined;
      if (!row) return null;
      db.prepare('UPDATE reminders SET text = ?, due_on = ?, status = ?, updated_at = ? WHERE user_id = ? AND id = ?')
        .run(changes.text ?? row.text, changes.dueOn ?? row.due_on, changes.status ?? row.status, now, uid, id);
      return get.get(uid, id) as ReminderRow;
    },
    async remove(userId, id) { return remove.run(owner(userId), id).changes === 1; },
    async confirmed(userId) { return confirmed.all(owner(userId)) as Array<{ id: string; due_on: string }>; },
  };
}

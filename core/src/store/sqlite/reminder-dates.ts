import type { Database } from './driver.js';
import { owner } from '../owner.js';
import type { ReminderDateRepository } from '../types.js';

/** Every statement filters by `user_id` (SECURITY.md P12). */
export function reminderDateRepository(db: Database): ReminderDateRepository {
  const total = db.prepare('SELECT COUNT(*) AS n FROM reminder_dues WHERE user_id = ?');
  const held = db.prepare('SELECT id FROM reminder_dues WHERE user_id = ? AND profile_id = ?');
  const drop = db.prepare('DELETE FROM reminder_dues WHERE user_id = ? AND id = ?');
  // A changed date is mailed again; the same one is left as it was (and as mailed or not).
  const put = db.prepare(`INSERT INTO reminder_dues (user_id, id, profile_id, due_on) VALUES (?, ?, ?, ?)
    ON CONFLICT (user_id, id) DO UPDATE SET profile_id = excluded.profile_id, mailed_on = CASE WHEN reminder_dues.due_on <> excluded.due_on THEN NULL ELSE reminder_dues.mailed_on END, due_on = excluded.due_on`);
  const replace = db.transaction((userId: string, profileId: string, items: Array<{ id: string; dueOn: string }>, max: number): 'ok' | 'too_many' => {
    const named = new Set(items.map(i => i.id));
    const gone = (held.all(userId, profileId) as Array<{ id: string }>).filter(r => !named.has(r.id));
    const others = (total.get(userId) as { n: number }).n - gone.length - (held.all(userId, profileId) as Array<{ id: string }>).filter(r => named.has(r.id)).length;
    if (others + items.length > max) return 'too_many';
    for (const r of gone) drop.run(userId, r.id);
    for (const i of items) put.run(userId, i.id, profileId, i.dueOn);
    return 'ok';
  });
  return {
    async replace(userId, profileId, items, max) { return replace(owner(userId), profileId, items, max); },
    async count(userId) { return (total.get(owner(userId)) as { n: number }).n; },
  };
}

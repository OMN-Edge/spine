import type { ReminderDateRepository } from '../types.js';
import { many, one, type Begin, type Query } from './query.js';
import { owner } from '../owner.js';

/** Every statement filters by `user_id` (SECURITY.md P12). */
export function reminderDateRepository(q: Query, begin: Begin): ReminderDateRepository {
  return {
    async replace(userId, profileId, items, max) {
      const id = owner(userId);
      return begin(async run => {
        // The account's row is locked, so two devices telling the dates of one profile at once are taken one after the other.
        await run('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [id]);
        const held = await many<{ id: string }>(run, 'SELECT id FROM reminder_dues WHERE user_id = $1 AND profile_id = $2', [id, profileId]);
        const named = new Set(items.map(i => i.id));
        const total = Number((await one<{ n: number }>(run, 'SELECT COUNT(*) AS n FROM reminder_dues WHERE user_id = $1', [id]))!.n);
        const others = total - held.length;
        if (others + items.length > max) return 'too_many' as const;
        for (const r of held) if (!named.has(r.id)) await run('DELETE FROM reminder_dues WHERE user_id = $1 AND id = $2', [id, r.id]);
        for (const i of items) {
          await run(`INSERT INTO reminder_dues (user_id, id, profile_id, due_on) VALUES ($1, $2, $3, $4)
            ON CONFLICT (user_id, id) DO UPDATE SET profile_id = excluded.profile_id, mailed_on = CASE WHEN reminder_dues.due_on <> excluded.due_on THEN NULL ELSE reminder_dues.mailed_on END, due_on = excluded.due_on`, [id, i.id, profileId, i.dueOn]);
        }
        return 'ok' as const;
      });
    },
    async count(userId) { return Number((await one<{ n: number }>(q, 'SELECT COUNT(*) AS n FROM reminder_dues WHERE user_id = $1', [owner(userId)]))!.n); },
  };
}

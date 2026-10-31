import type { Database } from './driver.js';
import { owner } from '../owner.js';
import type { UsageRepository } from '../types.js';

/** Every statement filters by `user_id` (SECURITY.md P12). */
export function usageRepository(db: Database): UsageRepository {
  // One statement decides and counts: a row at the limit is not updated, so `changes` is 0 and two instances cannot both take the last call.
  const spend = db.prepare('INSERT INTO model_usage (user_id, day, calls) VALUES (?, ?, 1) ON CONFLICT (user_id, day) DO UPDATE SET calls = calls + 1 WHERE calls < ?');
  const count = db.prepare('SELECT calls FROM model_usage WHERE user_id = ? AND day = ?');
  const prune = db.prepare('DELETE FROM model_usage WHERE user_id = ? AND day < ?');

  return {
    async spend(userId, day, limit) {
      const id = owner(userId);
      if (limit <= 0) return null;
      if (spend.run(id, day, limit).changes === 0) return null;
      prune.run(id, day);
      return (count.get(id, day) as { calls: number }).calls;
    },
  };
}

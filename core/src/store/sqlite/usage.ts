import type { Database } from './driver.js';
import { owner } from '../owner.js';
import type { UsageRepository } from '../types.js';

/** Every statement filters by `user_id` (SECURITY.md P12). */
export function usageRepository(db: Database): UsageRepository {
  // One statement decides and counts: a row at the limit is not updated, so `changes` is 0 and two instances cannot both take the last call.
  const spend = db.prepare('INSERT INTO model_usage (user_id, day, calls) VALUES (?, ?, 1) ON CONFLICT (user_id, day) DO UPDATE SET calls = calls + 1 WHERE calls < ?');
  const count = db.prepare('SELECT calls FROM model_usage WHERE user_id = ? AND day = ?');
  const prune = db.prepare('DELETE FROM model_usage WHERE user_id = ? AND day < ?');
  const aiUsed = db.prepare('SELECT amount FROM ai_usage WHERE user_id = ? AND period = ?');
  const aiAdd = db.prepare('INSERT INTO ai_usage (user_id, period, amount) VALUES (?, ?, ?) ON CONFLICT (user_id, period) DO UPDATE SET amount = amount + excluded.amount');
  // A period of the account's that is not this one is over: the trial's and each earlier month's.
  const aiForget = db.prepare("DELETE FROM ai_usage WHERE user_id = ? AND period <> ? AND period <> 'trial'");

  return {
    async spend(userId, day, limit) {
      const id = owner(userId);
      if (limit <= 0) return null;
      if (spend.run(id, day, limit).changes === 0) return null;
      prune.run(id, day);
      return (count.get(id, day) as { calls: number }).calls;
    },

    async aiUsed(userId, period) {
      return (aiUsed.get(owner(userId), period) as { amount: number } | undefined)?.amount ?? 0;
    },

    async aiAdd(userId, period, amount) {
      const id = owner(userId);
      aiAdd.run(id, period, Math.max(0, Math.round(amount)));
      if (period !== 'trial') aiForget.run(id, period);
      return (aiUsed.get(id, period) as { amount: number }).amount;
    },
  };
}

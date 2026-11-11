import type { Database } from './driver.js';
import { owner } from '../owner.js';
import { monthsBefore } from '../months.js';
import type { UsageRepository } from '../types.js';

/** Every statement filters by `user_id` (SECURITY.md P12). */
export function usageRepository(db: Database): UsageRepository {
  // One statement decides and counts: a row at the limit is not updated, so `changes` is 0 and two instances cannot both take the last call.
  const spend = db.prepare('INSERT INTO model_usage (user_id, day, calls) VALUES (?, ?, 1) ON CONFLICT (user_id, day) DO UPDATE SET calls = calls + 1 WHERE calls < ?');
  const count = db.prepare('SELECT calls FROM model_usage WHERE user_id = ? AND day = ?');
  const prune = db.prepare('DELETE FROM model_usage WHERE user_id = ? AND day < ?');
  const aiUsed = db.prepare('SELECT amount FROM ai_usage WHERE user_id = ? AND period = ?');
  const aiAdd = db.prepare('INSERT INTO ai_usage (user_id, period, amount) VALUES (?, ?, ?) ON CONFLICT (user_id, period) DO UPDATE SET amount = amount + excluded.amount');
  // A count more than thirteen months old is forgotten, whichever meter or pool it was for (the key holds the month); the trial's total and a once-only
  // allowance have no month and are kept. Thirteen, not twelve, so a yearly ceiling can sum the twelve months behind it.
  const aiForget = db.prepare("DELETE FROM ai_usage WHERE user_id = ? AND period GLOB '*[0-9][0-9][0-9][0-9]-[0-9][0-9]*' AND substr(period, instr(period, '20'), 7) < ?");

  const seenRow = db.prepare('SELECT 1 AS yes FROM ai_seen WHERE user_id = ? AND key = ?');
  const see = db.prepare('INSERT OR IGNORE INTO ai_seen (user_id, key, at) VALUES (?, ?, ?)');
  const forgetSeen = db.prepare('DELETE FROM ai_seen WHERE user_id = ? AND at < ?');

  return {
    async seen(userId, key) { return seenRow.get(owner(userId), key) !== undefined; },

    async see(userId, key, at) {
      const id = owner(userId);
      const fresh = see.run(id, key, at).changes === 1;
      forgetSeen.run(id, new Date(Date.parse(at) - 2 * 24 * 3600e3).toISOString());
      return fresh;
    },

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

    async aiUsedMany(userId, periods) {
      if (periods.length === 0) return 0;
      const marks = periods.map(() => '?').join(', ');
      return Number((db.prepare(`SELECT COALESCE(SUM(amount), 0) AS n FROM ai_usage WHERE user_id = ? AND period IN (${marks})`).get(owner(userId), ...periods) as { n: number }).n);
    },

    async aiAdd(userId, period, amount) {
      const id = owner(userId);
      aiAdd.run(id, period, Math.max(0, Math.round(amount)));
      const month = /\d{4}-\d{2}/.exec(period)?.[0];
      if (month) aiForget.run(id, monthsBefore(month, 13));
      return (aiUsed.get(id, period) as { amount: number }).amount;
    },
  };
}

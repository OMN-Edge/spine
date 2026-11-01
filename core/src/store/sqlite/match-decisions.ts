import type { Database } from './driver.js';
import { owner } from '../owner.js';
import type { MatchDecisionRepository } from '../types.js';

/** Every statement filters by `user_id` (SECURITY.md P12). */
export function matchDecisionRepository(db: Database): MatchDecisionRepository {
  const has = db.prepare('SELECT 1 FROM match_decisions WHERE user_id = ? AND kind = ? AND pair_key = ?');
  const add = db.prepare('INSERT OR REPLACE INTO match_decisions (user_id, kind, pair_key, decided_at) VALUES (?, ?, ?, ?)');
  const list = db.prepare('SELECT pair_key FROM match_decisions WHERE user_id = ? AND kind = ?');
  const removeAll = db.prepare('DELETE FROM match_decisions WHERE user_id = ?');
  return {
    async removeAll(userId) { return removeAll.run(owner(userId)).changes; },
    async has(userId, kind, pairKey) { return !!has.get(owner(userId), kind, pairKey); },
    async add(userId, kind, pairKey, at) { add.run(owner(userId), kind, pairKey, at); },
    async list(userId, kind) { return new Set((list.all(owner(userId), kind) as Array<{ pair_key: string }>).map(r => r.pair_key)); },
  };
}

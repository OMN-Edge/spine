import type { Database } from './driver.js';
import { owner } from '../owner.js';
import type { GuideMark, GuideRepository } from '../types.js';

/** Every statement filters by `user_id` (SECURITY.md P12). */
export function guideRepository(db: Database): GuideRepository {
  const list = db.prepare('SELECT key, shown, last_shown_at, done_at FROM guide_marks WHERE user_id = ? ORDER BY key');
  const shown = db.prepare(`
    INSERT INTO guide_marks (user_id, key, shown, last_shown_at) VALUES (?, ?, 1, ?)
    ON CONFLICT (user_id, key) DO UPDATE SET shown = shown + 1, last_shown_at = excluded.last_shown_at
  `);
  const done = db.prepare(`
    INSERT INTO guide_marks (user_id, key, shown, done_at) VALUES (?, ?, 0, ?)
    ON CONFLICT (user_id, key) DO UPDATE SET done_at = COALESCE(done_at, excluded.done_at)
  `);
  return {
    async list(userId) { return list.all(owner(userId)) as GuideMark[]; },
    async shown(userId, key, at) { shown.run(owner(userId), key, at); },
    async done(userId, key, at) { done.run(owner(userId), key, at); },
  };
}

import type { Database } from './driver.js';
import { owner } from './owner.js';
import type { SessionRecord, SessionRepository } from '../types.js';

const COLUMNS = 'id, created_at, last_seen_at, user_agent, address';

/** Every statement filters by `user_id` (SECURITY.md P12). */
export function sessionRepository(db: Database): SessionRepository {
  const insert = db.prepare('INSERT INTO user_sessions (id, user_id, created_at, last_seen_at, user_agent, address) VALUES (?, ?, ?, ?, ?, ?)');
  const get = db.prepare(`SELECT ${COLUMNS} FROM user_sessions WHERE user_id = ? AND id = ?`);
  const touch = db.prepare('UPDATE user_sessions SET last_seen_at = ? WHERE user_id = ? AND id = ?');
  const list = db.prepare(`SELECT ${COLUMNS} FROM user_sessions WHERE user_id = ? ORDER BY last_seen_at DESC`);
  const revoke = db.prepare('DELETE FROM user_sessions WHERE user_id = ? AND id = ?');
  const revokeExcept = db.prepare('DELETE FROM user_sessions WHERE user_id = ? AND id IS NOT ?');
  const prune = db.prepare('DELETE FROM user_sessions WHERE user_id = ? AND (created_at < ? OR last_seen_at < ?)');
  const deviceCount = db.prepare('SELECT COUNT(*) AS n FROM user_devices WHERE user_id = ?');
  const deviceKnown = db.prepare('SELECT 1 FROM user_devices WHERE user_id = ? AND device_hash = ?');
  const deviceAdd = db.prepare('INSERT OR IGNORE INTO user_devices (user_id, device_hash, first_seen_at) VALUES (?, ?, ?)');

  return {
    async open(userId, s) { insert.run(s.id, owner(userId), s.at, s.at, s.userAgent, s.address); },
    async get(userId, id) { return (get.get(owner(userId), id) as SessionRecord | undefined) ?? null; },
    async touch(userId, id, at) { touch.run(at, owner(userId), id); },
    async list(userId) { return list.all(owner(userId)) as SessionRecord[]; },
    async revoke(userId, id) { return revoke.run(owner(userId), id).changes > 0; },
    async revokeExcept(userId, keepId) { return revokeExcept.run(owner(userId), keepId).changes; },
    async prune(userId, startedBefore, idleSince) { return prune.run(owner(userId), startedBefore, idleSince).changes; },
    async rememberDevice(userId, deviceHash, at) {
      const id = owner(userId);
      if (deviceKnown.get(id, deviceHash)) return 'known';
      const had = (deviceCount.get(id) as { n: number }).n > 0;
      deviceAdd.run(id, deviceHash, at);
      return had ? 'new' : 'first';
    },
  };
}

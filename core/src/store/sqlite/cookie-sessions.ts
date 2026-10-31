import type { Database } from './driver.js';
import type { CookieSessionRepository } from '../types.js';

/** The seventh exception to P12 (store/types.ts): found by the digest of the cookie's id, before there is an acting user. */
export function cookieSessionRepository(db: Database): CookieSessionRepository {
  const get = db.prepare('SELECT data FROM cookie_sessions WHERE sid_hash = ? AND expires_at > ?');
  const set = db.prepare(`
    INSERT INTO cookie_sessions (sid_hash, user_id, data, expires_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (sid_hash) DO UPDATE SET user_id = excluded.user_id, data = excluded.data, expires_at = excluded.expires_at`);
  const destroy = db.prepare('DELETE FROM cookie_sessions WHERE sid_hash = ?');

  return {
    async get(sidHash, now) { return (get.get(sidHash, now) as { data: string } | undefined)?.data ?? null; },
    async set(sidHash, row) { set.run(sidHash, row.userId, row.data, row.expiresAt); },
    async destroy(sidHash) { destroy.run(sidHash); },
  };
}

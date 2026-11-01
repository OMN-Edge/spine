import type { Database } from './driver.js';
import { owner } from '../owner.js';
import type { EmergencyCardRow, EmergencyRepository, EmergencyScan } from '../types.js';

/** Every statement filters by `user_id` (SECURITY.md P12). */
export function emergencyRepository(db: Database): EmergencyRepository {
  const get = db.prepare('SELECT content, card_id, card_key, published_at, updated_at, reviewed_at FROM emergency_cards WHERE user_id = ?');
  const save = db.prepare(`
    INSERT INTO emergency_cards (user_id, content, updated_at, reviewed_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (user_id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at, reviewed_at = excluded.reviewed_at
  `);
  const reviewed = db.prepare('UPDATE emergency_cards SET reviewed_at = ? WHERE user_id = ?');
  const published = db.prepare(`
    INSERT INTO emergency_cards (user_id, content, card_id, card_key, published_at, updated_at, reviewed_at) VALUES (?, '{}', ?, ?, ?, ?, ?)
    ON CONFLICT (user_id) DO UPDATE SET card_id = excluded.card_id, card_key = excluded.card_key, published_at = excluded.published_at, updated_at = excluded.updated_at
  `);
  const addScan = db.prepare('INSERT OR IGNORE INTO emergency_scans (id, user_id, at, country) VALUES (?, ?, ?, ?)');
  const scans = db.prepare('SELECT id, at, country FROM emergency_scans WHERE user_id = ? ORDER BY at DESC, id LIMIT ?');
  return {
    async get(userId) { return (get.get(owner(userId)) as EmergencyCardRow | undefined) ?? null; },
    async save(userId, content, now) { save.run(owner(userId), content, now, now); },
    async markReviewed(userId, now) { reviewed.run(now, owner(userId)); },
    async setPublished(userId, p, now) { published.run(owner(userId), p?.id ?? null, p?.key ?? null, p ? now : null, now, p ? now : null); },
    async addScan(userId, s) { addScan.run(s.id, owner(userId), s.at, s.country); },
    async scans(userId, limit) { return scans.all(owner(userId), limit) as EmergencyScan[]; },
  };
}

import type { Database } from './driver.js';
import { owner } from '../owner.js';
import type { RegroupPlanRepository } from '../types.js';

/** Every statement filters by `user_id` (SECURITY.md P12). */
export function regroupPlanRepository(db: Database): RegroupPlanRepository {
  const mine = db.prepare('SELECT 1 FROM source_files WHERE id = ? AND user_id = ?');
  const save = db.prepare('INSERT OR REPLACE INTO regroup_plans (source_file_id, user_id, created_at, plan) VALUES (?, ?, ?, ?)');
  const get = db.prepare('SELECT plan, created_at FROM regroup_plans WHERE source_file_id = ? AND user_id = ?');
  const remove = db.prepare('DELETE FROM regroup_plans WHERE source_file_id = ? AND user_id = ?');
  return {
    async save(userId, sourceFileId, plan, createdAt) {
      const uid = owner(userId);
      if (!mine.get(sourceFileId, uid)) return false;
      save.run(sourceFileId, uid, createdAt, JSON.stringify(plan));
      return true;
    },
    async get(userId, sourceFileId) {
      const row = get.get(sourceFileId, owner(userId)) as { plan: string; created_at: string } | undefined;
      return row ? { plan: JSON.parse(row.plan) as unknown, created_at: row.created_at } : null;
    },
    async remove(userId, sourceFileId) { remove.run(sourceFileId, owner(userId)); },
  };
}

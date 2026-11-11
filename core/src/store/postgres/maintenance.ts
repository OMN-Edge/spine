import type { MaintenanceRepository } from '../types.js';
import { changed, many, type Query } from './query.js';

/**
 * Boot-time operations across all rows, run by the process itself. No acting user (the third documented exception to P12's rule).
 * The server keeps no records, so there is no upload to find or fail; and the database is backed up by whoever runs it (managed
 * Postgres keeps its own backups and point-in-time recovery, or `pg_dump` does), so there is no snapshot to make here.
 */
export function maintenanceRepository(q: Query): MaintenanceRepository {
  return {
    async snapshotTo() {
      throw new Error('a Postgres database is backed up by its host (managed backups, or pg_dump), not by a snapshot file');
    },

    async claimDueReminders(today, at) {
      const rows = await many<{ recipient: string; n: number }>(q, `
        WITH claimed AS (UPDATE reminder_dues SET mailed_on = $2 WHERE due_on <= $1 AND mailed_on IS NULL RETURNING user_id, profile_id)
        SELECT recipient, COUNT(*) AS n FROM (
          SELECT user_id AS recipient FROM claimed
          UNION ALL
          SELECT d.delegate_user_id AS recipient FROM claimed c JOIN delegations d ON d.owner_user_id = c.user_id AND d.profile_id = c.profile_id AND d.state = 'active' AND d.role IN ('guardian', 'self')
        ) t GROUP BY recipient`, [today, at]);
      return rows.map(r => ({ recipient: r.recipient, n: Number(r.n) }));
    },

    async releaseReminders(at) {
      return changed(q, 'UPDATE reminder_dues SET mailed_on = NULL WHERE mailed_on = $1', [at]);
    },

    async pruneSessions(startedBefore, idleSince, devicesFirstSeenBefore, cookiesExpiredBefore) {
      if (cookiesExpiredBefore) await q('DELETE FROM cookie_sessions WHERE expires_at < $1', [cookiesExpiredBefore]);
      // A browser's cookie lasts a year (the privacy notice says so); the hash of it is not kept longer.
      if (devicesFirstSeenBefore) await q('DELETE FROM user_devices WHERE first_seen_at < $1', [devicesFirstSeenBefore]);
      return changed(q, 'DELETE FROM user_sessions WHERE created_at < $1 OR last_seen_at < $2', [startedBefore, idleSince]);
    },

    async stalledSourceFiles() { return []; },
    async failStalledSourceFiles() { return 0; },
    async uploadsWithUnreadDocuments() { return []; },
  };
}

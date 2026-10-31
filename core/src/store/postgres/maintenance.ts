import type { MaintenanceRepository } from '../types.js';
import { changed, type Query } from './query.js';

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

    async pruneSessions(startedBefore, idleSince, devicesFirstSeenBefore, cookiesExpiredBefore) {
      if (cookiesExpiredBefore) await q('DELETE FROM cookie_sessions WHERE expires_at < $1', [cookiesExpiredBefore]);
      // A browser's cookie lasts a year (the privacy notice says so); the hash of it is not kept longer.
      if (devicesFirstSeenBefore) await q('DELETE FROM user_devices WHERE first_seen_at < $1', [devicesFirstSeenBefore]);
      return changed(q, 'DELETE FROM user_sessions WHERE created_at < $1 OR last_seen_at < $2', [startedBefore, idleSince]);
    },

    async stalledSourceFiles() { return []; },
    async failStalledSourceFiles() { return 0; },
  };
}

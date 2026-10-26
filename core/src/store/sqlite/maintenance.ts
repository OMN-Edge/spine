import type { Database } from './driver.js';
import type { MaintenanceRepository } from '../types.js';

/**
 * Boot-time operations across all rows, run by the process itself. No acting
 * user, which is the third and last documented exception to P12's rule.
 */
export function maintenanceRepository(db: Database): MaintenanceRepository {

  return {
    /**
     * `VACUUM INTO` rather than a file copy: in WAL mode the `-wal` sidecar
     * holds committed pages the main file does not, so copying under load can
     * produce a torn snapshot. Parameters are not allowed in VACUUM INTO, so
     * the path is interpolated — it comes from configuration, never a request,
     * and single quotes are doubled for SQL string syntax.
     */
    async snapshotTo(destination) {
      db.exec(`VACUUM INTO '${destination.replace(/'/g, "''")}'`);
    },

    async pruneSessions(startedBefore, idleSince, devicesFirstSeenBefore) {
      // A browser's cookie lasts a year (the privacy notice says so); the hash of it is not kept longer.
      if (devicesFirstSeenBefore) db.prepare('DELETE FROM user_devices WHERE first_seen_at < ?').run(devicesFirstSeenBefore);
      return db.prepare('DELETE FROM user_sessions WHERE created_at < ? OR last_seen_at < ?').run(startedBefore, idleSince).changes;
    },

    async failStalledSourceFiles() {
      // Prepared here and not when the repository is built: the server's database has no `source_files` (SECURITY.md M-37), and only the
      // device's core, which has, asks for this.
      return db.prepare(`
        UPDATE source_files
        SET status = 'error',
            error_message = COALESCE(error_message, 'interrupted — the page was closed or reloaded during processing')
        WHERE status IN ('pending', 'processing')
      `).run().changes;
    },
  };
}

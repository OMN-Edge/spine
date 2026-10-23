import type { Database } from './driver.js';
import type { MaintenanceRepository } from '../types.js';

/**
 * Boot-time operations across all rows, run by the process itself. No acting
 * user, which is the third and last documented exception to P12's rule.
 */
export function maintenanceRepository(db: Database): MaintenanceRepository {
  const failStalled = db.prepare(`
    UPDATE source_files
    SET status = 'error',
        error_message = COALESCE(error_message, 'interrupted — server restarted during processing')
    WHERE status IN ('pending', 'processing')
  `);
  const listTokens = db.prepare('SELECT id, token FROM share_links');
  const setToken = db.prepare('UPDATE share_links SET token = ? WHERE id = ?');

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

    async failStalledSourceFiles() {
      return failStalled.run().changes;
    },

    async listShareLinkTokens() {
      return listTokens.all() as Array<{ id: string; token: string }>;
    },

    async setShareLinkToken(id, tokenHash) {
      setToken.run(tokenHash, id);
    },
  };
}

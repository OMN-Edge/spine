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

    async failStalledSourceFiles() {
      // Prepared here and not when the repository is built: the server's database has no `source_files` (SECURITY.md M-37), and only the
      // device's core, which has, asks for this.
      return db.prepare(`
        UPDATE source_files
        SET status = 'error',
            error_message = COALESCE(error_message, 'interrupted — server restarted during processing')
        WHERE status IN ('pending', 'processing')
      `).run().changes;
    },

    async listShareLinkTokens() {
      return db.prepare('SELECT id, token FROM share_links').all() as Array<{ id: string; token: string }>;
    },

    async setShareLinkToken(id, tokenHash) {
      db.prepare('UPDATE share_links SET token = ? WHERE id = ?').run(tokenHash, id);
    },
  };
}

import type { Database } from './driver.js';
import type { MaintenanceRepository } from '../types.js';
import { VISIBLE } from './visibility.js';

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

    async claimDueReminders(today, at) {
      const run = db.transaction((): Array<{ recipient: string; n: number }> => {
        const due = db.prepare('SELECT user_id, profile_id FROM reminder_dues WHERE due_on <= ? AND mailed_on IS NULL').all(today) as Array<{ user_id: string; profile_id: string }>;
        if (due.length === 0) return [];
        const counts = new Map<string, number>();
        const add = (who: string) => counts.set(who, (counts.get(who) ?? 0) + 1);
        const looking = db.prepare("SELECT delegate_user_id FROM delegations WHERE owner_user_id = ? AND profile_id = ? AND state = 'active' AND role IN ('guardian', 'self')");
        for (const d of due) {
          add(d.user_id);
          for (const g of looking.all(d.user_id, d.profile_id) as Array<{ delegate_user_id: string }>) add(g.delegate_user_id);
        }
        db.prepare('UPDATE reminder_dues SET mailed_on = ? WHERE due_on <= ? AND mailed_on IS NULL').run(at, today);
        return [...counts].map(([recipient, n]) => ({ recipient, n }));
      });
      return run();
    },

    async releaseReminders(at) {
      return db.prepare('UPDATE reminder_dues SET mailed_on = NULL WHERE mailed_on = ?').run(at).changes;
    },

    async pruneSessions(startedBefore, idleSince, devicesFirstSeenBefore, cookiesExpiredBefore) {
      if (cookiesExpiredBefore) db.prepare('DELETE FROM cookie_sessions WHERE expires_at < ?').run(cookiesExpiredBefore);
      // A browser's cookie lasts a year (the privacy notice says so); the hash of it is not kept longer.
      if (devicesFirstSeenBefore) db.prepare('DELETE FROM user_devices WHERE first_seen_at < ?').run(devicesFirstSeenBefore);
      return db.prepare('DELETE FROM user_sessions WHERE created_at < ? OR last_seen_at < ?').run(startedBefore, idleSince).changes;
    },

    async stalledSourceFiles() {
      const rows = db.prepare(`SELECT id, user_id, file_path, from_export FROM source_files WHERE status IN ('pending', 'processing')`).all() as Array<{ id: string; user_id: string; file_path: string; from_export: number }>;
      return rows.map(row => ({ ...row, from_export: row.from_export === 1 }));
    },

    async uploadsWithUnreadDocuments() {
      // Prepared here, as below: only the device's core has `documents`.
      return db.prepare(`
        SELECT DISTINCT d.source_file_id AS id, d.user_id
        FROM documents d
        JOIN source_files s ON s.id = d.source_file_id AND s.user_id = d.user_id
        WHERE d.needs_reading = 1 AND s.status = 'done' AND ${VISIBLE}
      `).all() as Array<{ id: string; user_id: string }>;
    },

    async failStalledSourceFiles(keep = []) {
      // Prepared here and not when the repository is built: the server's database has no `source_files` (SECURITY.md M-37), and only the
      // device's core, which has, asks for this.
      return db.prepare(`
        UPDATE source_files
        SET status = 'error',
            error_message = COALESCE(error_message, 'interrupted — the page was closed or reloaded during processing')
        WHERE status IN ('pending', 'processing')${keep.length > 0 ? ` AND id NOT IN (${keep.map(() => '?').join(', ')})` : ''}
      `).run(...keep).changes;
    },
  };
}

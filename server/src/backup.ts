import { existsSync, mkdirSync, readdirSync, statSync, copyFileSync, rmSync, utimesSync } from 'fs';
import path from 'path';
import { getAccountsStore } from 'spine-core/store/index.js';
import { loadStoreConfig, resolveBackupDir, resolveDataDir } from 'spine-core/config.js';
import { useAccountsStore } from './store.js';
import { objects } from './objects/index.js';

/**
 * SECURITY.md P11: `data/spine.db` and `data/vault/` must be restorable.
 *
 * The vault is where a person's records live: `vault_objects` in the database holds
 * only the metadata, and the sealed bytes are files under `data/vault/`. A snapshot of
 * the database without them restores an account with nothing in it, so they are
 * mirrored too. They are ciphertext, so the backup holds nothing readable. `data/shares/`
 * is not copied: a share is meant to end, and a copy in a backup would outlive its revoke.
 *
 * Two different problems, two different mechanisms:
 *
 *  - **The database** gets a `VACUUM INTO` snapshot. Copying the file under load
 *    is unsafe in WAL mode — the `-wal` sidecar holds committed pages the main
 *    file does not — and `VACUUM INTO` writes a consistent, already-compacted
 *    copy through SQLite itself.
 *  - **The vault's sealed objects** are plain files, so they are mirrored (copied when
 *    new or changed, dropped when the source drops them): cheap, which matters when the
 *    archive is scans on an SD card.
 *
 * What this does *not* do: survive loss of the medium. A snapshot beside the
 * original is protection against corruption, a bad migration and `rm`, not
 * against a dead SD card. Point `SPINE_BACKUP_DIR` at removable or network
 * storage for that — it is the one knob that turns this into an offsite backup,
 * and it is the operator's call.
 */

export interface BackupOptions {
  dataDir: string;
  backupDir: string;
  /** Database snapshots to retain, newest first. */
  keep: number;
  now?: Date;
  /** False when the database is not a file this process can snapshot (Postgres: managed backups, or `pg_dump`). Default true. */
  database?: boolean;
  /** False when the sealed objects are not files on this machine (a bucket): the bucket's own versioning or soft delete is their backup. Default true. */
  files?: boolean;
}

export interface BackupResult {
  /** The database snapshot, or null where the database is backed up by its host (Postgres). */
  snapshot: string | null;
  /** Sealed vault objects newly copied or replaced by this run. */
  vaultCopied: number;
  /** Older snapshots removed by retention. */
  snapshotsPruned: string[];
}

const SNAPSHOT_PREFIX = 'spine-';
const SNAPSHOT_SUFFIX = '.db';
/** How much older than its source a copied object's time may read and still be current: the resolution of a time held as a double of seconds (measured at about 0.001 ms), with room, and far below any real edit. */
const MTIME_EPSILON_MS = 0.01;

function timestamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
}

/**
 * An object is overwritten under the same id when it changes, so size
 * alone cannot say it is current: a different size or an older modification time copies
 * it again, and the copy keeps the source's time so the next run can tell. Inside a
 * user's directory the mirror also drops what the source no longer has, because a deleted
 * object should not survive in the backup; a user's whole directory is removed only by
 * `deleteAccount`, so an empty or missing `data/vault` can never empty the backup.
 */
function mirrorVault(from: string, to: string): number {
  if (!existsSync(from)) return 0;
  let copied = 0;
  for (const user of readdirSync(from, { withFileTypes: true })) {
    if (!user.isDirectory()) continue;
    const sourceDir = path.join(from, user.name);
    const targetDir = path.join(to, user.name);
    mkdirSync(targetDir, { recursive: true });

    const held = new Set<string>();
    for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
      // A write in flight is a `.part` file beside the object; the rename makes it real.
      if (!entry.isFile() || entry.name.endsWith('.part')) continue;
      held.add(entry.name);
      const source = path.join(sourceDir, entry.name);
      const target = path.join(targetDir, entry.name);
      const s = statSync(source);
      if (existsSync(target)) {
        const t = statSync(target);
        // The copy carries the source's time to the finest a double holds (about a microsecond at today's date), so it is current when it
        // is not older than that. Going through `s.mtime`, a Date, cut it to whole milliseconds and, as float seconds, came back up to
        // a millisecond older on Linux with Node 22: about half the vault looked changed on every run.
        if (t.size === s.size && t.mtimeMs >= s.mtimeMs - MTIME_EPSILON_MS) continue;
      }
      copyFileSync(source, target);
      utimesSync(target, s.atimeMs / 1000, s.mtimeMs / 1000);
      copied += 1;
    }
    for (const entry of readdirSync(targetDir, { withFileTypes: true })) {
      if (entry.isFile() && !held.has(entry.name)) rmSync(path.join(targetDir, entry.name), { force: true });
    }
  }
  return copied;
}

function pruneSnapshots(backupDir: string, keep: number): string[] {
  const snapshots = readdirSync(backupDir)
    .filter(f => f.startsWith(SNAPSHOT_PREFIX) && f.endsWith(SNAPSHOT_SUFFIX))
    .sort()
    .reverse();

  const doomed = snapshots.slice(Math.max(keep, 1));
  for (const file of doomed) rmSync(path.join(backupDir, file), { force: true });
  return doomed;
}

export async function runBackup({
  dataDir,
  backupDir,
  keep,
  now = new Date(),
  database = true,
  files = true,
}: BackupOptions): Promise<BackupResult> {
  mkdirSync(backupDir, { recursive: true });

  const snapshot = database ? path.join(backupDir, `${SNAPSHOT_PREFIX}${timestamp(now)}${SNAPSHOT_SUFFIX}`) : null;
  if (snapshot && existsSync(snapshot)) rmSync(snapshot); // VACUUM INTO refuses an existing file

  // How the snapshot is taken is the adapter's business (VACUUM INTO for
  // SQLite); this file only decides where it goes and what to keep.
  if (snapshot) await getAccountsStore().maintenance.snapshotTo(snapshot);

  // After the snapshot, never before: an object's file is written before its row, so files
  // copied now are at least as new as the rows just snapshotted.
  const vaultCopied = files ? mirrorVault(path.join(dataDir, 'vault'), path.join(backupDir, 'vault')) : 0;

  return { snapshot, vaultCopied, snapshotsPruned: pruneSnapshots(backupDir, keep) };
}

/** CLI entry point: `node dist/backup.js`, run by spine-backup.service. */
async function main(): Promise<void> {
  useAccountsStore();
  const dataDir = resolveDataDir();
  const backupDir = resolveBackupDir();
  const keep = Number(process.env.SPINE_BACKUP_KEEP ?? 7);

  if (!Number.isInteger(keep) || keep < 1) {
    console.error(`SPINE_BACKUP_KEEP must be a positive integer, got "${process.env.SPINE_BACKUP_KEEP}"`);
    process.exit(1);
  }

  const result = await runBackup({ dataDir, backupDir, keep, database: loadStoreConfig().adapter === 'sqlite', files: objects().kind === 'filesystem' });
  console.log(
    `backup: ${result.snapshot ?? 'database left to its host'}, ` +
      `${result.vaultCopied} vault object(s) mirrored, ` +
      `${result.snapshotsPruned.length} old snapshot(s) pruned`,
  );
}

// Only when executed directly, so importing this in a test does not run it.
if (process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join('dist', 'backup.js'))) {
  await main();
}

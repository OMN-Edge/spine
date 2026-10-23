import { existsSync, mkdirSync, readdirSync, statSync, copyFileSync, rmSync, utimesSync } from 'fs';
import path from 'path';
import { getStore } from './store/index.js';
import { resolveBackupDir, resolveDataDir } from './config.js';

/**
 * SECURITY.md P11: `data/spine.db` and `data/originals/` must be restorable.
 * `data/pages/` is regenerable and is deliberately not copied.
 *
 * The vault is where a person's records live now: `vault_objects` in the database holds
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
 *  - **Originals are never modified after upload**, so they need no snapshot at
 *    all: a forward-only mirror that copies what it does not already have is
 *    both correct and cheap, which matters when the archive is scans on an SD
 *    card.
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
}

export interface BackupResult {
  snapshot: string;
  /** Originals newly mirrored by this run. */
  originalsCopied: number;
  /** Sealed vault objects newly copied or replaced by this run. */
  vaultCopied: number;
  /** Older snapshots removed by retention. */
  snapshotsPruned: string[];
}

const SNAPSHOT_PREFIX = 'spine-';
const SNAPSHOT_SUFFIX = '.db';

function timestamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
}

/** Copy forward anything the mirror does not already hold, preserving layout. */
function mirrorTree(from: string, to: string): number {
  if (!existsSync(from)) return 0;
  mkdirSync(to, { recursive: true });

  let copied = 0;
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);

    if (entry.isDirectory()) {
      copied += mirrorTree(source, target);
      continue;
    }
    if (!entry.isFile()) continue;

    // Originals are immutable, so same name plus same size means same file.
    // Re-copying a changed one would be wrong here anyway: it would mean the
    // archive mutated something it promises never to touch.
    if (existsSync(target) && statSync(target).size === statSync(source).size) continue;

    copyFileSync(source, target);
    copied += 1;
  }
  return copied;
}

/**
 * Unlike originals, an object is overwritten under the same id when it changes, so size
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
        if (t.size === s.size && Math.floor(t.mtimeMs) >= Math.floor(s.mtimeMs)) continue; // utimes keeps milliseconds only
      }
      copyFileSync(source, target);
      utimesSync(target, s.atime, s.mtime);
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
}: BackupOptions): Promise<BackupResult> {
  mkdirSync(backupDir, { recursive: true });

  const snapshot = path.join(backupDir, `${SNAPSHOT_PREFIX}${timestamp(now)}${SNAPSHOT_SUFFIX}`);
  if (existsSync(snapshot)) rmSync(snapshot); // VACUUM INTO refuses an existing file

  // How the snapshot is taken is the adapter's business (VACUUM INTO for
  // SQLite); this file only decides where it goes and what to keep.
  await getStore().maintenance.snapshotTo(snapshot);

  const originalsCopied = mirrorTree(
    path.join(dataDir, 'originals'),
    path.join(backupDir, 'originals'),
  );

  // After the snapshot, never before: an object's file is written before its row, so files
  // copied now are at least as new as the rows just snapshotted.
  const vaultCopied = mirrorVault(path.join(dataDir, 'vault'), path.join(backupDir, 'vault'));

  return { snapshot, originalsCopied, vaultCopied, snapshotsPruned: pruneSnapshots(backupDir, keep) };
}

/** CLI entry point: `node dist/backup.js`, run by spine-backup.service. */
async function main(): Promise<void> {
  process.env.SPINE_STORE_SCOPE = 'accounts';
  const dataDir = resolveDataDir();
  const backupDir = resolveBackupDir();
  const keep = Number(process.env.SPINE_BACKUP_KEEP ?? 7);

  if (!Number.isInteger(keep) || keep < 1) {
    console.error(`SPINE_BACKUP_KEEP must be a positive integer, got "${process.env.SPINE_BACKUP_KEEP}"`);
    process.exit(1);
  }

  const result = await runBackup({ dataDir, backupDir, keep });
  console.log(
    `backup: ${result.snapshot}, ${result.originalsCopied} original(s) mirrored, ` +
      `${result.vaultCopied} vault object(s) mirrored, ` +
      `${result.snapshotsPruned.length} old snapshot(s) pruned`,
  );
}

// Only when executed directly, so importing this in a test does not run it.
if (process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join('dist', 'backup.js'))) {
  await main();
}

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, rmSync, readFileSync, statSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { buildTestApp } from './helpers/app.js';
import { OWNER_ID } from './helpers/seed.js';
import { getStore } from 'spine-core/store/index.js';
import { runBackup } from '../backup.js';

/** P11: spine.db and data/vault/ must be restorable. */

let app: Awaited<ReturnType<typeof buildTestApp>>;
let dataDir: string;
let backupDir: string;

beforeAll(async () => { app = await buildTestApp(); });
afterAll(async () => { await app.close(); });

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'spine-data-'));
  backupDir = mkdtempSync(path.join(tmpdir(), 'spine-backup-'));
});

function snapshots(): string[] {
  return readdirSync(backupDir).filter(f => f.startsWith('spine-') && f.endsWith('.db')).sort();
}

describe('runBackup — database snapshot', () => {
  it('writes a snapshot that is a readable database with the real rows', async () => {
    const result = await runBackup({ dataDir, backupDir, keep: 7 });

    expect(existsSync(result.snapshot)).toBe(true);

    // Open the snapshot as its own database — a file that cannot be read back
    // is not a backup.
    const restored = new Database(result.snapshot, { readonly: true });
    try {
      const row = restored.prepare('SELECT id FROM users WHERE id = ?').get(OWNER_ID) as
        { id: string } | undefined;
      expect(row?.id).toBe(OWNER_ID);
    } finally {
      restored.close();
    }
  });
});

describe('runBackup — vault mirror', () => {
  function seedVault(user: string, id: string, body: string, when?: Date) {
    const dir = path.join(dataDir, 'vault', user);
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, id);
    writeFileSync(file, body);
    if (when) utimesSync(file, when, when);
  }
  const mirrored = (user: string, id: string) => path.join(backupDir, 'vault', user, id);

  it('copies sealed objects, and only what is new on a second run', async () => {
    seedVault('u1', 'obj-aaaaaaaa', 'sealed-1');
    seedVault('u2', 'obj-bbbbbbbb', 'sealed-2');

    expect((await runBackup({ dataDir, backupDir, keep: 7 })).vaultCopied).toBe(2);
    expect(readFileSync(mirrored('u1', 'obj-aaaaaaaa'), 'utf8')).toBe('sealed-1');
    expect((await runBackup({ dataDir, backupDir, keep: 7 })).vaultCopied).toBe(0);
  });

  it('keeps an object\'s modification time to the finest the file system holds, so the next run finds it current', async () => {
    // A time with a fraction of a millisecond, as a real write has. A copy that went through a whole-millisecond Date came back up to a
    // millisecond older than its source, and on Linux with Node 22 that made about half of the objects look changed on every run.
    const seconds = 1793452416.9714485;
    seedVault('u1', 'obj-aaaaaaaa', 'sealed-1');
    utimesSync(path.join(dataDir, 'vault', 'u1', 'obj-aaaaaaaa'), seconds, seconds);

    await runBackup({ dataDir, backupDir, keep: 7 });
    const source = statSync(path.join(dataDir, 'vault', 'u1', 'obj-aaaaaaaa')).mtimeMs;
    // A double holds a time this large to about a microsecond, so that is the most a copy can differ by.
    expect(Math.abs(statSync(mirrored('u1', 'obj-aaaaaaaa')).mtimeMs - source)).toBeLessThan(0.01);
    expect((await runBackup({ dataDir, backupDir, keep: 7 })).vaultCopied).toBe(0);
  });

  it('copies an object again when it was overwritten under the same id, even at the same size', async () => {
    seedVault('u1', 'obj-aaaaaaaa', 'revision-1', new Date(Date.UTC(2026, 0, 1)));
    await runBackup({ dataDir, backupDir, keep: 7 });

    seedVault('u1', 'obj-aaaaaaaa', 'revision-2', new Date(Date.UTC(2026, 0, 2)));
    expect((await runBackup({ dataDir, backupDir, keep: 7 })).vaultCopied).toBe(1);
    expect(readFileSync(mirrored('u1', 'obj-aaaaaaaa'), 'utf8')).toBe('revision-2');
  });

  it('drops an object the vault deleted, but never empties the backup because the vault is missing', async () => {
    seedVault('u1', 'obj-aaaaaaaa', 'one');
    seedVault('u1', 'obj-cccccccc', 'two');
    await runBackup({ dataDir, backupDir, keep: 7 });

    rmSync(path.join(dataDir, 'vault', 'u1', 'obj-cccccccc'));
    await runBackup({ dataDir, backupDir, keep: 7 });
    expect(existsSync(mirrored('u1', 'obj-cccccccc'))).toBe(false);
    expect(existsSync(mirrored('u1', 'obj-aaaaaaaa'))).toBe(true);

    rmSync(path.join(dataDir, 'vault'), { recursive: true });
    await runBackup({ dataDir, backupDir, keep: 7 });
    expect(existsSync(mirrored('u1', 'obj-aaaaaaaa'))).toBe(true);
  });

  it('leaves a write in flight alone and does not copy data/shares', async () => {
    seedVault('u1', 'obj-aaaaaaaa.1234.part', 'half');
    mkdirSync(path.join(dataDir, 'shares', 'abc'), { recursive: true });
    writeFileSync(path.join(dataDir, 'shares', 'abc', 'db'), 'sealed share');

    expect((await runBackup({ dataDir, backupDir, keep: 7 })).vaultCopied).toBe(0);
    expect(existsSync(path.join(backupDir, 'shares'))).toBe(false);
  });
});

describe('runBackup — retention', () => {
  it('keeps the newest N snapshots and prunes the rest', async () => {
    for (let day = 1; day <= 5; day++) {
      await runBackup({
        dataDir, backupDir, keep: 3,
        now: new Date(Date.UTC(2026, 0, day, 3, 0, 0)),
      });
    }

    const remaining = snapshots();
    expect(remaining).toHaveLength(3);
    // The three most recent dates, not the first three.
    expect(remaining.join(' ')).toContain('2026-01-05');
    expect(remaining.join(' ')).toContain('2026-01-03');
    expect(remaining.join(' ')).not.toContain('2026-01-01');
  });

  it('never prunes below one snapshot, even if asked', async () => {
    await runBackup({ dataDir, backupDir, keep: 0, now: new Date(Date.UTC(2026, 0, 1)) });
    await runBackup({ dataDir, backupDir, keep: 0, now: new Date(Date.UTC(2026, 0, 2)) });
    expect(snapshots()).toHaveLength(1);
  });

  it('leaves unrelated files in the backup directory alone', async () => {
    const stray = path.join(backupDir, 'README.txt');
    writeFileSync(stray, 'operator notes');

    await runBackup({ dataDir, backupDir, keep: 1 });
    await runBackup({ dataDir, backupDir, keep: 1, now: new Date(Date.UTC(2027, 0, 1)) });

    expect(existsSync(stray)).toBe(true);
  });

  it('overwrites rather than failing if a snapshot for that instant exists', async () => {
    const now = new Date(Date.UTC(2026, 5, 1, 12, 0, 0));
    const first = await runBackup({ dataDir, backupDir, keep: 7, now });
    const second = await runBackup({ dataDir, backupDir, keep: 7, now });
    expect(second.snapshot).toBe(first.snapshot);
    expect(existsSync(second.snapshot)).toBe(true);
  });
});

afterAll(() => {
  for (const dir of [dataDir, backupDir]) {
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

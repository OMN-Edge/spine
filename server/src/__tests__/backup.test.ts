import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { buildTestApp } from './helpers/app.js';
import { seedSourceFile } from './helpers/seed.js';
import { getStore } from '../store/index.js';
import { runBackup } from '../backup.js';

/** P11: spine.db and data/originals/ must be restorable. */

let app: Awaited<ReturnType<typeof buildTestApp>>;
let dataDir: string;
let backupDir: string;

beforeAll(async () => { app = await buildTestApp(); });
afterAll(async () => { await app.close(); });

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'spine-data-'));
  backupDir = mkdtempSync(path.join(tmpdir(), 'spine-backup-'));
});

function seedOriginal(year: string, name: string, body: string) {
  const dir = path.join(dataDir, 'originals', year);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, name), body);
}

function snapshots(): string[] {
  return readdirSync(backupDir).filter(f => f.startsWith('spine-') && f.endsWith('.db')).sort();
}

describe('runBackup — database snapshot', () => {
  it('writes a snapshot that is a readable database with the real rows', async () => {
    const id = await seedSourceFile({ status: 'done' });

    const result = await runBackup({ dataDir, backupDir, keep: 7 });

    expect(existsSync(result.snapshot)).toBe(true);

    // Open the snapshot as its own database — a file that cannot be read back
    // is not a backup.
    const restored = new Database(result.snapshot, { readonly: true });
    try {
      const row = restored.prepare('SELECT id FROM source_files WHERE id = ?').get(id) as
        { id: string } | undefined;
      expect(row?.id).toBe(id);
    } finally {
      restored.close();
    }
  });

  it('does not copy data/pages — it is regenerable', async () => {
    mkdirSync(path.join(dataDir, 'pages', 'sf-1'), { recursive: true });
    writeFileSync(path.join(dataDir, 'pages', 'sf-1', 'page-1.png'), 'png');

    await runBackup({ dataDir, backupDir, keep: 7 });

    expect(existsSync(path.join(backupDir, 'pages'))).toBe(false);
  });
});

describe('runBackup — originals mirror', () => {
  it('mirrors originals preserving their layout', async () => {
    seedOriginal('2026', 'a.pdf', 'aaa');
    seedOriginal('2025', 'b.pdf', 'bb');

    const result = await runBackup({ dataDir, backupDir, keep: 7 });

    expect(result.originalsCopied).toBe(2);
    expect(existsSync(path.join(backupDir, 'originals', '2026', 'a.pdf'))).toBe(true);
    expect(existsSync(path.join(backupDir, 'originals', '2025', 'b.pdf'))).toBe(true);
  });

  it('copies only what is new on a second run', async () => {
    seedOriginal('2026', 'a.pdf', 'aaa');
    expect((await runBackup({ dataDir, backupDir, keep: 7 })).originalsCopied).toBe(1);

    expect((await runBackup({ dataDir, backupDir, keep: 7 })).originalsCopied).toBe(0);

    seedOriginal('2026', 'c.pdf', 'cccc');
    expect((await runBackup({ dataDir, backupDir, keep: 7 })).originalsCopied).toBe(1);
  });

  it('works when there are no originals yet', async () => {
    const result = await runBackup({ dataDir, backupDir, keep: 7 });
    expect(result.originalsCopied).toBe(0);
    expect(existsSync(result.snapshot)).toBe(true);
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

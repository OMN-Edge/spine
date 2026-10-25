import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, rmSync, readFileSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { buildTestApp } from './helpers/app.js';
import { OWNER_ID } from './helpers/seed.js';
import { getStore } from 'spine-core/store/index.js';
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

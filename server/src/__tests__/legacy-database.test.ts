import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { createStore } from '../store/index.js';

/**
 * `CREATE TABLE IF NOT EXISTS` cannot add a column to an existing table, so a
 * database from before multi-user must be refused with a message that says what
 * to do — and what not to do (SECURITY.md M-10).
 */

let dir: string;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

function legacyDatabase(rows: { sourceFiles: number }) {
  dir = mkdtempSync(path.join(tmpdir(), 'spine-legacy-'));
  const file = path.join(dir, 'spine.db');
  const db = new Database(file);
  db.exec(`
    CREATE TABLE source_files (id TEXT PRIMARY KEY, uploaded_at TEXT NOT NULL, file_path TEXT NOT NULL);
    CREATE TABLE documents (id TEXT PRIMARY KEY, source_file_id TEXT);
  `);
  for (let i = 0; i < rows.sourceFiles; i++) {
    db.prepare('INSERT INTO source_files VALUES (?, ?, ?)').run(`f${i}`, '2026-01-01', '/x.pdf');
  }
  db.close();
  return file;
}

describe('opening a database from before multi-user', () => {
  it('refuses an empty one, and says it is safe to delete', () => {
    const file = legacyDatabase({ sourceFiles: 0 });
    expect(() => createStore({ adapter: 'sqlite', location: file })).toThrow(
      /earlier version.*0 uploads and 0 documents.*safe to delete/s,
    );
  });

  it('refuses one that holds records, and says not to delete it', () => {
    const file = legacyDatabase({ sourceFiles: 3 });
    expect(() => createStore({ adapter: 'sqlite', location: file })).toThrow(
      /3 uploads.*Do NOT delete/s,
    );
  });

  it('leaves the refused database untouched', () => {
    const file = legacyDatabase({ sourceFiles: 2 });
    expect(() => createStore({ adapter: 'sqlite', location: file })).toThrow();

    const db = new Database(file, { readonly: true });
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>;
    expect(tables.map(t => t.name)).not.toContain('users');
    expect((db.prepare('SELECT COUNT(*) n FROM source_files').get() as { n: number }).n).toBe(2);
    db.close();
  });

  it('refuses a multi-user database that predates email verification', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'spine-prev-'));
    const file = path.join(dir, 'spine.db');
    const db = new Database(file);
    db.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, password_hash TEXT, auth_version INTEGER, created_at TEXT);
      CREATE TABLE source_files (id TEXT PRIMARY KEY, user_id TEXT, uploaded_at TEXT, file_path TEXT);
      CREATE TABLE documents (id TEXT PRIMARY KEY, user_id TEXT);
    `);
    db.close();

    expect(() => createStore({ adapter: 'sqlite', location: file })).toThrow(
      /earlier version.*safe to delete/s,
    );
  });

  it('refuses a database whose documents predate titles', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'spine-notitle-'));
    const file = path.join(dir, 'spine.db');
    const db = new Database(file);
    db.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, email_verified_at TEXT);
      CREATE TABLE source_files (id TEXT PRIMARY KEY, user_id TEXT);
      CREATE TABLE documents (id TEXT PRIMARY KEY, user_id TEXT, doc_date TEXT);
      INSERT INTO documents VALUES ('d1', 'u1', '2026-01-01');
    `);
    db.close();

    // It holds a document, so the message must not tell anyone to delete it.
    expect(() => createStore({ adapter: 'sqlite', location: file })).toThrow(/earlier version.*Do NOT delete/s);
  });

  it('refuses a database whose doctors have no professional code, as one from before it was added', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'spine-nocode-'));
    const file = path.join(dir, 'spine.db');
    const db = new Database(file);
    db.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, email_verified_at TEXT);
      CREATE TABLE source_files (id TEXT PRIMARY KEY, user_id TEXT);
      CREATE TABLE documents (id TEXT PRIMARY KEY, user_id TEXT, title TEXT);
      CREATE TABLE extracted_fields (id TEXT PRIMARY KEY, group_no INTEGER);
      CREATE TABLE doctors (id TEXT PRIMARY KEY, user_id TEXT, name TEXT, key TEXT, specialty TEXT, clinic TEXT, created_at TEXT);
    `);
    db.close();

    expect(() => createStore({ adapter: 'sqlite', location: file })).toThrow(/earlier version.*safe to delete/s);
  });

  it('refuses a database whose search index only covers titles and summaries', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'spine-oldsearch-'));
    const file = path.join(dir, 'spine.db');
    const db = new Database(file);
    db.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, email_verified_at TEXT);
      CREATE TABLE source_files (id TEXT PRIMARY KEY, user_id TEXT);
      CREATE TABLE documents (id TEXT PRIMARY KEY, user_id TEXT, title TEXT);
      CREATE TABLE extracted_fields (id TEXT PRIMARY KEY, group_no INTEGER);
      CREATE TABLE doctors (id TEXT PRIMARY KEY, license_code TEXT);
      CREATE VIRTUAL TABLE documents_fts USING fts5(title, doc_type, provider, ai_summary, user_notes);
    `);
    db.close();

    expect(() => createStore({ adapter: 'sqlite', location: file })).toThrow(/earlier version.*safe to delete/s);
  });

  it('opens a fresh database and a current one without complaint', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'spine-current-'));
    const file = path.join(dir, 'spine.db');

    void createStore({ adapter: 'sqlite', location: file }).close();
    expect(() => createStore({ adapter: 'sqlite', location: file })).not.toThrow();
  });
});

import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { openDatabase } from '../store/sqlite/connection.js';
import { openNative } from '../testing/driver-native.js';

/** `source_files.from_export` is a new column with a default, so a database made without it is brought forward on open, and every upload in it counts as read by the pipeline. */
describe('source_files.from_export', () => {
  it('is added to a database made without it, and every upload already in it is one the pipeline read', () => {
    const location = path.join(mkdtempSync(path.join(tmpdir(), 'spine-col-')), 'old.db');
    const fresh = openDatabase(location, openNative, undefined, 'full');
    fresh.prepare("INSERT INTO users (id, email, password_hash, created_at) VALUES ('u', 'a@b.c', 'x', 'now')").run();
    fresh.prepare("INSERT INTO source_files (id, user_id, original_filename, file_path, checksum, status, uploaded_at) VALUES ('f', 'u', 'a.pdf', '/x', 'c', 'done', 'now')").run();
    fresh.exec('ALTER TABLE source_files DROP COLUMN from_export');
    fresh.close();

    const reopened = openDatabase(location, openNative, undefined, 'full');
    expect(reopened.prepare("SELECT from_export FROM source_files WHERE id = 'f'").get()).toEqual({ from_export: 0 });
    reopened.close();
  });
});

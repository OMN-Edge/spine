import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { openDatabase } from '../store/sqlite/connection.js';
import { openNative } from '../testing/driver-native.js';

/** `documents.needs_reading` is a new column with a default, so a database made without it is brought forward on open (M-10, M-29). */
describe('documents.needs_reading', () => {
  const columns = (db: ReturnType<typeof openDatabase>) =>
    (db.prepare("SELECT name, dflt_value FROM pragma_table_info('documents')").all() as Array<{ name: string; dflt_value: string | null }>);

  it('is added to a database made without it, and every document already in it counts as read', () => {
    const location = path.join(mkdtempSync(path.join(tmpdir(), 'spine-col-')), 'old.db');
    const fresh = openDatabase(location, openNative, undefined, 'full');
    fresh.prepare("INSERT INTO users (id, email, password_hash, created_at) VALUES ('u', 'a@b.c', 'x', 'now')").run();
    fresh.prepare("INSERT INTO source_files (id, user_id, original_filename, file_path, checksum, status, uploaded_at) VALUES ('f', 'u', 'a.pdf', '/x', 'c', 'done', 'now')").run();
    fresh.prepare("INSERT INTO documents (id, user_id, source_file_id, page_start, page_end) VALUES ('d', 'u', 'f', 1, 1)").run();
    fresh.exec('ALTER TABLE documents DROP COLUMN needs_reading');
    expect(columns(fresh).some(c => c.name === 'needs_reading')).toBe(false);
    fresh.close();

    const reopened = openDatabase(location, openNative, undefined, 'full');
    expect(columns(reopened).find(c => c.name === 'needs_reading')?.dflt_value).toBe('0');
    expect(reopened.prepare("SELECT needs_reading FROM documents WHERE id = 'd'").get()).toEqual({ needs_reading: 0 });
    reopened.close();
  });
});

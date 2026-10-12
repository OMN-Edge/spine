import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Opening the database, applying the idempotent schema, and setting pragmas.
 * Moved here from `db/index.ts` so that every SQLite-specific detail lives
 * inside the adapter.
 */
export function openDatabase(location: string): Database.Database {
  if (location !== ':memory:') fs.mkdirSync(path.dirname(location), { recursive: true });

  const db = new Database(location);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  refuseOutdatedDatabase(db, location);

  // Idempotent `CREATE TABLE IF NOT EXISTS`, re-applied every boot. The file
  // sits beside this adapter because it is SQLite-specific DDL; `npm run build`
  // copies it next to the compiled output.
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

  return db;
}

/**
 * `CREATE TABLE IF NOT EXISTS` cannot add a column to a table that already
 * exists, so a database made by an earlier version would fail partway through the
 * schema with "no such column" — an error that points nowhere useful. Refuse up
 * front, and say what is in it, because the way out is to delete it and that is
 * only safe if it is empty (SECURITY.md M-10).
 *
 * Four earlier shapes are recognised: before multi-user (uploads have no
 * `user_id`), before email verification (users have no `email_verified_at`),
 * before document titles (documents have no `title`), and before structured
 * extraction (fields have no `group_no`, doctors no `license_code`, or the search index no `body`).
 */
function refuseOutdatedDatabase(db: Database.Database, location: string): void {
  const columnsOf = (table: string) =>
    (db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as Array<{ name: string }>).map(
      column => column.name,
    );

  const uploads = columnsOf('source_files');
  const users = columnsOf('users');
  const documentColumns = columnsOf('documents');
  const fieldColumns = columnsOf('extracted_fields');
  const doctorColumns = columnsOf('doctors');
  const searchColumns = columnsOf('documents_fts');

  const beforeMultiUser = uploads.length > 0 && !uploads.includes('user_id');
  const beforeVerification = users.length > 0 && !users.includes('email_verified_at');
  const beforeTitles = documentColumns.length > 0 && !documentColumns.includes('title');
  const beforeStructure =
    (fieldColumns.length > 0 && !fieldColumns.includes('group_no')) ||
    (doctorColumns.length > 0 && !doctorColumns.includes('license_code')) ||
    (searchColumns.length > 0 && !searchColumns.includes('body'));
  if (!beforeMultiUser && !beforeVerification && !beforeTitles && !beforeStructure) return;

  const count = (table: string): number =>
    uploads.length === 0 && table === 'source_files'
      ? 0
      : (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  const documents = (db.prepare(`SELECT COUNT(*) AS n FROM documents`).get() as { n: number }).n;
  const held = `${count('source_files')} uploads and ${documents} documents`;

  throw new Error(
    `${location} was made by an earlier version of Spine and cannot be upgraded in place ` +
      `(it holds ${held}).\n` +
      (count('source_files') === 0 && documents === 0
        ? 'It is empty, so it is safe to delete: remove the spine.db, spine.db-wal and spine.db-shm files and restart.'
        : 'It holds records. Do NOT delete it until they are exported or no longer needed — ' +
          'upgrading a populated database needs a migration runner, which does not exist yet.'),
  );
}

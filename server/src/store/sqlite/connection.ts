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
  addColumnsInPlace(db);

  // Idempotent `CREATE TABLE IF NOT EXISTS`, re-applied every boot. The file
  // sits beside this adapter because it is SQLite-specific DDL; `npm run build`
  // copies it next to the compiled output.
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

  return db;
}

const columnsOf = (db: Database.Database, table: string): string[] =>
  (db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as Array<{ name: string }>).map(column => column.name);

/**
 * The one kind of change that needs no emptying: a new column with a default. Each step here is
 * idempotent and lists what it adds, so a database from before it is brought forward on open and
 * a new one (made whole by schema.sql) is left alone. Anything that is not additive still has to
 * be refused by `refuseOutdatedDatabase`.
 *
 *  - `pages.source_page`: where a page is in its file, separate from where it sits in the upload. Filled from `page_number`, which
 *    was always that until pages could be moved.
 *  - `documents.language`, `share_links.language`: the language a document is written in, and the one a share page starts in.
 *    Both may be null, so existing rows need nothing filled in.
 *  - `share_links.include_scans`: whether a link also shows the page images. Nothing names it but the queries.
 *  - `pages.hidden`: pages the owner has set aside. The search view and one trigger name the column,
 *    and `CREATE ... IF NOT EXISTS` would keep the old versions, so they are dropped here and
 *    schema.sql, which runs next, makes them again.
 */
function addColumnsInPlace(db: Database.Database): void {
  const pages = columnsOf(db, 'pages');
  if (pages.length > 0 && !pages.includes('hidden')) {
    db.transaction(() => {
      db.exec('ALTER TABLE pages ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0');
      db.exec('DROP VIEW IF EXISTS document_search_source');
      db.exec('DROP TRIGGER IF EXISTS pages_fts_update');
    })();
  }

  // The index of a page in its file, kept apart from its place in the upload so pages can be moved: the
  // parser, the sidecar and the stamp reader all count pages of the file. Every page was in file order until now.
  if (pages.length > 0 && !pages.includes('source_page')) {
    db.transaction(() => {
      db.exec('ALTER TABLE pages ADD COLUMN source_page INTEGER NOT NULL DEFAULT 0');
      db.exec('UPDATE pages SET source_page = page_number');
    })();
  }

  const links = columnsOf(db, 'share_links');
  if (links.length > 0 && !links.includes('include_scans')) {
    db.exec('ALTER TABLE share_links ADD COLUMN include_scans INTEGER NOT NULL DEFAULT 0');
  }
  if (links.length > 0 && !links.includes('language')) db.exec('ALTER TABLE share_links ADD COLUMN language TEXT');

  const documents = columnsOf(db, 'documents');
  if (documents.length > 0 && !documents.includes('language')) db.exec('ALTER TABLE documents ADD COLUMN language TEXT');
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
 * extraction (fields have no `group_no`, doctors no `license_code`, the search index no `body`, or doctor links no `source`).
 */
function refuseOutdatedDatabase(db: Database.Database, location: string): void {
  const uploads = columnsOf(db, 'source_files');
  const users = columnsOf(db, 'users');
  const documentColumns = columnsOf(db, 'documents');
  const fieldColumns = columnsOf(db, 'extracted_fields');
  const doctorColumns = columnsOf(db, 'doctors');
  const searchColumns = columnsOf(db, 'documents_fts');
  const linkColumns = columnsOf(db, 'document_doctors');

  const beforeMultiUser = uploads.length > 0 && !uploads.includes('user_id');
  const beforeVerification = users.length > 0 && !users.includes('email_verified_at');
  const beforeTitles = documentColumns.length > 0 && !documentColumns.includes('title');
  const beforeStructure =
    (fieldColumns.length > 0 && !fieldColumns.includes('group_no')) ||
    (doctorColumns.length > 0 && !doctorColumns.includes('license_code')) ||
    (searchColumns.length > 0 && !searchColumns.includes('body')) ||
    (linkColumns.length > 0 && !linkColumns.includes('source'));
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

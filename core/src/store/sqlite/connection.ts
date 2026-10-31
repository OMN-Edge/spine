import type { Database, OpenDatabase } from './driver.js';
import { accountsSchema } from './schema-accounts.js';
import { recordsSchema } from './schema-records.js';

/**
 * Opening the database, applying the idempotent schema, and setting pragmas.
 * Moved here from `db/index.ts` so that every SQLite-specific detail lives
 * inside the adapter.
 */
export function openDatabase(location: string, open: OpenDatabase, schema: string | undefined, scope: 'full' | 'accounts'): Database {
  const db = open(location);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  refuseOutdatedDatabase(db, location);
  addColumnsInPlace(db);

  // Idempotent `CREATE TABLE IF NOT EXISTS`, re-applied every boot. The text is SQLite-specific DDL and sits beside this adapter.
  db.exec(schema ?? schemaOf(scope));

  return db;
}

/** The accounts' tables, then (unless the scope is only accounts) the records'. */
function schemaOf(scope: 'full' | 'accounts'): string {
  return scope === 'accounts' ? accountsSchema : `${accountsSchema}\n${recordsSchema}`;
}

const columnsOf = (db: Database, table: string): string[] =>
  (db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as Array<{ name: string }>).map(column => column.name);

/**
 * The one kind of change that needs no emptying: a new column with a default. Each step here is
 * idempotent and lists what it adds, so a database from before it is brought forward on open and
 * a new one (made whole by the schema files) is left alone. Anything that is not additive still has to
 * be refused by `refuseOutdatedDatabase`.
 *
 *  - `pages.source_page`: where a page is in its file, separate from where it sits in the upload. Filled from `page_number`, which
 *    was always that until pages could be moved.
 *  - `documents.language`, `share_links.language`: the language a document is written in, and the one a share page starts in.
 *    Both may be null, so existing rows need nothing filled in.
 *  - `share_links.include_scans`: whether a link also shows the page images. Nothing names it but the queries.
 *  - `share_links.require_approval`: whether a visitor's browser must be approved by the owner. Off for every earlier link.
 *  - `share_links.allow_chat`: whether the recipient may ask questions about what the link shares. Off for every earlier link.
 *  - `document_doctors.printed_code`: the code a document printed for a doctor, kept so a clash with the directory's can be asked about. Null for earlier links.
 *  - `source_files.chat_conversation_id`: the conversation a file was attached in. Null for every earlier upload.
 *  - `chat_conversations.unread`/`origin`, `chat_messages.kind`/`data`: conversations the app starts when an upload finishes, and the notice in them. Nothing earlier has them.
 *  - `documents.owner_edited`, `extracted_fields.owner_edited`, `measurements.owner_edited`, `source_files.grouping_confirmed`: what the
 *    owner changed (kept through a re-reading) and whether an upload's grouping has been confirmed (every earlier upload counts as confirmed).
 *  - `source_files.photo_set`: an upload made of several photos bundled into one PDF, which a model reads. Earlier uploads are not.
 *  - `documents.needs_reading`: a document whose fields have not been read yet because its upload's grouping is not confirmed. Earlier documents were read.
 *  - `pages.hidden`: pages the owner has set aside. The search view and one trigger name the column,
 *    and `CREATE ... IF NOT EXISTS` would keep the old versions, so they are dropped here and
 *    the schema, which runs next, makes them again.
 */
function addColumnsInPlace(db: Database): void {
  // A passkey that opens the vault holds the account key sealed under a key its PRF output makes; the server cannot open it.
  const passkeys = columnsOf(db, 'user_passkeys');
  if (passkeys.length > 0 && !passkeys.includes('wrapped_key')) db.exec('ALTER TABLE user_passkeys ADD COLUMN wrapped_key TEXT');

  const pages = columnsOf(db, 'pages');
  if (pages.length > 0 && !pages.includes('hidden')) {
    db.transaction(() => {
      db.exec('ALTER TABLE pages ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0');
      db.exec('DROP VIEW IF EXISTS document_search_source');
      db.exec('DROP TRIGGER IF EXISTS pages_fts_update');
    })();
  }

  // How far the owner has turned the page image. Every earlier page is as its file has it.
  if (pages.length > 0 && !pages.includes('rotation')) db.exec('ALTER TABLE pages ADD COLUMN rotation INTEGER NOT NULL DEFAULT 0');

  // The index of a page in its file, kept apart from its place in the upload so pages can be moved: the
  // parser, the sidecar and the stamp reader all count pages of the file. Every page was in file order until now.
  if (pages.length > 0 && !pages.includes('source_page')) {
    db.transaction(() => {
      db.exec('ALTER TABLE pages ADD COLUMN source_page INTEGER NOT NULL DEFAULT 0');
      db.exec('UPDATE pages SET source_page = page_number');
    })();
  }

  // Consent and acceptance, recorded with the version shown. Accounts from before are asked at their next sign-in.
  const accounts = columnsOf(db, 'users');
  for (const column of ['health_consent_at', 'health_consent_version', 'terms_accepted_at', 'terms_version']) {
    if (accounts.length > 0 && !accounts.includes(column)) db.exec(`ALTER TABLE users ADD COLUMN ${column} TEXT`);
  }

  // Whether the administrator has approved the account (SPINE_REGISTRATION=approval). Every account from before is.
  if (accounts.length > 0 && !accounts.includes('approved')) db.exec('ALTER TABLE users ADD COLUMN approved INTEGER NOT NULL DEFAULT 1');

  const links = columnsOf(db, 'share_links');
  if (links.length > 0 && !links.includes('include_scans')) {
    db.exec('ALTER TABLE share_links ADD COLUMN include_scans INTEGER NOT NULL DEFAULT 0');
  }
  if (links.length > 0 && !links.includes('language')) db.exec('ALTER TABLE share_links ADD COLUMN language TEXT');
  if (links.length > 0 && !links.includes('allow_chat')) db.exec('ALTER TABLE share_links ADD COLUMN allow_chat INTEGER NOT NULL DEFAULT 0');
  if (links.length > 0 && !links.includes('require_approval')) db.exec('ALTER TABLE share_links ADD COLUMN require_approval INTEGER NOT NULL DEFAULT 0');

  // Where a read came from and which document it opened, for the owner's view of who read a link (FR-SHR-04). Earlier rows have neither.
  const accessLog = columnsOf(db, 'share_link_access_log');
  if (accessLog.length > 0 && !accessLog.includes('country')) db.exec('ALTER TABLE share_link_access_log ADD COLUMN country TEXT');
  if (accessLog.length > 0 && !accessLog.includes('document_id')) db.exec('ALTER TABLE share_link_access_log ADD COLUMN document_id TEXT');

  const documents = columnsOf(db, 'documents');
  if (documents.length > 0 && !documents.includes('language')) db.exec('ALTER TABLE documents ADD COLUMN language TEXT');
  // What the owner edited stays through a re-reading, and an upload's grouping waits for the owner to confirm it. Existing
  // rows get the defaults: nothing edited, and every earlier upload confirmed.
  if (documents.length > 0 && !documents.includes('owner_edited')) db.exec("ALTER TABLE documents ADD COLUMN owner_edited TEXT NOT NULL DEFAULT ''");
  // Reading a document waits for the grouping to be confirmed; every earlier document was read when it was made.
  if (documents.length > 0 && !documents.includes('needs_reading')) db.exec('ALTER TABLE documents ADD COLUMN needs_reading INTEGER NOT NULL DEFAULT 0');
  for (const table of ['extracted_fields', 'measurements']) {
    const columns = columnsOf(db, table);
    if (columns.length > 0 && !columns.includes('owner_edited')) db.exec(`ALTER TABLE ${table} ADD COLUMN owner_edited INTEGER NOT NULL DEFAULT 0`);
  }
  // Conversations the app starts (an upload finished) and the notices in them.
  const conversations = columnsOf(db, 'chat_conversations');
  if (conversations.length > 0 && !conversations.includes('unread')) db.exec('ALTER TABLE chat_conversations ADD COLUMN unread INTEGER NOT NULL DEFAULT 0');
  if (conversations.length > 0 && !conversations.includes('origin')) db.exec('ALTER TABLE chat_conversations ADD COLUMN origin TEXT');
  const chatMessages = columnsOf(db, 'chat_messages');
  if (chatMessages.length > 0 && !chatMessages.includes('kind')) db.exec('ALTER TABLE chat_messages ADD COLUMN kind TEXT');
  if (chatMessages.length > 0 && !chatMessages.includes('data')) db.exec('ALTER TABLE chat_messages ADD COLUMN data TEXT');
  const doctorLinks = columnsOf(db, 'document_doctors');
  if (doctorLinks.length > 0 && !doctorLinks.includes('printed_code')) db.exec('ALTER TABLE document_doctors ADD COLUMN printed_code TEXT');
  const uploads = columnsOf(db, 'source_files');
  if (uploads.length > 0 && !uploads.includes('chat_conversation_id')) db.exec('ALTER TABLE source_files ADD COLUMN chat_conversation_id TEXT');
  if (uploads.length > 0 && !uploads.includes('photo_set')) db.exec('ALTER TABLE source_files ADD COLUMN photo_set INTEGER NOT NULL DEFAULT 0');
  // Sample records are told apart from real ones so they can be removed together. Every earlier upload is real.
  if (uploads.length > 0 && !uploads.includes('sample')) db.exec('ALTER TABLE source_files ADD COLUMN sample INTEGER NOT NULL DEFAULT 0');
  // How many unprocessed photos an upload keeps beside its PDF (a scan session). Earlier uploads keep none.
  if (uploads.length > 0 && !uploads.includes('raw_count')) db.exec('ALTER TABLE source_files ADD COLUMN raw_count INTEGER NOT NULL DEFAULT 0');
  // Told apart from an upload read by the pipeline, so one interrupted by a reload is read again and a restore is not. Every earlier upload was read.
  if (uploads.length > 0 && !uploads.includes('from_export')) db.exec('ALTER TABLE source_files ADD COLUMN from_export INTEGER NOT NULL DEFAULT 0');
  if (uploads.length > 0 && !uploads.includes('grouping_confirmed')) db.exec('ALTER TABLE source_files ADD COLUMN grouping_confirmed INTEGER NOT NULL DEFAULT 1');
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
function refuseOutdatedDatabase(db: Database, location: string): void {
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

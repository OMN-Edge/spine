import type { Database } from './driver.js';
import type { Cell, ChangeLog } from '../types.js';
import { createChangeLog, REPLICATED, type Clash, type Note, type Rows, type Stamp } from '../sync.js';

/**
 * SQLite's part of syncing devices (the rules are in `../sync.ts`): every write to a records table is noted as a change of one row by a
 * trigger (`_log`), the clocks and the aliases are tables of the database (`_clock`, `_alias`), and a merge runs with the foreign keys
 * off, because changes arrive in any order. The form of a change names tables and columns, never the engine's pages, so a store that is
 * not SQLite can read and write the same changes.
 *
 * A row's clock is `_clock` (when it was last written, and when its columns were written, if not all together: `b`) and `_colclock` (the
 * columns written since, one row each). An update notes the row before it as well as after (`_log.o`), which is how the columns it changed are known.
 *
 * Two things in the schema would make devices collide and are handled by the rules. A key that was the engine's own counter (tags, the
 * share log) is a random number now (`../ids.ts`). Two devices that each make the same tag or doctor get different keys for one name.
 */

/** A change to these tables can alter what a document's search text says. */
const SEARCH = new Set(['documents', 'pages', 'extracted_fields', 'measurements', 'document_doctors', 'doctors']);

interface Column { name: string; type: string; pk: number }
interface Meta { table: string; columns: Column[]; pk: string[]; blob: Set<string>; fks: Array<{ from: string; table: string; to: string }> }

const hexOf = (s: string) => Uint8Array.from(s.match(/../g) ?? [], h => parseInt(h, 16));
const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;
const parse = (text: string) => JSON.parse(text) as Record<string, Cell>;

function install(db: Database): Map<string, Meta> {
  db.exec("CREATE TABLE IF NOT EXISTS _log (n INTEGER PRIMARY KEY AUTOINCREMENT, t TEXT NOT NULL, k TEXT NOT NULL, r TEXT, at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')), o TEXT)");
  db.exec('CREATE TABLE IF NOT EXISTS _clock (t TEXT NOT NULL, k TEXT NOT NULL, h TEXT NOT NULL, b TEXT, PRIMARY KEY (t, k))');
  db.exec('CREATE TABLE IF NOT EXISTS _colclock (t TEXT NOT NULL, k TEXT NOT NULL, c TEXT NOT NULL, h TEXT NOT NULL, PRIMARY KEY (t, k, c))');
  // A database made before columns were stamped (the form a device's own never has, since it is rebuilt at each start, but a file one can).
  if (!(db.prepare("SELECT 1 FROM pragma_table_info('_log') WHERE name = 'o'").get())) db.exec('ALTER TABLE _log ADD COLUMN o TEXT');
  if (!(db.prepare("SELECT 1 FROM pragma_table_info('_clock') WHERE name = 'b'").get())) db.exec('ALTER TABLE _clock ADD COLUMN b TEXT');
  db.exec('CREATE TABLE IF NOT EXISTS _alias (t TEXT NOT NULL, incoming TEXT NOT NULL, local TEXT NOT NULL, PRIMARY KEY (t, incoming))');
  const metas = new Map<string, Meta>();
  for (const table of REPLICATED) {
    const columns = db.prepare(`SELECT name, type, pk FROM pragma_table_info('${table}')`).all() as Column[];
    if (columns.length === 0) continue;
    const pk = columns.filter(c => c.pk > 0).sort((a, b) => a.pk - b.pk).map(c => c.name);
    const fks = (db.prepare(`SELECT "from", "table", "to" FROM pragma_foreign_key_list('${table}')`).all() as Array<{ from: string; table: string; to: string }>);
    metas.set(table, { table, columns, pk, blob: new Set(columns.filter(c => c.type.toUpperCase() === 'BLOB').map(c => c.name)), fks });
    const row = (p: string) => `json_object(${columns.map(c => `'${c.name}', ${c.type.toUpperCase() === 'BLOB' ? `hex(${p}${quote(c.name)})` : `${p}${quote(c.name)}`}`).join(', ')})`;
    const key = (p: string) => `json_object(${pk.map(c => `'${c}', ${p}${quote(c)}`).join(', ')})`;
    for (const op of ['i', 'u', 'd']) db.exec(`DROP TRIGGER IF EXISTS _log_${table}_${op}`);
    db.exec(`CREATE TRIGGER _log_${table}_i AFTER INSERT ON ${table} BEGIN INSERT INTO _log (t, k, r) VALUES ('${table}', ${key('new.')}, ${row('new.')}); END`);
    db.exec(`CREATE TRIGGER _log_${table}_u AFTER UPDATE ON ${table} BEGIN
      INSERT INTO _log (t, k, r) SELECT '${table}', ${key('old.')}, NULL WHERE ${key('old.')} <> ${key('new.')};
      INSERT INTO _log (t, k, r, o) VALUES ('${table}', ${key('new.')}, ${row('new.')}, CASE WHEN ${key('old.')} = ${key('new.')} THEN ${row('old.')} END);
    END`);
    db.exec(`CREATE TRIGGER _log_${table}_d AFTER DELETE ON ${table} BEGIN INSERT INTO _log (t, k, r) VALUES ('${table}', ${key('old.')}, NULL); END`);
  }
  return metas;
}

/** The rules' view of a SQLite database. */
function sqliteRows(db: Database): Rows {
  const metas = install(db);
  const meta = (table: string) => {
    const m = metas.get(table);
    if (!m) throw new Error(`${table} is not a synced table`);
    return m;
  };
  const pending = db.prepare('SELECT COUNT(*) AS n FROM _log');
  const getClock = db.prepare('SELECT h, b FROM _clock WHERE t = ? AND k = ?');
  const getColumns = db.prepare('SELECT c, h FROM _colclock WHERE t = ? AND k = ?');
  const setClock = db.prepare('INSERT INTO _clock (t, k, h, b) VALUES (?, ?, ?, ?) ON CONFLICT (t, k) DO UPDATE SET h = excluded.h, b = excluded.b');
  const dropColumns = db.prepare('DELETE FROM _colclock WHERE t = ? AND k = ?');
  const setColumn = db.prepare('INSERT INTO _colclock (t, k, c, h) VALUES (?, ?, ?, ?)');
  const aliasOf = db.prepare('SELECT local FROM _alias WHERE t = ? AND incoming = ?');
  const addAlias = db.prepare('INSERT OR REPLACE INTO _alias (t, incoming, local) VALUES (?, ?, ?)');
  const upserts = new Map<string, ReturnType<Database['prepare']>>();

  /** With the checks off while changes arrive in any order, a row can point at one that never came or was deleted; those go. */
  function sweep(): void {
    for (let round = 0; round < 6; round++) {
      let removed = 0;
      for (const m of metas.values()) {
        for (const fk of m.fks) {
          if (!metas.has(fk.table)) continue;
          removed += db.prepare(`DELETE FROM ${m.table} WHERE ${quote(fk.from)} IS NOT NULL AND ${quote(fk.from)} NOT IN (SELECT ${quote(fk.to)} FROM ${fk.table})`).run().changes;
        }
      }
      if (removed === 0) return;
    }
  }

  /**
   * The triggers that keep the search index in step, set aside while a merge writes: each insert of a field or a result rebuilds its document's
   * whole row of the index, so applying a vault's worth of changes through them took time that grew faster than the records (about 24 seconds
   * for 600 documents) and the index was rebuilt in full at the end all the same. Dropped and made again inside the merge's transaction, so a
   * failed merge puts them back with everything else.
   */
  function setAsideSearchTriggers(): string[] {
    const found = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND sql LIKE '%documents_fts%'").all() as Array<{ name: string; sql: string }>;
    for (const trigger of found) db.exec(`DROP TRIGGER IF EXISTS ${quote(trigger.name)}`);
    return found.map(trigger => trigger.sql);
  }

  function rebuildSearch(): void {
    db.exec('DELETE FROM documents_fts');
    db.exec('INSERT INTO documents_fts (rowid, title, doc_type, provider, ai_summary, user_notes, body) SELECT id, title, doc_type, provider, ai_summary, user_notes, body FROM document_search_source');
  }

  const where = (columns: string[]) => columns.map(c => `${quote(c)} = ?`).join(' AND ');

  return {
    tables: () => [...metas.keys()],
    inTransaction: () => db.inTransaction,

    notes() {
      const found = db.prepare('SELECT t, k, r, at, o FROM _log ORDER BY n').all() as Array<{ t: string; k: string; r: string | null; at: string; o: string | null }>;
      return found.map((row): Note => ({
        t: row.t, k: parse(row.k), r: row.r === null ? null : parse(row.r), at: Date.parse(`${row.at.replace(' ', 'T')}Z`) || Date.now(),
        ...(row.o === null ? {} : { o: parse(row.o) }),
      }));
    },
    hasNotes: () => (pending.get() as { n: number }).n > 0,
    clearNotes() { db.exec('DELETE FROM _log'); },

    stamp(table, key): Stamp | undefined {
      const found = getClock.get(table, key) as { h: string; b: string | null } | undefined;
      if (!found) return undefined;
      if (found.b === null) return { h: found.h };
      return { h: found.h, b: found.b, cols: Object.fromEntries((getColumns.all(table, key) as Array<{ c: string; h: string }>).map(x => [x.c, x.h])) };
    },
    setStamp(table, key, stamp) {
      setClock.run(table, key, stamp.h, stamp.b ?? null);
      dropColumns.run(table, key);
      if (stamp.b !== undefined) for (const [column, h] of Object.entries(stamp.cols ?? {})) setColumn.run(table, key, column, h);
    },
    stamps() {
      const columns = new Map<string, Record<string, string>>();
      for (const x of db.prepare('SELECT t, k, c, h FROM _colclock').all() as Array<{ t: string; k: string; c: string; h: string }>) {
        const id = `${x.t}|${x.k}`;
        columns.set(id, { ...columns.get(id), [x.c]: x.h });
      }
      return (db.prepare('SELECT t, k, h, b FROM _clock').all() as Array<{ t: string; k: string; h: string; b: string | null }>)
        .map(x => ({ t: x.t, k: x.k, stamp: x.b === null ? { h: x.h } : { h: x.h, b: x.b, cols: columns.get(`${x.t}|${x.k}`) ?? {} } }));
    },
    exists(table, key) {
      const m = meta(table);
      return db.prepare(`SELECT 1 FROM ${table} WHERE ${where(m.pk)}`).get(...m.pk.map(c => key[c])) !== undefined;
    },
    alias: (table, incoming) => (aliasOf.get(table, incoming) as { local: string } | undefined)?.local,
    addAlias(table, incoming, local) { addAlias.run(table, incoming, local); },

    write(table, row): Clash | null {
      const m = meta(table);
      const columns = m.columns.map(c => c.name).filter(name => name in row);
      // Some of the columns of a row that is here (a merge of the columns another device changed): an update, since an insert would need them all.
      const partial = columns.length < m.columns.length && db.prepare(`SELECT 1 FROM ${table} WHERE ${where(m.pk)}`).get(...m.pk.map(c => row[c])) !== undefined;
      const sql = `${table}|${partial ? 'set' : 'put'}|${columns.join(',')}`;
      let statement = upserts.get(sql);
      if (!statement && partial) {
        const sets = columns.filter(c => !m.pk.includes(c));
        statement = db.prepare(`UPDATE ${table} SET ${sets.length ? sets.map(c => `${quote(c)} = ?`).join(', ') : `${quote(m.pk[0]!)} = ${quote(m.pk[0]!)}`} WHERE ${where(m.pk)}`);
        upserts.set(sql, statement);
      } else if (!statement) {
        const updates = columns.filter(c => !m.pk.includes(c)).map(c => `${quote(c)} = excluded.${quote(c)}`);
        statement = db.prepare(`INSERT INTO ${table} (${columns.map(quote).join(', ')}) VALUES (${columns.map(() => '?').join(', ')}) ON CONFLICT (${m.pk.map(quote).join(', ')}) DO ${updates.length ? `UPDATE SET ${updates.join(', ')}` : 'NOTHING'}`);
        upserts.set(sql, statement);
      }
      const cell = (c: string) => (m.blob.has(c) && typeof row[c] === 'string' ? hexOf(row[c] as string) : row[c]);
      const values = partial ? [...columns.filter(c => !m.pk.includes(c)).map(cell), ...m.pk.map(cell)] : columns.map(cell);
      try {
        statement.run(...values);
        return null;
      } catch (err) {
        const named = /UNIQUE constraint failed: (.+)$/.exec(String((err as Error)?.message ?? ''))?.[1];
        if (!named) throw err;
        return { columns: named.split(',').map(c => c.trim().split('.').pop()!) };
      }
    },

    remove(table, key) {
      const m = meta(table);
      db.prepare(`DELETE FROM ${table} WHERE ${where(m.pk)}`).run(...m.pk.map(c => key[c]));
    },

    holders(table, columns, values, except) {
      const m = meta(table);
      const select = `SELECT ${m.pk.map(quote).join(', ')} FROM ${table} WHERE ${where(columns)}`;
      if (!except) return db.prepare(select).all(...values) as Array<Record<string, Cell>>;
      return db.prepare(`${select} AND NOT (${where(m.pk)})`).all(...values, ...m.pk.map(c => except[c])) as Array<Record<string, Cell>>;
    },

    removeAll(table, keys) {
      const m = meta(table);
      const statement = db.prepare(`DELETE FROM ${table} WHERE ${where(m.pk)}`);
      for (const key of keys) statement.run(...m.pk.map(c => key[c]));
    },

    every(table) {
      const m = meta(table);
      const row = `json_object(${m.columns.map(c => `'${c.name}', ${c.type.toUpperCase() === 'BLOB' ? `hex(${quote(c.name)})` : quote(c.name)}`).join(', ')})`;
      const key = `json_object(${m.pk.map(c => `'${c}', ${quote(c)}`).join(', ')})`;
      return (db.prepare(`SELECT ${key} AS k, ${row} AS r FROM ${table}`).all() as Array<{ k: string; r: string }>).map(found => ({ k: parse(found.k), r: parse(found.r) }));
    },

    atomic<T>(fn: () => T): T {
      db.exec('BEGIN');
      try {
        const result = fn();
        db.exec('COMMIT');
        return result;
      } catch (err) { db.exec('ROLLBACK'); throw err; }
    },

    merging(fn) {
      db.pragma('foreign_keys = OFF');
      db.exec('BEGIN');
      try {
        const mark = (db.prepare('SELECT COALESCE(MAX(n), 0) AS n FROM _log').get() as { n: number }).n;
        const triggers = setAsideSearchTriggers();
        const touched = fn();
        sweep();
        db.prepare('DELETE FROM _log WHERE n > ?').run(mark);
        if ([...touched].some(t => SEARCH.has(t))) rebuildSearch();
        for (const sql of triggers) db.exec(sql);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      } finally {
        db.pragma('foreign_keys = ON');
      }
    },
  };
}

const logs = new WeakMap<Database, ChangeLog>();

/** One change log per database: it holds the device's clock. */
export function changeLog(db: Database): ChangeLog {
  const cached = logs.get(db);
  if (cached) return cached;
  const made = createChangeLog(sqliteRows(db));
  logs.set(db, made);
  return made;
}

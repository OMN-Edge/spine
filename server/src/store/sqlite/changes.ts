import type { Database } from './driver.js';
import type { Cell, Change, ChangeLog } from '../types.js';

/**
 * How records travel between devices (docs/crypto-design.md, "Syncing devices"). Every write to a records table is noted as a
 * change of one row (a trigger puts it in `_log`); `drain` turns the notes into stamped changes, which a device seals and
 * shares, and `apply` brings other devices' changes in. A row's newest change wins (a deletion is a change), so two devices
 * that edit different rows both keep their edits and two that edit the same row agree on the later one. The form of a change names tables
 * and columns, never the engine's pages, so a store that is not SQLite can read and write the same changes.
 *
 * Two things in the schema would make devices collide and are handled here. A key that was the engine's own counter (tags, the
 * share log) is a random number now (`ids.ts`). Two devices that each make the same tag or doctor get different keys for one
 * name: the second to arrive is remembered as another name for the first (`_alias`), and the rows that point at it are redirected.
 */

/** The tables that hold the person's records, which are synced. The accounts tables, the search index and the engine's own are not. */
export const REPLICATED = [
  'source_files', 'regroup_plans', 'pages', 'documents', 'measurements', 'removed_readings', 'measurement_aliases', 'doctors', 'document_doctors',
  'match_decisions', 'extracted_fields', 'tags', 'document_tags', 'share_links', 'share_link_keys', 'vault_files', 'share_access_requests', 'share_link_events', 'share_link_access_log',
  'document_translations', 'document_embeddings', 'episodes', 'episode_documents', 'document_links', 'chat_conversations', 'chat_messages',
] as const;

/** A change to these tables can alter what a document's search text says. */
const SEARCH = new Set(['documents', 'pages', 'extracted_fields', 'measurements', 'document_doctors', 'doctors']);

/** Rows that name another by a key two devices may have made differently for one thing: [column, the table whose key it is]. */
const ALIASED: Record<string, Array<[string, string]>> = {
  tags: [['id', 'tags']], document_tags: [['tag_id', 'tags']],
  doctors: [['id', 'doctors']], document_doctors: [['doctor_id', 'doctors']],
};

interface Column { name: string; type: string; pk: number }
interface Meta { table: string; columns: Column[]; pk: string[]; blob: Set<string>; fks: Array<{ from: string; table: string; to: string }> }
interface State { metas: Map<string, Meta>; device: string; wall: number; counter: number }

const states = new WeakMap<Database, State>();

const hexOf = (s: string) => Uint8Array.from(s.match(/../g) ?? [], h => parseInt(h, 16));
const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;
const norm = (k: Record<string, Cell>) => JSON.stringify(k);

function install(db: Database): State {
  const have = states.get(db);
  if (have) return have;
  db.exec("CREATE TABLE IF NOT EXISTS _log (n INTEGER PRIMARY KEY AUTOINCREMENT, t TEXT NOT NULL, k TEXT NOT NULL, r TEXT, at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')))");
  db.exec('CREATE TABLE IF NOT EXISTS _clock (t TEXT NOT NULL, k TEXT NOT NULL, h TEXT NOT NULL, PRIMARY KEY (t, k))');
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
      INSERT INTO _log (t, k, r) VALUES ('${table}', ${key('new.')}, ${row('new.')});
    END`);
    db.exec(`CREATE TRIGGER _log_${table}_d AFTER DELETE ON ${table} BEGIN INSERT INTO _log (t, k, r) VALUES ('${table}', ${key('old.')}, NULL); END`);
  }
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const state: State = { metas, device: Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(''), wall: 0, counter: 0 };
  states.set(db, state);
  return state;
}

/** Sorts as text: the time in milliseconds, a counter for changes in the same millisecond, and the device that made it. */
function stamp(state: State, at: number = Date.now()): string {
  const now = at;
  if (now > state.wall) { state.wall = now; state.counter = 0; } else state.counter++;
  return `${String(state.wall).padStart(14, '0')}.${String(state.counter).padStart(5, '0')}.${state.device}`;
}

/** A change from elsewhere moves this clock forward, so what is written here next is later than anything seen. */
function observe(state: State, h: string) {
  const m = h.match(/^(\d{14})\.(\d{5})\./);
  if (!m) return;
  const wall = Number(m[1]);
  const counter = Number(m[2]);
  if (wall > state.wall) { state.wall = wall; state.counter = counter; } else if (wall === state.wall && counter > state.counter) state.counter = counter;
}

const parse = (text: string) => JSON.parse(text) as Record<string, Cell>;

const logs = new WeakMap<Database, ChangeLog>();

export function changeLog(db: Database): ChangeLog {
  const cached = logs.get(db);
  if (cached) return cached;
  const made = build(db);
  logs.set(db, made);
  return made;
}

function build(db: Database): ChangeLog {
  const state = install(db);
  const pending = db.prepare('SELECT COUNT(*) AS n FROM _log');
  const getClock = db.prepare('SELECT h FROM _clock WHERE t = ? AND k = ?');
  const setClock = db.prepare('INSERT INTO _clock (t, k, h) VALUES (?, ?, ?) ON CONFLICT (t, k) DO UPDATE SET h = excluded.h');
  const aliasOf = db.prepare('SELECT local FROM _alias WHERE t = ? AND incoming = ?');
  const addAlias = db.prepare('INSERT OR REPLACE INTO _alias (t, incoming, local) VALUES (?, ?, ?)');
  const upserts = new Map<string, ReturnType<Database['prepare']>>();

  function translate(c: Change): Change {
    const columns = ALIASED[c.t];
    if (!columns) return c;
    const out: Change = { ...c, k: { ...c.k }, r: c.r && { ...c.r } };
    for (const [column, table] of columns) {
      for (const target of [out.k, out.r]) {
        const value = target?.[column];
        if (value === null || value === undefined) continue;
        const row = aliasOf.get(table, String(value)) as { local: string } | undefined;
        if (row) target![column] = typeof value === 'number' ? Number(row.local) : row.local;
      }
    }
    return out;
  }

  function put(meta: Meta, change: Change): void {
    const row = change.r!;
    const columns = meta.columns.map(c => c.name).filter(name => name in row);
    const sql = `${meta.table}|${columns.join(',')}`;
    let statement = upserts.get(sql);
    if (!statement) {
      const updates = columns.filter(c => !meta.pk.includes(c)).map(c => `${quote(c)} = excluded.${quote(c)}`);
      statement = db.prepare(`INSERT INTO ${meta.table} (${columns.map(quote).join(', ')}) VALUES (${columns.map(() => '?').join(', ')}) ON CONFLICT (${meta.pk.map(quote).join(', ')}) DO ${updates.length ? `UPDATE SET ${updates.join(', ')}` : 'NOTHING'}`);
      upserts.set(sql, statement);
    }
    const values = columns.map(c => (meta.blob.has(c) && typeof row[c] === 'string' ? hexOf(row[c] as string) : row[c]));
    try {
      statement.run(...values);
    } catch (err) {
      const named = /UNIQUE constraint failed: (.+)$/.exec(String((err as Error)?.message ?? ''))?.[1];
      if (!named) throw err;
      const unique = named.split(',').map(c => c.trim().split('.').pop()!);
      const same = unique.map(c => `${quote(c)} = ?`).join(' AND ');
      const sameValues = unique.map(c => row[c]);
      if (ALIASED[meta.table]?.some(([column]) => column === 'id') && meta.pk.length === 1) {
        // The same tag or doctor made on two devices: the one already here stays, and the other's key means it from now on.
        const existing = db.prepare(`SELECT ${quote(meta.pk[0])} AS id FROM ${meta.table} WHERE ${same}`).get(...sameValues) as { id: Cell } | undefined;
        if (existing) { addAlias.run(meta.table, String(row[meta.pk[0]]), String(existing.id)); return; }
      }
      // Anything else that must be unique (a page's place, a visitor's request): the newer change takes the place, so a row already here that was
      // written later keeps it and the incoming one is dropped, and every device ends with the same row whichever order the changes reach it.
      const notThis = meta.pk.map(c => `${quote(c)} = ?`).join(' AND ');
      const holders = db.prepare(`SELECT ${meta.pk.map(quote).join(', ')} FROM ${meta.table} WHERE ${same} AND NOT (${notThis})`).all(...sameValues, ...meta.pk.map(c => row[c])) as Array<Record<string, Cell>>;
      const later = holders.some(h => {
        const held = (getClock.get(meta.table, norm(Object.fromEntries(meta.pk.map(c => [c, h[c]])))) as { h: string } | undefined)?.h;
        return held !== undefined && held > change.h;
      });
      if (later) return;
      db.prepare(`DELETE FROM ${meta.table} WHERE ${same} AND NOT (${notThis})`).run(...sameValues, ...meta.pk.map(c => row[c]));
      statement.run(...values);
    }
  }

  function remove(meta: Meta, change: Change): void {
    db.prepare(`DELETE FROM ${meta.table} WHERE ${meta.pk.map(c => `${quote(c)} = ?`).join(' AND ')}`).run(...meta.pk.map(c => change.k[c]));
  }

  /** With the checks off while changes arrive in any order, a row can point at one that never came or was deleted; those go. */
  function sweep(): void {
    for (let round = 0; round < 6; round++) {
      let removed = 0;
      for (const meta of state.metas.values()) {
        for (const fk of meta.fks) {
          if (!state.metas.has(fk.table)) continue;
          removed += db.prepare(`DELETE FROM ${meta.table} WHERE ${quote(fk.from)} IS NOT NULL AND ${quote(fk.from)} NOT IN (SELECT ${quote(fk.to)} FROM ${fk.table})`).run().changes;
        }
      }
      if (removed === 0) return;
    }
  }

  function rebuildSearch(): void {
    db.exec('DELETE FROM documents_fts');
    db.exec('INSERT INTO documents_fts (rowid, title, doc_type, provider, ai_summary, user_notes, body) SELECT id, title, doc_type, provider, ai_summary, user_notes, body FROM document_search_source');
  }

  const waiting = () => (pending.get() as { n: number }).n > 0;

  return {
    async drain() {
      if (db.inTransaction) throw new Error('the change log cannot be drained inside a transaction');
      const rows = db.prepare('SELECT t, k, r, at FROM _log ORDER BY n').all() as Array<{ t: string; k: string; r: string | null; at: string }>;
      if (rows.length === 0) return [];
      const last = new Map<string, { t: string; k: Record<string, Cell>; r: Record<string, Cell> | null; at: number }>();
      for (const row of rows) {
        const k = parse(row.k);
        last.delete(`${row.t}|${norm(k)}`); // a row written twice is stamped when it was written last, after the rows written between
        last.set(`${row.t}|${norm(k)}`, { t: row.t, k, r: row.r === null ? null : parse(row.r), at: Date.parse(`${row.at.replace(' ', 'T')}Z`) || Date.now() });
      }
      const changes: Change[] = [];
      db.exec('BEGIN');
      try {
        for (const entry of last.values()) {
          const h = stamp(state, entry.at);
          changes.push({ t: entry.t, k: entry.k, r: entry.r, h });
          setClock.run(entry.t, norm(entry.k), h);
        }
        db.exec('DELETE FROM _log');
        db.exec('COMMIT');
      } catch (err) { db.exec('ROLLBACK'); throw err; }
      return changes;
    },

    async apply(changes) {
      if (db.inTransaction) throw new Error('changes cannot be applied inside a transaction');
      if (changes.length === 0) return 0;
      if (waiting()) throw new Error('drain the change log before applying changes from elsewhere');
      const ordered = [...changes].sort((a, b) => (a.h < b.h ? -1 : a.h > b.h ? 1 : 0));
      db.pragma('foreign_keys = OFF');
      db.exec('BEGIN');
      let applied = 0;
      let searchMoved = false;
      try {
        const mark = (db.prepare('SELECT COALESCE(MAX(n), 0) AS n FROM _log').get() as { n: number }).n;
        for (const incoming of ordered) {
          observe(state, incoming.h);
          const meta = state.metas.get(incoming.t);
          if (!meta) continue;
          const change = translate(incoming);
          const key = norm(change.k);
          const had = (getClock.get(change.t, key) as { h: string } | undefined)?.h;
          if (had !== undefined && had >= change.h) continue;
          if (change.r === null) remove(meta, change); else put(meta, change);
          setClock.run(change.t, key, change.h);
          applied++;
          if (SEARCH.has(change.t)) searchMoved = true;
        }
        sweep();
        db.prepare('DELETE FROM _log WHERE n > ?').run(mark);
        if (searchMoved) rebuildSearch();
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      } finally {
        db.pragma('foreign_keys = ON');
      }
      return applied;
    },

    async dump() {
      if (waiting()) throw new Error('drain the change log before taking a snapshot');
      const clocks = new Map<string, string>();
      for (const row of db.prepare('SELECT t, k, h FROM _clock').all() as Array<{ t: string; k: string; h: string }>) clocks.set(`${row.t}|${row.k}`, row.h);
      const out: Change[] = [];
      const seen = new Set<string>();
      for (const meta of state.metas.values()) {
        const row = `json_object(${meta.columns.map(c => `'${c.name}', ${c.type.toUpperCase() === 'BLOB' ? `hex(${quote(c.name)})` : quote(c.name)}`).join(', ')})`;
        const key = `json_object(${meta.pk.map(c => `'${c}', ${quote(c)}`).join(', ')})`;
        for (const found of db.prepare(`SELECT ${key} AS k, ${row} AS r FROM ${meta.table}`).all() as Array<{ k: string; r: string }>) {
          const k = parse(found.k);
          const id = `${meta.table}|${norm(k)}`;
          seen.add(id);
          out.push({ t: meta.table, k, r: parse(found.r), h: clocks.get(id) ?? '00000000000000.00000.00000000' });
        }
      }
      for (const [id, h] of clocks) {
        if (seen.has(id)) continue;
        const at = id.indexOf('|');
        out.push({ t: id.slice(0, at), k: parse(id.slice(at + 1)), r: null, h });
      }
      return out;
    },
  };
}

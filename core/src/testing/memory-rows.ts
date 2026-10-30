import type { Cell } from '../store/types.js';
import type { Clash, Note, Rows, Stamp } from '../store/sync.js';

type Row = Record<string, Cell>;

/** What a table needs to be synced: its key columns, and the sets of columns that must be unique. */
export interface TableSpec { key: string[]; unique?: string[][] }

/**
 * The rules of `store/sync.ts` over plain maps: a second supplier of `Rows`, there to show that the rules need nothing of SQLite, and to
 * run them without a database. A device is one of these plus `createChangeLog`; `set` and `del` are the application's writes and note
 * themselves, as a trigger does in SQLite.
 */
export class MemoryRows implements Rows {
  readonly data = new Map<string, Map<string, Row>>();
  private stampOf = new Map<string, Stamp>();
  private aliasOf = new Map<string, string>();
  private log: Note[] = [];
  private merged = false;
  private inside = false;

  constructor(private readonly specs: Record<string, TableSpec>, private readonly now: () => number = Date.now) {
    for (const t of Object.keys(specs)) this.data.set(t, new Map());
  }

  private keyOf(table: string, row: Row): Row {
    return Object.fromEntries(this.specs[table].key.map(c => [c, row[c]]));
  }

  private clashWith(table: string, row: Row): string[] | null {
    const mine = JSON.stringify(this.keyOf(table, row));
    for (const columns of this.specs[table].unique ?? []) {
      for (const [id, other] of this.data.get(table)!) {
        if (id !== mine && columns.every(c => other[c] === row[c])) return columns;
      }
    }
    return null;
  }

  /** The application's write. */
  set(table: string, row: Row): void {
    const clash = this.clashWith(table, row);
    if (clash) throw new Error(`UNIQUE constraint failed: ${clash.map(c => `${table}.${c}`).join(', ')}`);
    const id = JSON.stringify(this.keyOf(table, row));
    const before = this.data.get(table)!.get(id);
    this.data.get(table)!.set(id, { ...row });
    this.log.push({ t: table, k: this.keyOf(table, row), r: { ...row }, at: this.now(), ...(before ? { o: { ...before } } : {}) });
  }

  /** The application's delete. */
  del(table: string, key: Row): void {
    const k = Object.fromEntries(this.specs[table].key.map(c => [c, key[c]]));
    if (!this.data.get(table)!.delete(JSON.stringify(k))) return;
    this.log.push({ t: table, k, r: null, at: this.now() });
  }

  get(table: string, key: Row): Row | undefined {
    return this.data.get(table)!.get(JSON.stringify(Object.fromEntries(this.specs[table].key.map(c => [c, key[c]]))));
  }

  rowsOf(table: string): Row[] {
    return [...this.data.get(table)!.values()];
  }

  tables = () => Object.keys(this.specs);
  inTransaction = () => this.inside;

  notes = () => [...this.log];
  hasNotes = () => this.log.length > 0;
  clearNotes() { this.log = []; }

  stamp = (table: string, key: string) => this.stampOf.get(`${table}|${key}`);
  setStamp(table: string, key: string, stamp: Stamp) { this.stampOf.set(`${table}|${key}`, stamp); }
  stamps = () => [...this.stampOf].map(([id, stamp]) => ({ t: id.slice(0, id.indexOf('|')), k: id.slice(id.indexOf('|') + 1), stamp }));
  exists = (table: string, key: Row) => this.data.get(table)!.has(JSON.stringify(this.keyOf(table, key)));
  alias = (table: string, incoming: string) => this.aliasOf.get(`${table}|${incoming}`);
  addAlias(table: string, incoming: string, local: string) { this.aliasOf.set(`${table}|${incoming}`, local); }

  write(table: string, row: Row): Clash | null {
    const columns = this.clashWith(table, row);
    if (columns) return { columns };
    const id = JSON.stringify(this.keyOf(table, row));
    // Only the columns given are written, as in a database: the others stay as they are.
    this.data.get(table)!.set(id, { ...this.data.get(table)!.get(id), ...row });
    if (!this.merged) this.log.push({ t: table, k: this.keyOf(table, row), r: { ...row }, at: this.now() });
    return null;
  }

  remove(table: string, key: Row) {
    const k = this.keyOf(table, key);
    if (this.data.get(table)!.delete(JSON.stringify(k)) && !this.merged) this.log.push({ t: table, k, r: null, at: this.now() });
  }

  holders(table: string, columns: string[], values: Cell[], except: Row | null): Row[] {
    const skip = except ? JSON.stringify(this.keyOf(table, except)) : null;
    return [...this.data.get(table)!].filter(([id, r]) => id !== skip && columns.every((c, i) => r[c] === values[i])).map(([, r]) => this.keyOf(table, r));
  }

  removeAll(table: string, keys: Row[]) {
    for (const key of keys) this.remove(table, key);
  }

  every(table: string) {
    return this.rowsOf(table).map(r => ({ k: this.keyOf(table, r), r: { ...r } }));
  }

  atomic<T>(fn: () => T): T {
    const before = new Map([...this.data].map(([t, rows]) => [t, new Map(rows)]));
    const log = [...this.log];
    this.inside = true;
    try {
      return fn();
    } catch (err) {
      for (const [t, rows] of before) this.data.set(t, rows);
      this.log = log;
      throw err;
    } finally {
      this.inside = false;
    }
  }

  merging(fn: () => Set<string>) {
    this.merged = true;
    try {
      this.atomic(fn);
    } finally {
      this.merged = false;
    }
  }
}

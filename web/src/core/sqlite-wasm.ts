import sqlite3InitModule from '@sqlite.org/sqlite-wasm';

/**
 * A driver for the store (core/src/store/sqlite/driver.ts) over SQLite compiled to WebAssembly (the project's own build, which has FTS5),
 * so the store runs unchanged where the plaintext is: in the browser. `openWasm` is handed to `createSqliteStoreWith`; the server never loads this file.
 *
 * It follows the contract in driver.ts, which is the native module's behaviour that the store relies on and nothing else: positional parameters (spread or one array), numbers, strings, null and
 * byte arrays as values (`undefined` binds as null and a boolean is refused, as in the native module), rows as objects, `run` giving `changes`,
 * `transaction()` that nests as savepoints, `pragma`, `exec`. A database is in memory: what persists is decided a level up, by sealing
 * the rows into the vault, not by a file the page could not protect anyway.
 */
const sqlite3 = await (sqlite3InitModule as unknown as (config?: object) => Promise<Sqlite3>)({ print: () => {}, printErr: () => {} });

/* Only the parts of the module's types this file touches; the package's own typings are large and move. */
interface Sqlite3Stmt {
  bind(values: unknown[]): void;
  step(): boolean;
  get(target: object): Record<string, unknown>;
  reset(alsoClearBindings?: boolean): void;
  clearBindings(): void;
  finalize(): void;
}
interface Sqlite3Db {
  pointer: number;
  prepare(sql: string): Sqlite3Stmt;
  exec(options: string | { sql: string; rowMode?: string; returnValue?: string }): unknown;
  changes(): number;
  close(): void;
}
interface Sqlite3 {
  oo1: { DB: new (filename: string, flags: string) => Sqlite3Db };
  capi: {
    sqlite3_get_autocommit(db: number): number;
    sqlite3_last_insert_rowid(db: number): number | bigint;
    sqlite3_total_changes(db: number): number;
    sqlite3_js_db_export(db: number): Uint8Array;
    sqlite3_deserialize(db: number, schema: string, data: number, size: number, capacity: number, flags: number): number;
    SQLITE_DESERIALIZE_FREEONCLOSE: number;
    SQLITE_DESERIALIZE_RESIZEABLE: number;
  };
  wasm: { allocFromTypedArray(bytes: Uint8Array): number };
}

type Param = number | string | bigint | null | Uint8Array;

function check(value: unknown): Param {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'bigint' || value instanceof Uint8Array) return value;
  throw new TypeError(`SQLite3 can only bind numbers, strings, bigints, buffers, and null (got ${typeof value})`);
}

function listOf(args: unknown[]): Param[] {
  const list = args.length === 1 && Array.isArray(args[0]) ? (args[0] as unknown[]) : args;
  return list.map(check);
}

/** SQLite hands back 64-bit integers; the store works in numbers, as the native module does. */
function plain(row: Record<string, unknown>): Record<string, unknown> {
  for (const key of Object.keys(row)) if (typeof row[key] === 'bigint') row[key] = Number(row[key]);
  return row;
}

class Statement {
  private stmt: Sqlite3Stmt;

  constructor(private readonly owner: WasmDatabase, source: string) {
    this.stmt = owner.raw.prepare(source);
  }

  private start(args: unknown[]) {
    this.stmt.reset(true);
    const list = listOf(args);
    if (list.length > 0) this.stmt.bind(list);
  }

  run(...args: unknown[]) {
    this.start(args);
    try {
      while (this.stmt.step()) { /* a statement that returns rows is run to its end */ }
    } finally {
      this.stmt.reset(true);
    }
    return { changes: this.owner.raw.changes(), lastInsertRowid: Number(sqlite3.capi.sqlite3_last_insert_rowid(this.owner.raw.pointer)) };
  }

  get(...args: unknown[]) {
    this.start(args);
    try {
      return this.stmt.step() ? plain(this.stmt.get({})) : undefined;
    } finally {
      this.stmt.reset(true);
    }
  }

  all(...args: unknown[]) {
    this.start(args);
    const rows: Array<Record<string, unknown>> = [];
    try {
      while (this.stmt.step()) rows.push(plain(this.stmt.get({})));
    } finally {
      this.stmt.reset(true);
    }
    return rows;
  }
}

export class WasmDatabase {
  readonly raw: Sqlite3Db;
  private depth = 0;

  /** Empty, or the database whose bytes (`export()`) are given. */
  constructor(bytes?: Uint8Array) {
    this.raw = new sqlite3.oo1.DB(':memory:', 'c');
    if (bytes) {
      const { capi, wasm } = sqlite3;
      const rc = capi.sqlite3_deserialize(this.raw.pointer, 'main', wasm.allocFromTypedArray(bytes), bytes.length, bytes.length, capi.SQLITE_DESERIALIZE_FREEONCLOSE | capi.SQLITE_DESERIALIZE_RESIZEABLE);
      if (rc !== 0) throw new Error(`could not load the database (${rc})`);
    }
  }

  /** The whole database as bytes (a SQLite file). Not while a transaction is open: it would hold what is not yet committed. */
  export(): Uint8Array {
    return sqlite3.capi.sqlite3_js_db_export(this.raw.pointer);
  }

  /** Rows inserted, changed or deleted since opening, triggers included: it differs from the last look when something was written. */
  get totalChanges(): number {
    return sqlite3.capi.sqlite3_total_changes(this.raw.pointer);
  }

  prepare(source: string) {
    return new Statement(this, source);
  }

  exec(source: string) {
    this.raw.exec(source);
    return this;
  }

  pragma(source: string) {
    return this.raw.exec({ sql: `PRAGMA ${source}`, rowMode: 'object', returnValue: 'resultRows' });
  }

  get inTransaction(): boolean {
    return sqlite3.capi.sqlite3_get_autocommit(this.raw.pointer) === 0;
  }

  /** Runs in a transaction, or in a savepoint when one is already open; rolls back and rethrows on an error. */
  transaction<F extends (...args: never[]) => unknown>(fn: F): F {
    const run = (...args: unknown[]) => {
      const nested = this.inTransaction;
      const name = `sp${this.depth++}`;
      this.exec(nested ? `SAVEPOINT ${name}` : 'BEGIN');
      try {
        const result = (fn as unknown as (...a: unknown[]) => unknown)(...args);
        this.exec(nested ? `RELEASE ${name}` : 'COMMIT');
        return result;
      } catch (err) {
        if (nested) this.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
        else this.exec('ROLLBACK');
        throw err;
      } finally {
        this.depth--;
      }
    };
    return run as unknown as F;
  }

  close() {
    this.raw.close();
  }
}

/** The location is ignored: the database is in memory, and what persists is the vault's business. */
export const openWasm = (_location: string) => new WasmDatabase();

/** A database loaded from the bytes `export()` gave. */
export const openWasmFrom = (bytes: Uint8Array) => new WasmDatabase(bytes);

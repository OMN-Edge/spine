/**
 * What the store needs from a SQLite driver, and nothing more. The repositories are written against this, not against
 * `better-sqlite3`, so the same code runs on the native module (the server) and on SQLite compiled to WebAssembly (the browser, where
 * the plaintext is). A driver is a function from a location to one of these; the server's is `server/src/driver-native.ts`.
 *
 * Values are numbers, strings, null (and `undefined`, which binds as null) and byte arrays; a boolean is refused, as the native module does. Rows are objects
 * and 64-bit integers come back as numbers.
 */
export interface Statement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface Database {
  prepare(sql: string): Statement;
  exec(sql: string): unknown;
  pragma(source: string): unknown;
  /** Wraps a function so that calling it runs in a transaction, or a savepoint inside one; rolls back and rethrows on an error. */
  transaction<F extends (...args: never[]) => unknown>(fn: F): F;
  readonly inTransaction: boolean;
  close(): void;
}

export type OpenDatabase = (location: string) => Database;

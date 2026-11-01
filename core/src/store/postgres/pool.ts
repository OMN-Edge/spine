/**
 * What the Postgres adapter needs from a connection pool, and nothing more. The repositories are written against this, not against `pg`,
 * so core imports no driver (S2): the server registers the real one (`server/src/driver-pg.ts`) and the tests register Postgres compiled to
 * WebAssembly (`testing/pglite-pool.ts`). A pool is a function from a connection string to one of these; as with SQLite's `useDriver`, a
 * process that has not chosen has no way to open a database.
 *
 * Values are numbers, strings, null (and `undefined`, which binds as null) and byte arrays. A 64-bit integer comes back as a number.
 */
export interface PgResult {
  rows: Array<Record<string, unknown>>;
  /** Rows an INSERT, UPDATE or DELETE touched; null for a statement that touches none. */
  rowCount: number | null;
}

export interface PgQueryable {
  query(text: string, params?: unknown[]): Promise<PgResult>;
}

/** One connection taken from the pool: a transaction lives on one, so every statement of it goes through the same. */
export interface PgClient extends PgQueryable {
  release(): void;
}

export interface PgPool extends PgQueryable {
  connect(): Promise<PgClient>;
  end(): Promise<void>;
}

export type OpenPool = (connectionString: string) => PgPool;

let chosen: OpenPool | null = null;

export function usePool(open: OpenPool | null): void {
  chosen = open;
}

export function openPool(connectionString: string): PgPool {
  if (!chosen) throw new Error('no Postgres pool has been chosen for this process (usePool)');
  return chosen(connectionString);
}

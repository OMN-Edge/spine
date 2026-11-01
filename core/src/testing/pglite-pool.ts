import { PGlite } from '@electric-sql/pglite';
import type { OpenPool, PgClient, PgPool, PgResult } from '../store/postgres/pool.js';

/**
 * A pool over Postgres compiled to WebAssembly (PGlite), so the Postgres adapter is tested against the real engine with nothing to install
 * or start. It has one connection: `connect` waits for the one before it to be released, which is what a pool of one does, so a transaction
 * keeps the connection to itself. Each address opens a database of its own in memory.
 */
export const openPglite: OpenPool = (): PgPool => {
  const db = new PGlite({ parsers: { 20: (value: string) => Number(value) } });
  let tail: Promise<void> = Promise.resolve();

  const run = async (text: string, params?: unknown[]): Promise<PgResult> => {
    // No parameters: the text may hold several statements (the schema), which only `exec` accepts.
    if (!params || params.length === 0) {
      const results = await db.exec(text);
      const last = results[results.length - 1];
      return { rows: (last?.rows ?? []) as Array<Record<string, unknown>>, rowCount: last?.affectedRows ?? null };
    }
    const result = await db.query(text, params as unknown[]);
    return { rows: result.rows as Array<Record<string, unknown>>, rowCount: result.affectedRows ?? null };
  };

  const connect = async (): Promise<PgClient> => {
    const before = tail;
    let release!: () => void;
    tail = new Promise<void>(resolve => { release = resolve; });
    await before;
    return { query: run, release };
  };

  return {
    // A statement outside a transaction waits its turn too, so it cannot land inside another's.
    query: async (text, params) => { const client = await connect(); try { return await client.query(text, params); } finally { client.release(); } },
    connect,
    end: async () => { await tail; await db.close(); },
  };
};

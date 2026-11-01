import pg from 'pg';
import type { OpenPool, PgPool } from 'spine-core/store/postgres/pool.js';

// A 64-bit integer (a COUNT, a SUM, a byte total) comes back as text by default; every one this server keeps is far below 2^53.
pg.types.setTypeParser(20, value => Number(value));

/** The server's Postgres pool: a handful of connections, because a transaction holds one and the work is short. */
export const openPg: OpenPool = (connectionString): PgPool => {
  const pool = new pg.Pool({ connectionString, max: Number(process.env.SPINE_DATABASE_POOL) || 10 });
  // An idle connection the database drops must not take the process down; the pool replaces it at the next use.
  pool.on('error', () => {});
  return pool as unknown as PgPool;
};

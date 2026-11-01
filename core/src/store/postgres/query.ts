import type { PgResult } from './pool.js';

/** How a repository runs a statement: on the pool, or on the one connection a transaction holds. Placeholders are `$1`, `$2` ... */
export type Query = (text: string, params?: unknown[]) => Promise<PgResult>;

/** The row or nothing. */
export async function one<T = Record<string, unknown>>(q: Query, text: string, params: unknown[] = []): Promise<T | null> {
  return ((await q(text, params)).rows[0] as T | undefined) ?? null;
}

export async function many<T = Record<string, unknown>>(q: Query, text: string, params: unknown[] = []): Promise<T[]> {
  return (await q(text, params)).rows as T[];
}

/** Rows a statement changed: what SQLite's `changes` is. */
export async function changed(q: Query, text: string, params: unknown[] = []): Promise<number> {
  return (await q(text, params)).rowCount ?? 0;
}

/**
 * Runs `work` as one transaction on one connection (a savepoint, when already inside one). `work` is handed the connection's `Query` and
 * the `Begin` for a transaction nested in it, so repository code reads the same inside a transaction and outside.
 */
export type Begin = <T>(work: (q: Query, nested: Begin) => Promise<T>) => Promise<T>;

import type { AccountsStore, StoreConfig } from '../types.js';
import { accountsSchema } from './schema-accounts.js';
import type { PgPool, PgQueryable } from './pool.js';
import type { Begin, Query } from './query.js';
import { billingRepository, metricsRepository, waitlistRepository } from './billing.js';
import { maintenanceRepository } from './maintenance.js';
import { sharedRepository } from './shared.js';
import { delegationRepository } from './delegations.js';
import { cookieSessionRepository, enrolmentRepository, sessionRepository, usageRepository } from './small.js';
import { userRepository } from './users.js';
import { vaultRepository } from './vault.js';

/** Held while the schema is applied, so two instances starting together do not both run it. */
const SCHEMA_LOCK = 7377001;

/**
 * The Postgres adapter over any pool (`pool.ts`): the server's store, accounts only, for a deployment that runs more than one instance or
 * on a host with no disk of its own. It has no `records`: those are on the device (SECURITY.md **M-37**), and this database has no table
 * for one, as the server's SQLite has none.
 *
 * Opening is synchronous, as the other adapter's is, so the schema is applied in the background and every statement waits for it. A
 * failure to connect or to apply it fails each call, in words, instead of an unhandled rejection at start.
 */
export function createPostgresAccountsStoreWith(_config: StoreConfig, pool: PgPool): AccountsStore {
  const ready = applySchema(pool);
  ready.catch(() => {});
  const q: Query = async (text, params) => { await ready; return pool.query(text, params); };
  const begin: Begin = async work => {
    await ready;
    const client = await pool.connect();
    try { return await inside(client, 0, work); } finally { client.release(); }
  };
  return {
    ...accountsOver(q, begin),
    async close() { await pool.end(); },
  };
}

async function applySchema(pool: PgPool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [SCHEMA_LOCK]);
    try { await client.query(accountsSchema); } finally { await client.query('SELECT pg_advisory_unlock($1)', [SCHEMA_LOCK]); }
  } finally {
    client.release();
  }
}

/**
 * One transaction on one connection: `BEGIN`, or a savepoint inside another, so an inner transaction cannot commit the outer one. Unlike
 * the SQLite adapter's single shared connection, nothing else's statements can land inside it.
 */
async function inside<T>(client: PgQueryable, depth: number, work: (q: Query, nested: Begin) => Promise<T>): Promise<T> {
  const savepoint = `spine_tx_${depth}`;
  await client.query(depth === 0 ? 'BEGIN' : `SAVEPOINT ${savepoint}`);
  try {
    const result = await work((text, params) => client.query(text, params), nested => inside(client, depth + 1, nested));
    await client.query(depth === 0 ? 'COMMIT' : `RELEASE SAVEPOINT ${savepoint}`);
    return result;
  } catch (err) {
    await client.query(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO SAVEPOINT ${savepoint}`);
    throw err;
  }
}

function accountsOver(q: Query, begin: Begin): Omit<AccountsStore, 'close'> {
  return {
    users: userRepository(q, begin),
    sessions: sessionRepository(q),
    cookieSessions: cookieSessionRepository(q),
    enrolments: enrolmentRepository(q),
    usage: usageRepository(q),
    vault: vaultRepository(q, begin),
    shared: sharedRepository(q, begin),
    maintenance: maintenanceRepository(q),
    billing: billingRepository(q),
    metrics: metricsRepository(q),
    waitlist: waitlistRepository(q),
    delegations: delegationRepository(q, begin),
    transaction: fn => begin((tq, nested) => fn({ ...accountsOver(tq, nested), async close() {} })),
  };
}

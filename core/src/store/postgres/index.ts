import { StoreConfigError, type AccountsStore, type Store, type StoreConfig } from '../types.js';
import { openPool } from './pool.js';
import { createPostgresAccountsStoreWith } from './store.js';

export { usePool } from './pool.js';

/** The server's store on Postgres: accounts, sessions, the vault and sealed shares, over the pool the process chose with `usePool`. */
export function createPostgresAccountsStore(config: StoreConfig): AccountsStore {
  return createPostgresAccountsStoreWith(config, openPool(config.location));
}

/** Records are on the device; this engine is for the server, which keeps none. */
export function createPostgresStore(): Store {
  throw new StoreConfigError('the postgres store keeps accounts only: a person’s records are on their device, so SPINE_STORE=postgres is for the server and not for a device or a test of one');
}

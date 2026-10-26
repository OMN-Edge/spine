import type { OpenDatabase } from './driver.js';
import { createSqliteAccountsStoreWith, createSqliteStoreWith } from './store.js';
import type { AccountsStore, Store, StoreConfig } from '../types.js';

/**
 * The entry to the SQLite adapter for a process that chooses its driver once, with `useDriver`: the server the native module, the tests of the
 * shared package that and, for the run against the WebAssembly one, that. The device imports `store.ts` and hands it its own driver. There is
 * no default: a process that has not chosen has no way to open a database.
 */
let chosen: OpenDatabase | null = null;

export function useDriver(open: OpenDatabase | null): void {
  chosen = open;
}

function driver(): OpenDatabase {
  if (!chosen) throw new Error('no SQLite driver has been chosen for this process (useDriver)');
  return chosen;
}

export function createSqliteStore(config: StoreConfig): Store {
  return createSqliteStoreWith(config, driver());
}

export function createSqliteAccountsStore(config: StoreConfig): AccountsStore {
  return createSqliteAccountsStoreWith(config, driver());
}

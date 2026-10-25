import { openNative } from './driver-native.js';
import type { OpenDatabase } from './driver.js';
import { createSqliteAccountsStoreWith, createSqliteStoreWith } from './store.js';
import type { AccountsStore, Store, StoreConfig } from '../types.js';

/**
 * The server's entry to the SQLite adapter: the native driver, unless a different one has been chosen with `useDriver` (the suite run
 * against the WebAssembly driver does). The browser imports `store.ts` and hands it its own driver, so this file, and the native
 * module, are not in its bundle.
 */
let chosen: OpenDatabase | null = null;

export function useDriver(open: OpenDatabase | null): void {
  chosen = open;
}

export function createSqliteStore(config: StoreConfig): Store {
  return createSqliteStoreWith(config, chosen ?? openNative);
}

export function createSqliteAccountsStore(config: StoreConfig): AccountsStore {
  return createSqliteAccountsStoreWith(config, chosen ?? openNative);
}

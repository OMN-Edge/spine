import { loadStoreConfig } from '../config.js';
import { createPostgresAccountsStore, createPostgresStore } from './postgres/index.js';
import { createSqliteAccountsStore, createSqliteStore } from './sqlite/index.js';
import { StoreConfigError, type AccountsStore, type Store, type StoreAdapter, type StoreConfig } from './types.js';

/**
 * Dispatch is a registry, as for the LLM interface: adding a store is a map entry
 * plus an adapter directory, with no conditional every adapter passes through.
 */
const ADAPTERS = {
  sqlite: { records: createSqliteStore, accounts: createSqliteAccountsStore },
  postgres: { records: createPostgresStore, accounts: createPostgresAccountsStore },
} satisfies Record<string, StoreAdapter>;

export const STORE_ADAPTERS = Object.keys(ADAPTERS);

function adapterOf(config: StoreConfig): StoreAdapter {
  const adapter = (ADAPTERS as Record<string, StoreAdapter | undefined>)[config.adapter];
  if (!adapter) {
    throw new StoreConfigError(`unknown SPINE_STORE "${config.adapter}"; expected one of ${STORE_ADAPTERS.join(', ')}`);
  }
  return adapter;
}

/** A store that holds records: the device's, and the tests' of what it runs. Pure: unit-testable with a config literal, no global state. */
export function createStore(config: StoreConfig): Store {
  return adapterOf(config).records(config);
}

/** The server's store: accounts, sessions, the vault and sealed shares, and no way to reach a record. */
export function createAccountsStore(config: StoreConfig): AccountsStore {
  return adapterOf(config).accounts(config);
}

export const holdsRecords = (store: AccountsStore): store is Store => 'documents' in store;

let _store: AccountsStore | null = null;
let _make: (() => AccountsStore) | null = null;

/**
 * Says what store this process opens when something first asks for one. The server's entry points say an accounts store, the device
 * hands over the store it made, and the tests say one that holds records. Nothing opens a store until this has been said, so a process
 * that forgot fails at its first use instead of quietly holding records.
 */
export function useStoreFactory(make: (() => AccountsStore) | null): void {
  _make = make;
}

export const hasStoreFactory = () => _make !== null;

/** The store this process has; for what the server does (accounts, sessions, the vault, sealed shares). */
export function getAccountsStore(): AccountsStore {
  if (!_store) {
    if (!_make) throw new Error('no store has been set up for this process (useStoreFactory)');
    _store = _make();
  }
  return _store;
}

/** The same store, for the code that works on records. Refuses where the store has none: the server. */
export function getStore(): Store {
  const store = getAccountsStore();
  if (!holdsRecords(store)) throw new Error('this process keeps no records: they are on the device (SECURITY.md M-37)');
  return store;
}

/** Tests, and a device that locks: closes what is open, and either puts the given store in its place or lets the next use open a new one. */
export function resetStore(replacement: AccountsStore | null = null): void {
  if (_store && replacement !== _store) void _store.close().catch(() => {});
  _store = replacement;
}

export * from './types.js';

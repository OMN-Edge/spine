import { loadStoreConfig } from '../config.js';
import { createSqliteStore } from './sqlite/index.js';
import { StoreConfigError, type Store, type StoreConfig, type StoreFactory } from './types.js';

/**
 * Dispatch is a registry, as for the LLM interface: adding a store is a map entry
 * plus an adapter directory, with no conditional every adapter passes through.
 */
const ADAPTERS = {
  sqlite: createSqliteStore,
} satisfies Record<string, StoreFactory>;

export const STORE_ADAPTERS = Object.keys(ADAPTERS);

/** Construction. Pure: unit-testable with a config literal, no global state. */
export function createStore(config: StoreConfig): Store {
  const factory = (ADAPTERS as Record<string, StoreFactory | undefined>)[config.adapter];
  if (!factory) {
    throw new StoreConfigError(
      `unknown SPINE_STORE "${config.adapter}"; expected one of ${STORE_ADAPTERS.join(', ')}`,
    );
  }
  return factory(config);
}

let _store: Store | null = null;

/**
 * Access. Reads config on first use and memoizes — the same shape as
 * `getChatLlm()`, and reading config here rather than at module load is what
 * `getDb()` got wrong, which is why `SPINE_DB_PATH` has to be set before
 * `db/index.ts` is first imported.
 */
export function getStore(): Store {
  if (!_store) _store = createStore(loadStoreConfig());
  return _store;
}

/** Tests only, as `resetDb()` was. */
export function resetStore(replacement: Store | null = null): void {
  if (_store && replacement !== _store) void _store.close().catch(() => {});
  _store = replacement;
}

export * from './types.js';

import type { Store } from 'spine-core/store/types';
import { createDeviceStore } from 'spine-core/store/sqlite/browser';
import { accountsSchema } from 'spine-core/store/sqlite/schema-accounts';
import { recordsSchema } from 'spine-core/store/sqlite/schema-records';
import { WasmDatabase } from './sqlite-wasm';

/**
 * The one place the device says what its records are kept in: SQLite compiled to WebAssembly, in memory, over the adapter's schema. The
 * rest of the device asks for a `Store` and knows nothing of the engine; another would be a change to this file and its driver.
 */
export function openDeviceStore(): Store {
  return createDeviceStore(() => new WasmDatabase(), `${accountsSchema}\n${recordsSchema}`);
}

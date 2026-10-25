import type { Store } from '../types.js';
import type { OpenDatabase } from './driver.js';
import { createSqliteStoreWith } from './store.js';

/**
 * The one door of the SQLite adapter for code that brings its own driver: the device's core in the browser (a SQLite in WebAssembly
 * that `web/src/core/sqlite-wasm.ts` wraps) and its share host. It leaves out `index.ts` because that opens the native module, which the
 * browser has not got. Nothing in the web imports another file of `store/sqlite/`, so what the device depends on is these two names
 * and the schema texts.
 */
export { copySlice } from './slice.js';

/**
 * A store that holds the person's records: the device's, in memory, over the schema texts it is handed. Records are held only here (and in
 * the tests of what the device runs); the server's store is accounts-only, which is what an unspecified scope gives (SECURITY.md **M-37**).
 */
export function createDeviceStore(open: OpenDatabase, schema: string): Store {
  return createSqliteStoreWith({ adapter: 'sqlite', location: ':memory:' }, open, schema);
}

/**
 * SQLite through the native module, for the tests of the shared package. The package itself has no native dependency: a store is opened over a
 * driver the host chooses (`useDriver`), the server's own being `server/src/driver-native.ts` and the device's SQLite in WebAssembly.
 */
import Native from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { OpenDatabase } from '../store/sqlite/driver.js';

/** The server's driver. The browser does not import this file, so the native module stays out of its bundle. */
export const openNative: OpenDatabase = location => {
  // A database on disk gets its folder; the engine's adapter in core knows nothing of folders.
  if (location !== ':memory:') mkdirSync(path.dirname(location), { recursive: true });
  return new Native(location) as unknown as ReturnType<OpenDatabase>;
};

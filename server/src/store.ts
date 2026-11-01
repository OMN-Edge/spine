import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadStoreConfig, useDefaultDataDir, useSettings } from 'spine-core/config.js';
import { createAccountsStore, useStoreFactory } from 'spine-core/store/index.js';
import { usePool } from 'spine-core/store/postgres/pool.js';
import { useDriver } from 'spine-core/store/sqlite/index.js';
import { openNative } from './driver-native.js';
import { openPg } from './driver-pg.js';
import { createObjects, useObjects } from './objects/index.js';

/**
 * What this server process keeps: accounts, sessions, the vault and the sealed copies of shares, in a database with no table for a record
 * and a store with no repository that could reach one (SECURITY.md **M-37**). Every entry point of the server calls this first. A process
 * that does not has no store at all, and fails the first time it asks for one; it can never end up holding records by omission.
 */
/** This file is `server/src/store.ts` or `server/dist/store.js`; the repository is two up. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function useAccountsStore(): void {
  // Where files go when DATA_DIR is not set (both systemd units set it): `<repo>/data`, wherever the process was started from.
  useSettings(process.env);
  useDefaultDataDir(path.join(REPO_ROOT, 'data'));
  useDriver(openNative);
  usePool(openPg);
  // The sealed bytes go where SPINE_OBJECTS says (files on this machine, or a bucket); made on first use, checked at start by `index.ts`.
  useObjects(() => createObjects());
  useStoreFactory(() => createAccountsStore(loadStoreConfig()));
}

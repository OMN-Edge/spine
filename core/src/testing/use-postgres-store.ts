import { createAccountsStore, useStoreFactory } from '../store/index.js';
import { loadStoreConfig } from '../config.js';
import { usePool } from '../store/postgres/pool.js';
import { useDriver } from '../store/sqlite/index.js';
import { openNative } from './driver-native.js';
import { useNodePlatform } from './node-platform.js';
import { openPglite } from './pglite-pool.js';

/**
 * Setup file of `test:postgres`: the server's own store, on Postgres. The tests that need a SQLite file for another reason (the backup)
 * are not in this run; every other test of the accounts' routes is, which is what keeps the two engines from disagreeing.
 */
useDriver(openNative);
usePool(openPglite);
useNodePlatform();
useStoreFactory(() => createAccountsStore({ adapter: 'postgres', location: 'postgres://pglite/spine' }));
(globalThis as { __spineStore?: string }).__spineStore = 'accounts';

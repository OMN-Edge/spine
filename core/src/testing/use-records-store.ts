import { createStore, useStoreFactory } from '../store/index.js';
import { loadStoreConfig } from '../config.js';

/**
 * Setup file of the test runs that exercise what the device runs: the store a test opens first holds records (and the accounts'
 * repositories with them), over the database `SPINE_DB_PATH` names, which the configuration sets to memory.
 */
useStoreFactory(() => createStore(loadStoreConfig()));
(globalThis as { __spineStore?: string }).__spineStore = 'records';

import { createAccountsStore, useStoreFactory } from '../store/index.js';
import { loadStoreConfig } from '../config.js';
import { useDriver } from '../store/sqlite/index.js';
import { openNative } from './driver-native.js';
import { useNodePlatform } from './node-platform.js';

/** Setup file of `test:accounts`: the store is the server's own, with nothing that could reach a record (SECURITY.md **M-37**). */
useDriver(openNative);
useNodePlatform();
useStoreFactory(() => createAccountsStore(loadStoreConfig()));
(globalThis as { __spineStore?: string }).__spineStore = 'accounts';

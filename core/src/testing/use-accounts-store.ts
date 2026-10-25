import { createAccountsStore, useStoreFactory } from '../store/index.js';
import { loadStoreConfig } from '../config.js';

/** Setup file of `test:accounts`: the store is the server's own, with nothing that could reach a record (SECURITY.md **M-37**). */
useStoreFactory(() => createAccountsStore(loadStoreConfig()));
(globalThis as { __spineStore?: string }).__spineStore = 'accounts';

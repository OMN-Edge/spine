import { loadStoreConfig } from 'spine-core/config.js';
import { createAccountsStore, useStoreFactory } from 'spine-core/store/index.js';

/**
 * What this server process keeps: accounts, sessions, the vault and the sealed copies of shares, in a database with no table for a record
 * and a store with no repository that could reach one (SECURITY.md **M-37**). Every entry point of the server calls this first. A process
 * that does not has no store at all, and fails the first time it asks for one; it can never end up holding records by omission.
 */
export function useAccountsStore(): void {
  useStoreFactory(() => createAccountsStore(loadStoreConfig()));
}

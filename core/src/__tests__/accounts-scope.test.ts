import { describe, it, expect, afterAll, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { createAccountsStore, createStore, getAccountsStore, getStore, holdsRecords, resetStore, useStoreFactory } from '../store/index.js';

/**
 * SECURITY.md M-37: the server's store is a different thing from the device's. It has no repository of records, so code written for it
 * cannot reach one (the type has none), and its database is made from the accounts' schema alone, so there is no table that could hold one.
 */
describe('the server’s store and the device’s', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'spine-scope-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  afterEach(() => { resetStore(null); });

  let made = 0;
  const tablesOf = async (store: { maintenance: { snapshotTo(file: string): Promise<void> }; close(): Promise<void> }) => {
    const file = path.join(dir, `store-${++made}.db`);
    await store.maintenance.snapshotTo(file);
    await store.close();
    const db = new Database(file, { readonly: true });
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(t => t.name);
    db.close();
    return names;
  };

  it('has the account, session, vault and sealed-share tables and none of a record', async () => {
    const tables = await tablesOf(createAccountsStore({ adapter: 'sqlite', location: ':memory:' }));
    expect(tables).toEqual(expect.arrayContaining(['users', 'user_sessions', 'cookie_sessions', 'user_passkeys', 'user_totp', 'vault_keys', 'vault_objects', 'shared_bundles']));
    for (const record of ['source_files', 'pages', 'documents', 'extracted_fields', 'measurements', 'doctors', 'tags', 'share_links', 'chat_messages', 'document_embeddings']) {
      expect(tables, record).not.toContain(record);
    }
  });

  it('is the accounts’ tables plus the records’ in the device’s store', async () => {
    const full = await tablesOf(createStore({ adapter: 'sqlite', location: ':memory:' }));
    const accounts = await tablesOf(createAccountsStore({ adapter: 'sqlite', location: ':memory:' }));
    for (const table of accounts) expect(full).toContain(table);
    expect(full).toEqual(expect.arrayContaining(['source_files', 'documents', 'pages']));
  });

  it('gives the server’s store no repository of records at all, not one that refuses', async () => {
    const store = createAccountsStore({ adapter: 'sqlite', location: ':memory:' });
    expect(Object.keys(store).sort()).toEqual(['billing', 'close', 'cookieSessions', 'delegations', 'enrolments', 'maintenance', 'metrics', 'sessions', 'shared', 'transaction', 'usage', 'users', 'vault', 'waitlist']);
    expect(holdsRecords(store)).toBe(false);
    await store.close();
  });

  it('refuses code that works on records when the process’s store has none, and serves what a server does', async () => {
    useStoreFactory(() => createAccountsStore({ adapter: 'sqlite', location: ':memory:' }));
    expect(() => getStore()).toThrow(/keeps no records/);
    await getAccountsStore().users.create({ id: 'u-1', email: 'a@spine.test', passwordHash: 'x', createdAt: new Date().toISOString(), verifiedAt: new Date().toISOString() });
    expect((await getAccountsStore().users.findByEmail('a@spine.test'))?.id).toBe('u-1');
    useStoreFactory(null);
  });

  it('gives records to the device’s store, through the same accessor', async () => {
    useStoreFactory(() => createStore({ adapter: 'sqlite', location: ':memory:' }));
    expect(getStore()).toBe(getAccountsStore());
    expect(typeof getStore().documents.listFor).toBe('function');
    useStoreFactory(null);
  });

  it('opens no store until the process has said what it keeps, so one that forgot cannot end up holding records', () => {
    useStoreFactory(null);
    expect(() => getAccountsStore()).toThrow(/no store has been set up/);
    expect(() => getStore()).toThrow(/no store has been set up/);
  });

  it('creates and deletes a user with no tables for their records', async () => {
    const store = createAccountsStore({ adapter: 'sqlite', location: ':memory:' });
    await store.users.create({ id: 'u-1', email: 'a@spine.test', passwordHash: 'x', createdAt: new Date().toISOString(), verifiedAt: new Date().toISOString() });
    expect((await store.users.findByEmail('a@spine.test'))?.id).toBe('u-1');
    await store.users.delete('u-1');
    expect(await store.users.findByEmail('a@spine.test')).toBeNull();
    await store.close();
  });
});

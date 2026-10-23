import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { createStore } from '../store/index.js';

/** SECURITY.md M-37: the server's database is made from the accounts' schema alone, so it has no table that could hold a record. */
describe('the store in accounts scope', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'spine-scope-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  let made = 0;
  const tablesOf = async (scope: 'accounts' | 'full') => {
    const store = createStore({ adapter: 'sqlite', location: ':memory:', scope });
    const file = path.join(dir, `${scope}-${++made}.db`);
    await store.maintenance.snapshotTo(file);
    await store.close();
    const db = new Database(file, { readonly: true });
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(t => t.name);
    db.close();
    return names;
  };

  it('has the account, session, vault and sealed-share tables and none of a record', async () => {
    const tables = await tablesOf('accounts');
    expect(tables).toEqual(expect.arrayContaining(['users', 'user_sessions', 'user_passkeys', 'user_totp', 'vault_keys', 'vault_objects', 'shared_bundles']));
    for (const record of ['source_files', 'pages', 'documents', 'extracted_fields', 'measurements', 'doctors', 'tags', 'share_links', 'chat_messages', 'document_embeddings']) {
      expect(tables, record).not.toContain(record);
    }
  });

  it('is the full set plus the records in the other scope', async () => {
    const full = await tablesOf('full');
    const accounts = await tablesOf('accounts');
    for (const table of accounts) expect(full).toContain(table);
    expect(full).toEqual(expect.arrayContaining(['source_files', 'documents', 'pages']));
  });

  it('refuses a repository of records at once, naming it, rather than failing deep in a query', async () => {
    const store = createStore({ adapter: 'sqlite', location: ':memory:', scope: 'accounts' });
    expect(() => store.documents.listFor).toThrow(/keeps no documents/);
    expect(() => store.sourceFiles.listFor).toThrow(/M-37/);
    await store.close();
  });

  it('creates and deletes a user with no tables for their records', async () => {
    const store = createStore({ adapter: 'sqlite', location: ':memory:', scope: 'accounts' });
    await store.users.create({ id: 'u-1', email: 'a@spine.test', passwordHash: 'x', createdAt: new Date().toISOString(), verifiedAt: new Date().toISOString() });
    expect((await store.users.findByEmail('a@spine.test'))?.id).toBe('u-1');
    await store.users.delete('u-1');
    expect(await store.users.findByEmail('a@spine.test')).toBeNull();
    await store.close();
  });
});

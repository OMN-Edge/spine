import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createAccountsStore, createStore, STORE_ADAPTERS } from '../store/index.js';
import { StoreConfigError, type AccountsStore } from '../store/types.js';
import { usePool } from '../store/postgres/pool.js';
import { openPglite } from '../testing/pglite-pool.js';
import { readStoreConfig } from '../config.js';

/**
 * The Postgres adapter, through the interface and on the real engine (PGlite). What it must do is what the SQLite one does: the server's
 * routes are tested on both (`test:postgres`); this holds the parts that are the engine's own: case-insensitive addresses, one statement
 * to spend a token or a call, transactions that roll back, and the schema applied twice.
 */
const NOW = '2026-01-01T00:00:00.000Z';
const LATER = '2026-01-01T01:00:00.000Z';
const user = (id: string, email: string) => ({ id, email, passwordHash: 'x', createdAt: NOW, verifiedAt: NOW, consent: undefined });
const keys = { kdf_salt: 's', kdf_params: '{}', wrapped_by_master: 'm', wrapped_by_recovery: 'r', public_key: 'p', wrapped_private_key: 'w' };

describe('the Postgres store', () => {
  let store: AccountsStore;
  beforeEach(async () => {
    usePool(openPglite);
    store = createAccountsStore({ adapter: 'postgres', location: 'postgres://pglite/test' });
    await store.users.create(user('a', 'Alice@Spine.test'));
    await store.users.create(user('b', 'bob@spine.test'));
  });
  afterEach(async () => { await store.close(); usePool(null); });

  it('is one of the adapters, for accounts only', () => {
    expect(STORE_ADAPTERS).toContain('postgres');
    expect(() => createStore({ adapter: 'postgres', location: 'postgres://x/y' })).toThrow(StoreConfigError);
  });

  it('finds an address whatever its case and refuses a second account on it', async () => {
    expect((await store.users.findByEmail('alice@spine.test'))?.id).toBe('a');
    await expect(store.users.create(user('c', 'ALICE@SPINE.TEST'))).rejects.toThrow(/unique/i);
  });

  it('spends a one-time token once', async () => {
    await store.users.createToken({ id: 't', userId: 'a', kind: 'reset', tokenHash: 'h', createdAt: NOW, expiresAt: '2999-01-01T00:00:00.000Z' });
    expect(await store.users.consumeToken('h', 'reset', LATER)).toBe('a');
    expect(await store.users.consumeToken('h', 'reset', LATER)).toBeNull();
  });

  it('counts model calls up to the limit and no further, each user apart', async () => {
    expect(await store.usage.spend('a', '2026-01-01', 2)).toBe(1);
    expect(await store.usage.spend('a', '2026-01-01', 2)).toBe(2);
    expect(await store.usage.spend('a', '2026-01-01', 2)).toBeNull();
    expect(await store.usage.spend('b', '2026-01-01', 2)).toBe(1);
    expect(await store.usage.spend('a', '2026-01-02', 2)).toBe(1);
    expect(await store.usage.spend('a', '2026-01-02', 0)).toBeNull();
  });

  it('rolls a transaction back when it fails, and a nested one back to its own start', async () => {
    await expect(store.transaction(async tx => {
      await tx.users.create(user('c', 'c@spine.test'));
      throw new Error('stop');
    })).rejects.toThrow('stop');
    expect(await store.users.findById('c')).toBeNull();

    await store.transaction(async tx => {
      await tx.users.create(user('d', 'd@spine.test'));
      await expect(tx.transaction(async inner => {
        await inner.users.create(user('e', 'e@spine.test'));
        throw new Error('inner');
      })).rejects.toThrow('inner');
    });
    expect(await store.users.findById('d')).not.toBeNull();
    expect(await store.users.findById('e')).toBeNull();
  });

  it('keeps the vault’s base-sequence and size rules', async () => {
    expect(await store.vault.put('a', { id: 'o', profileId: 'p', kind: 'blob', size: 10, wrappedKey: 'k', baseSeq: 0 }, NOW, 100)).toBe('no_vault');
    expect(await store.vault.putKeys('a', keys, NOW)).toBe(true);
    expect(await store.vault.putKeys('a', keys, NOW)).toBe(false);
    expect(await store.vault.put('a', { id: 'o', profileId: 'p', kind: 'blob', size: 10, wrappedKey: 'k', baseSeq: 0 }, NOW, 100)).toEqual({ seq: 1 });
    expect(await store.vault.put('a', { id: 'o', profileId: 'p', kind: 'blob', size: 10, wrappedKey: 'k', baseSeq: 0 }, NOW, 100)).toBe('conflict');
    expect(await store.vault.put('a', { id: 'big', profileId: 'p', kind: 'blob', size: 95, wrappedKey: 'k', baseSeq: 0 }, NOW, 100)).toBe('quota');
    expect(await store.vault.usage('a')).toEqual({ objects: 1, bytes: 10 });
    expect(await store.vault.remove('a', 'o', 1, LATER)).toEqual({ seq: 2 });
    expect((await store.vault.list('a', 0)).map(o => [o.id, o.deleted])).toEqual([['o', true]]);
    expect(await store.vault.erase('a')).toEqual(['o']);
    expect(await store.vault.getKeys('a')).toBeNull();
  });

  it('shares a copy, lets a visitor ask, and ends it', async () => {
    const bundle = { id: 'share-1', expiresAt: '2999-01-01T00:00:00.000Z', requireApproval: true, size: 5, blobs: 0, blobBytes: 0 };
    expect(await store.shared.put('a', bundle, NOW)).toBe('ok');
    expect(await store.shared.put('b', bundle, NOW)).toBe('taken');
    expect(await store.shared.usage('a', NOW)).toEqual({ bundles: 1, bytes: 5 });
    const asked = await store.shared.createRequest('share-1', { id: 'r1', visitorKey: 'v', note: null, country: 'RO', requestedAt: NOW }, 5);
    expect(asked).toMatchObject({ id: 'r1', status: 'pending' });
    expect(await store.shared.createRequest('share-1', { id: 'r2', visitorKey: 'v', note: null, country: null, requestedAt: NOW }, 5)).toBe('known');
    expect(await store.shared.decide('a', 'r1', 'approved', 'wrapped', LATER)).toBe(true);
    expect(await store.shared.revoke('a', 'share-1', LATER)).toBe(true);
    expect((await store.shared.getRequest('share-1', 'r1'))?.wrappedKey).toBeNull();
    expect(await store.shared.decide('a', 'r1', 'approved', 'wrapped', LATER)).toBe(false);
    await store.shared.logOpen('share-1', LATER, 'RO', null, true);
    expect(await store.shared.pendingOpens('a', 10)).toHaveLength(1);
  });

  it('removes everything an account owns with it', async () => {
    await store.vault.putKeys('a', keys, NOW);
    await store.shared.put('a', { id: 'share-2', expiresAt: '2999-01-01T00:00:00.000Z', requireApproval: false, size: 1, blobs: 0, blobBytes: 0 }, NOW);
    await store.sessions.open('a', { id: 's', at: NOW, userAgent: 'ua', address: '::1' });
    await store.users.delete('a');
    expect(await store.users.findById('a')).toBeNull();
    expect(await store.shared.get('share-2')).toBeNull();
    expect(await store.sessions.list('a')).toEqual([]);
  });

  it('applies its schema again over a database that has it', async () => {
    const again = createAccountsStore({ adapter: 'postgres', location: 'postgres://pglite/test' });
    await expect(again.users.list()).resolves.toBeDefined();
    await again.close();
  });
});

describe('the store settings for Postgres', () => {
  it('needs an address, and takes the adapter’s from SPINE_DATABASE_URL', () => {
    const problems: string[] = [];
    readStoreConfig({ SPINE_STORE: 'postgres' }, problems);
    expect(problems).toHaveLength(1);
    const ok: string[] = [];
    expect(readStoreConfig({ SPINE_STORE: 'postgres', SPINE_DATABASE_URL: 'postgres://u:p@db:5432/spine?sslmode=require' }, ok)).toEqual({ adapter: 'postgres', location: 'postgres://u:p@db:5432/spine?sslmode=require' });
    expect(ok).toEqual([]);
  });
});

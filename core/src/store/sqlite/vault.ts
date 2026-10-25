import type { Database } from './driver.js';
import type { VaultKeys, VaultKeysRecord, VaultObjectMeta, VaultRepository } from '../types.js';

const COLUMNS = 'id, profile_id, kind, seq, size, wrapped_key, deleted, created_at, updated_at';

const asMeta = (r: Record<string, unknown>): VaultObjectMeta => ({
  id: r.id as string,
  profile_id: r.profile_id as string,
  kind: r.kind as string,
  seq: r.seq as number,
  size: r.size as number,
  wrapped_key: r.wrapped_key as string,
  deleted: r.deleted === 1,
  created_at: r.created_at as string,
  updated_at: r.updated_at as string,
});

export function vaultRepository(db: Database): VaultRepository {
  const getKeys = db.prepare('SELECT user_id, kdf_salt, kdf_params, wrapped_by_master, wrapped_by_recovery, public_key, wrapped_private_key, seq, created_at, updated_at FROM vault_keys WHERE user_id = ?');
  const insertKeys = db.prepare(`
    INSERT OR IGNORE INTO vault_keys (user_id, kdf_salt, kdf_params, wrapped_by_master, wrapped_by_recovery, public_key, wrapped_private_key, seq, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
  `);
  const updateKeys = db.prepare(`
    UPDATE vault_keys SET kdf_salt = ?, kdf_params = ?, wrapped_by_master = ?, wrapped_by_recovery = ?, public_key = ?, wrapped_private_key = ?, updated_at = ?
    WHERE user_id = ?
  `);
  const list = db.prepare(`SELECT ${COLUMNS} FROM vault_objects WHERE user_id = ? AND seq > ? ORDER BY seq`);
  const get = db.prepare(`SELECT ${COLUMNS} FROM vault_objects WHERE user_id = ? AND id = ?`);
  const bumpSeq = db.prepare('UPDATE vault_keys SET seq = seq + 1 WHERE user_id = ? RETURNING seq');
  const usage = db.prepare('SELECT COUNT(*) AS objects, COALESCE(SUM(size), 0) AS bytes FROM vault_objects WHERE user_id = ? AND deleted = 0');
  const upsert = db.prepare(`
    INSERT INTO vault_objects (user_id, id, profile_id, kind, seq, size, wrapped_key, deleted, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    ON CONFLICT(user_id, id) DO UPDATE SET profile_id = excluded.profile_id, kind = excluded.kind, seq = excluded.seq,
      size = excluded.size, wrapped_key = excluded.wrapped_key, deleted = 0, updated_at = excluded.updated_at
  `);
  const tombstone = db.prepare('UPDATE vault_objects SET deleted = 1, size = 0, seq = ?, updated_at = ? WHERE user_id = ? AND id = ?');
  const ids = db.prepare('SELECT id FROM vault_objects WHERE user_id = ?');
  const deleteObjects = db.prepare('DELETE FROM vault_objects WHERE user_id = ?');
  const deleteKeys = db.prepare('DELETE FROM vault_keys WHERE user_id = ?');

  const putTx = db.transaction((userId: string, o: Parameters<VaultRepository['put']>[1], now: string, maxBytes: number) => {
    if (!getKeys.get(userId)) return 'no_vault' as const;
    const current = get.get(userId, o.id) as Record<string, unknown> | undefined;
    const currentSeq = current ? (current.seq as number) : 0;
    if (currentSeq !== o.baseSeq) return 'conflict' as const;
    const used = usage.get(userId) as { bytes: number };
    const freed = current && current.deleted !== 1 ? (current.size as number) : 0;
    if (used.bytes - freed + o.size > maxBytes) return 'quota' as const;
    const { seq } = bumpSeq.get(userId) as { seq: number };
    upsert.run(userId, o.id, o.profileId, o.kind, seq, o.size, o.wrappedKey, now, now);
    return { seq };
  });

  const removeTx = db.transaction((userId: string, id: string, baseSeq: number, now: string) => {
    const current = get.get(userId, id) as Record<string, unknown> | undefined;
    if (!current || current.deleted === 1 || current.seq !== baseSeq) return false as const;
    const { seq } = bumpSeq.get(userId) as { seq: number };
    tombstone.run(seq, now, userId, id);
    return { seq };
  });

  const eraseTx = db.transaction((userId: string) => {
    const gone = (ids.all(userId) as Array<{ id: string }>).map(r => r.id);
    deleteObjects.run(userId);
    deleteKeys.run(userId);
    return gone;
  });

  return {
    async getKeys(userId) {
      return (getKeys.get(userId) as VaultKeysRecord | undefined) ?? null;
    },

    async putKeys(userId, k: VaultKeys, now) {
      return insertKeys.run(userId, k.kdf_salt, k.kdf_params, k.wrapped_by_master, k.wrapped_by_recovery, k.public_key, k.wrapped_private_key, now, now).changes === 1;
    },

    async replaceKeys(userId, k: VaultKeys, now) {
      return updateKeys.run(k.kdf_salt, k.kdf_params, k.wrapped_by_master, k.wrapped_by_recovery, k.public_key, k.wrapped_private_key, now, userId).changes === 1;
    },

    async list(userId, since) {
      return (list.all(userId, since) as Array<Record<string, unknown>>).map(asMeta);
    },

    async get(userId, id) {
      const row = get.get(userId, id) as Record<string, unknown> | undefined;
      return row ? asMeta(row) : null;
    },

    async put(userId, object, now, maxBytes) {
      return putTx(userId, object, now, maxBytes);
    },

    async remove(userId, id, baseSeq, now) {
      return removeTx(userId, id, baseSeq, now);
    },

    async usage(userId) {
      return usage.get(userId) as { objects: number; bytes: number };
    },

    async erase(userId) {
      return eraseTx(userId);
    },
  };
}

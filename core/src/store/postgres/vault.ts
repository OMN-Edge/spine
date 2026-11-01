import type { VaultKeys, VaultKeysRecord, VaultObjectMeta, VaultRepository } from '../types.js';
import { changed, many, one, type Begin, type Query } from './query.js';

const COLUMNS = 'id, profile_id, kind, seq, size, wrapped_key, deleted, created_at, updated_at';

const asMeta = (r: Record<string, unknown>): VaultObjectMeta => ({
  id: r.id as string,
  profile_id: r.profile_id as string,
  kind: r.kind as string,
  seq: Number(r.seq),
  size: Number(r.size),
  wrapped_key: r.wrapped_key as string,
  deleted: r.deleted === 1,
  created_at: r.created_at as string,
  updated_at: r.updated_at as string,
});

const asKeys = (r: Record<string, unknown>): VaultKeysRecord => ({ ...(r as unknown as VaultKeysRecord), seq: Number(r.seq) });

export function vaultRepository(q: Query, begin: Begin): VaultRepository {
  const bumpSeq = async (run: Query, userId: string) => Number((await one<{ seq: number }>(run, 'UPDATE vault_keys SET seq = seq + 1 WHERE user_id = $1 RETURNING seq', [userId]))!.seq);

  return {
    async getKeys(userId) {
      const row = await one(q, 'SELECT user_id, kdf_salt, kdf_params, wrapped_by_master, wrapped_by_recovery, public_key, wrapped_private_key, seq, created_at, updated_at FROM vault_keys WHERE user_id = $1', [userId]);
      return row ? asKeys(row) : null;
    },

    async putKeys(userId, k: VaultKeys, now) {
      return (await changed(q, `INSERT INTO vault_keys (user_id, kdf_salt, kdf_params, wrapped_by_master, wrapped_by_recovery, public_key, wrapped_private_key, seq, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, $8) ON CONFLICT DO NOTHING`, [userId, k.kdf_salt, k.kdf_params, k.wrapped_by_master, k.wrapped_by_recovery, k.public_key, k.wrapped_private_key, now])) === 1;
    },

    async replaceKeys(userId, k: VaultKeys, now) {
      return (await changed(q, `UPDATE vault_keys SET kdf_salt = $1, kdf_params = $2, wrapped_by_master = $3, wrapped_by_recovery = $4, public_key = $5, wrapped_private_key = $6, updated_at = $7
        WHERE user_id = $8`, [k.kdf_salt, k.kdf_params, k.wrapped_by_master, k.wrapped_by_recovery, k.public_key, k.wrapped_private_key, now, userId])) === 1;
    },

    async list(userId, since) {
      return (await many(q, `SELECT ${COLUMNS} FROM vault_objects WHERE user_id = $1 AND seq > $2 ORDER BY seq`, [userId, since])).map(asMeta);
    },

    async get(userId, id) {
      const row = await one(q, `SELECT ${COLUMNS} FROM vault_objects WHERE user_id = $1 AND id = $2`, [userId, id]);
      return row ? asMeta(row) : null;
    },

    // The account's keys row is locked first: two writers of one account take turns, so the base-seq check and the quota are read of a state
    // nobody else is changing (SQLite gets this from having one writer).
    async put(userId, o, now, maxBytes) {
      return begin(async run => {
        if (!(await one(run, 'SELECT 1 FROM vault_keys WHERE user_id = $1 FOR UPDATE', [userId]))) return 'no_vault' as const;
        const current = await one(run, `SELECT ${COLUMNS} FROM vault_objects WHERE user_id = $1 AND id = $2`, [userId, o.id]);
        if ((current ? Number(current.seq) : 0) !== o.baseSeq) return 'conflict' as const;
        const used = Number((await one<{ bytes: number }>(run, 'SELECT COALESCE(SUM(size), 0) AS bytes FROM vault_objects WHERE user_id = $1 AND deleted = 0', [userId]))!.bytes);
        const freed = current && current.deleted !== 1 ? Number(current.size) : 0;
        if (used - freed + o.size > maxBytes) return 'quota' as const;
        const seq = await bumpSeq(run, userId);
        await run(`INSERT INTO vault_objects (user_id, id, profile_id, kind, seq, size, wrapped_key, deleted, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, $8)
          ON CONFLICT (user_id, id) DO UPDATE SET profile_id = excluded.profile_id, kind = excluded.kind, seq = excluded.seq,
            size = excluded.size, wrapped_key = excluded.wrapped_key, deleted = 0, updated_at = excluded.updated_at`, [userId, o.id, o.profileId, o.kind, seq, o.size, o.wrappedKey, now]);
        return { seq };
      });
    },

    async remove(userId, id, baseSeq, now) {
      return begin(async run => {
        await run('SELECT 1 FROM vault_keys WHERE user_id = $1 FOR UPDATE', [userId]);
        const current = await one(run, `SELECT ${COLUMNS} FROM vault_objects WHERE user_id = $1 AND id = $2`, [userId, id]);
        if (!current || current.deleted === 1 || Number(current.seq) !== baseSeq) return false as const;
        const seq = await bumpSeq(run, userId);
        await run('UPDATE vault_objects SET deleted = 1, size = 0, seq = $1, updated_at = $2 WHERE user_id = $3 AND id = $4', [seq, now, userId, id]);
        return { seq };
      });
    },

    async usage(userId) {
      const row = (await one<{ objects: number; bytes: number }>(q, 'SELECT COUNT(*) AS objects, COALESCE(SUM(size), 0) AS bytes FROM vault_objects WHERE user_id = $1 AND deleted = 0', [userId]))!;
      return { objects: Number(row.objects), bytes: Number(row.bytes) };
    },

    async rotateProfile(userId, profileId, update, now, before) {
      return begin(async run => {
        await run('SELECT 1 FROM vault_keys WHERE user_id = $1 FOR UPDATE', [userId]);
        const profile = await one(run, `SELECT ${COLUMNS} FROM vault_objects WHERE user_id = $1 AND id = $2`, [userId, profileId]);
        if (!profile || profile.kind !== 'profile' || profile.deleted === 1) return null;
        const live = (await many<{ id: string }>(run, "SELECT id FROM vault_objects WHERE user_id = $1 AND profile_id = $2 AND deleted = 0 AND kind <> 'profile'", [userId, profileId])).map(r => r.id).sort();
        const named = update.objects.map(o => o.id).sort();
        if (live.length !== named.length || live.some((id, i) => id !== named[i])) return null;
        // The new profile record is stored inside the step: if that fails, the step is undone.
        await before();
        let seq = 0;
        for (const o of update.objects) {
          seq = await bumpSeq(run, userId);
          await run('UPDATE vault_objects SET wrapped_key = $1, seq = $2, updated_at = $3 WHERE user_id = $4 AND id = $5', [o.wrappedKey, seq, now, userId, o.id]);
        }
        seq = await bumpSeq(run, userId);
        await run('UPDATE vault_objects SET wrapped_key = $1, seq = $2, size = $3, updated_at = $4 WHERE user_id = $5 AND id = $6', [update.profileWrapped, seq, update.profileSize, now, userId, profileId]);
        return { seq };
      });
    },

    async erase(userId) {
      return begin(async run => {
        const gone = (await many<{ id: string }>(run, 'SELECT id FROM vault_objects WHERE user_id = $1', [userId])).map(r => r.id);
        await run('DELETE FROM vault_objects WHERE user_id = $1', [userId]);
        await run('DELETE FROM vault_keys WHERE user_id = $1', [userId]);
        return gone;
      });
    },
  };
}

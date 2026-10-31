import type { DelegationInvite, DelegationRecord, DelegationRepository } from '../types.js';
import { changed, many, one, type Begin, type Query } from './query.js';
import { owner } from '../owner.js';

const COLUMNS = 'id, owner_user_id, profile_id, delegate_user_id, role, wrapped_key, state, created_at, updated_at';
const asGrant = (r: Record<string, unknown>): DelegationRecord => ({
  id: r.id as string, owner_user_id: r.owner_user_id as string, profile_id: r.profile_id as string, delegate_user_id: r.delegate_user_id as string,
  role: r.role as DelegationRecord['role'], wrapped_key: (r.wrapped_key as string | null) ?? null, state: r.state as DelegationRecord['state'],
  created_at: r.created_at as string, updated_at: r.updated_at as string,
});
const prefixed = (alias: string) => COLUMNS.split(', ').map(c => `${alias}.${c}`).join(', ');

export function delegationRepository(q: Query, begin: Begin): DelegationRepository {
  return {
    async promote(delegateId, grantId, update, now, before) {
      return begin(async run => {
        const id = owner(delegateId);
        const g = await one(run, `SELECT ${COLUMNS} FROM delegations WHERE id = $1 FOR UPDATE`, [grantId]);
        if (!g || g.delegate_user_id !== id || g.role !== 'self' || g.state !== 'active') return null;
        const from = g.owner_user_id as string;
        const profileId = g.profile_id as string;
        // Both vaults are locked, in one order, so two promotions or a promotion and a write cannot interleave.
        for (const user of [from, id].sort()) await run('SELECT 1 FROM vault_keys WHERE user_id = $1 FOR UPDATE', [user]);
        if (!(await one(run, 'SELECT 1 FROM vault_keys WHERE user_id = $1', [id]))) return 'no_vault' as const;
        const profile = await one(run, 'SELECT kind, deleted FROM vault_objects WHERE user_id = $1 AND id = $2', [from, profileId]);
        if (!profile || profile.kind !== 'profile' || profile.deleted === 1) return null;
        const live = (await many<{ id: string }>(run, "SELECT id FROM vault_objects WHERE user_id = $1 AND profile_id = $2 AND deleted = 0 AND kind <> 'profile'", [from, profileId])).map(r => r.id).sort();
        const named = update.objects.map(o => o.id).sort();
        if (live.length !== named.length || live.some((x, i) => x !== named[i])) return null;
        const others = (await many<{ id: string }>(run, "SELECT id FROM delegations WHERE owner_user_id = $1 AND profile_id = $2 AND id <> $3 AND state IN ('active', 'paused')", [from, profileId, grantId])).map(r => r.id).sort();
        const given = update.grants.map(x => x.id).sort();
        if (others.length !== given.length || others.some((x, i) => x !== given[i])) return null;
        // The sealed files are copied across inside the step: if that fails, the step is undone.
        await before({ fromUserId: from, profileId, objectIds: live });
        const bump = async (user: string) => Number((await one<{ seq: number }>(run, 'UPDATE vault_keys SET seq = seq + 1 WHERE user_id = $1 RETURNING seq', [user]))!.seq);
        const copy = (seq: number, size: number | null, wrapped: string, objectId: string) => run(
          'INSERT INTO vault_objects (user_id, id, profile_id, kind, seq, size, wrapped_key, deleted, created_at, updated_at) SELECT $1, id, profile_id, kind, $2, COALESCE($3, size), $4, 0, created_at, $5 FROM vault_objects WHERE user_id = $6 AND id = $7',
          [id, seq, size, wrapped, now, from, objectId]);
        const tombstone = async (objectId: string) => run('UPDATE vault_objects SET deleted = 1, size = 0, seq = $1, updated_at = $2 WHERE user_id = $3 AND id = $4', [await bump(from), now, from, objectId]);
        for (const o of update.objects) { await copy(await bump(id), null, o.wrappedKey, o.id); await tombstone(o.id); }
        const seq = await bump(id);
        await copy(seq, update.profileSize, update.profileWrapped, profileId);
        await tombstone(profileId);
        for (const x of update.grants) await run("UPDATE delegations SET owner_user_id = $1, state = 'paused', wrapped_key = $2, updated_at = $3 WHERE id = $4 AND owner_user_id = $5", [id, x.wrappedKey, now, x.id, from]);
        await run("UPDATE delegations SET state = 'revoked', wrapped_key = NULL, updated_at = $1 WHERE id = $2", [now, grantId]);
        await run('DELETE FROM profile_invites WHERE owner_user_id = $1 AND profile_id = $2', [from, profileId]);
        return { seq, fromUserId: from, objectIds: live };
      });
    },
    async invite(ownerId, i) {
      await q('INSERT INTO profile_invites (id, owner_user_id, profile_id, role, wrapped, proof_hash, created_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [i.id, owner(ownerId), i.profileId, i.role, i.wrapped, i.proofHash, i.now, i.expiresAt]);
    },
    async invites(ownerId, now) {
      return many<DelegationInvite>(q, "SELECT id, profile_id, role, expires_at FROM profile_invites WHERE owner_user_id = $1 AND state = 'offered' AND expires_at > $2 ORDER BY created_at", [owner(ownerId), now]);
    },
    async cancelInvite(ownerId, id) {
      return (await changed(q, "DELETE FROM profile_invites WHERE owner_user_id = $1 AND id = $2 AND state = 'offered'", [owner(ownerId), id])) === 1;
    },
    async claim(delegateId, id, proofHash, now, grantId) {
      return begin(async run => {
        // Spent by one statement that also checks the proof, the end and the state: two claims cannot both succeed.
        const spent = await one<{ owner_user_id: string; profile_id: string; role: DelegationRecord['role']; wrapped: string }>(run,
          "UPDATE profile_invites SET state = 'used' WHERE id = $1 AND proof_hash = $2 AND state = 'offered' AND expires_at > $3 AND owner_user_id <> $4 RETURNING owner_user_id, profile_id, role, wrapped", [id, proofHash, now, owner(delegateId)]);
        if (!spent) return null;
        await run("INSERT INTO delegations (id, owner_user_id, profile_id, delegate_user_id, role, state, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, 'pending', $6, $6)", [grantId, spent.owner_user_id, spent.profile_id, delegateId, spent.role, now]);
        return { grant: asGrant((await one(run, `SELECT ${COLUMNS} FROM delegations WHERE id = $1`, [grantId]))!), wrapped: spent.wrapped };
      });
    },
    async complete(delegateId, id, wrappedKey, now) {
      return (await changed(q, "UPDATE delegations SET wrapped_key = $1, state = 'active', updated_at = $2 WHERE id = $3 AND delegate_user_id = $4 AND state = 'pending'", [wrappedKey, now, id, owner(delegateId)])) === 1;
    },
    async get(id) {
      const r = await one(q, `SELECT ${COLUMNS} FROM delegations WHERE id = $1`, [id]);
      return r ? asGrant(r) : null;
    },
    async ownedBy(ownerId) {
      return (await many(q, `SELECT ${prefixed('d')}, u.email AS delegate_email, k.public_key AS delegate_public_key FROM delegations d JOIN users u ON u.id = d.delegate_user_id LEFT JOIN vault_keys k ON k.user_id = d.delegate_user_id WHERE d.owner_user_id = $1 AND d.state <> 'revoked' ORDER BY d.created_at`, [owner(ownerId)]))
        .map(r => ({ ...asGrant(r), delegate_email: r.delegate_email as string, delegate_public_key: (r.delegate_public_key as string | null) ?? null }));
    },
    async madeTo(delegateId) {
      const rows = await many(q, `SELECT ${prefixed('d')}, u.email AS owner_email FROM delegations d JOIN users u ON u.id = d.owner_user_id WHERE d.delegate_user_id = $1 AND d.state IN ('active', 'paused') ORDER BY d.created_at`, [owner(delegateId)]);
      const out = [];
      for (const r of rows) {
        const g = asGrant(r);
        const others = g.role !== 'self' ? [] : (await many(q, `SELECT d.id, d.role, d.state, u.email AS delegate_email, k.public_key AS delegate_public_key FROM delegations d JOIN users u ON u.id = d.delegate_user_id LEFT JOIN vault_keys k ON k.user_id = d.delegate_user_id WHERE d.owner_user_id = $1 AND d.profile_id = $2 AND d.id <> $3 AND d.state IN ('active', 'paused') ORDER BY d.created_at`, [g.owner_user_id, g.profile_id, g.id]))
          .map(o => ({ id: o.id as string, role: o.role as DelegationRecord['role'], state: o.state as DelegationRecord['state'], delegate_email: o.delegate_email as string, delegate_public_key: (o.delegate_public_key as string | null) ?? null }));
        out.push({ ...g, owner_email: r.owner_email as string, others });
      }
      return out;
    },
    async setState(ownerId, id, state, now) {
      return (await changed(q, "UPDATE delegations SET state = $1, updated_at = $2, wrapped_key = CASE WHEN $1 = 'revoked' THEN NULL ELSE wrapped_key END WHERE owner_user_id = $3 AND id = $4 AND state <> 'revoked'", [state, now, owner(ownerId), id])) === 1;
    },
    async leave(delegateId, id, now) {
      return (await changed(q, "UPDATE delegations SET state = 'revoked', wrapped_key = NULL, updated_at = $1 WHERE delegate_user_id = $2 AND id = $3 AND state <> 'revoked'", [now, owner(delegateId), id])) === 1;
    },
    async rewrap(ownerId, profileId, keys, now) {
      let n = 0;
      for (const k of keys) n += await changed(q, "UPDATE delegations SET wrapped_key = $1, updated_at = $2 WHERE owner_user_id = $3 AND profile_id = $4 AND id = $5 AND state IN ('active', 'paused')", [k.wrappedKey, now, owner(ownerId), profileId, k.id]);
      return n;
    },
  };
}

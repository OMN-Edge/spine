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
      return (await many(q, `SELECT ${prefixed('d')}, u.email AS owner_email FROM delegations d JOIN users u ON u.id = d.owner_user_id WHERE d.delegate_user_id = $1 AND d.state IN ('active', 'paused') ORDER BY d.created_at`, [owner(delegateId)]))
        .map(r => ({ ...asGrant(r), owner_email: r.owner_email as string }));
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

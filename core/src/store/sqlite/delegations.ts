import type { Database } from './driver.js';
import { owner } from '../owner.js';
import type { DelegationInvite, DelegationRecord, DelegationRepository } from '../types.js';

const COLUMNS = 'id, owner_user_id, profile_id, delegate_user_id, role, wrapped_key, state, created_at, updated_at';
const asGrant = (r: Record<string, unknown>): DelegationRecord => ({
  id: r.id as string, owner_user_id: r.owner_user_id as string, profile_id: r.profile_id as string, delegate_user_id: r.delegate_user_id as string,
  role: r.role as DelegationRecord['role'], wrapped_key: (r.wrapped_key as string | null) ?? null, state: r.state as DelegationRecord['state'],
  created_at: r.created_at as string, updated_at: r.updated_at as string,
});

/** Every statement names the acting account, as the owner or as the delegate (SECURITY.md P12); `get` is the route's own check. */
export function delegationRepository(db: Database): DelegationRepository {
  const insertInvite = db.prepare('INSERT INTO profile_invites (id, owner_user_id, profile_id, role, wrapped, proof_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const invites = db.prepare("SELECT id, profile_id, role, expires_at FROM profile_invites WHERE owner_user_id = ? AND state = 'offered' AND expires_at > ? ORDER BY created_at");
  const cancel = db.prepare("DELETE FROM profile_invites WHERE owner_user_id = ? AND id = ? AND state = 'offered'");
  // Spent by one statement that also checks the proof, the end and the state: two claims cannot both succeed.
  const spend = db.prepare("UPDATE profile_invites SET state = 'used' WHERE id = ? AND proof_hash = ? AND state = 'offered' AND expires_at > ? AND owner_user_id <> ? RETURNING owner_user_id, profile_id, role, wrapped");
  const insertGrant = db.prepare("INSERT INTO delegations (id, owner_user_id, profile_id, delegate_user_id, role, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)");
  const grant = db.prepare(`SELECT ${COLUMNS} FROM delegations WHERE id = ?`);
  const complete = db.prepare("UPDATE delegations SET wrapped_key = ?, state = 'active', updated_at = ? WHERE id = ? AND delegate_user_id = ? AND state = 'pending'");
  const owned = db.prepare(`SELECT ${COLUMNS.split(', ').map(c => `d.${c}`).join(', ')}, u.email AS delegate_email, k.public_key AS delegate_public_key FROM delegations d JOIN users u ON u.id = d.delegate_user_id LEFT JOIN vault_keys k ON k.user_id = d.delegate_user_id WHERE d.owner_user_id = ? AND d.state <> 'revoked' ORDER BY d.created_at`);
  const madeTo = db.prepare(`SELECT ${COLUMNS.split(', ').map(c => `d.${c}`).join(', ')}, u.email AS owner_email FROM delegations d JOIN users u ON u.id = d.owner_user_id WHERE d.delegate_user_id = ? AND d.state IN ('active', 'paused') ORDER BY d.created_at`);
  const setState = db.prepare("UPDATE delegations SET state = ?, updated_at = ?, wrapped_key = CASE WHEN ? = 'revoked' THEN NULL ELSE wrapped_key END WHERE owner_user_id = ? AND id = ? AND state <> 'revoked'");
  const leave = db.prepare("UPDATE delegations SET state = 'revoked', wrapped_key = NULL, updated_at = ? WHERE delegate_user_id = ? AND id = ? AND state <> 'revoked'");
  const rewrap = db.prepare("UPDATE delegations SET wrapped_key = ?, updated_at = ? WHERE owner_user_id = ? AND profile_id = ? AND id = ? AND state IN ('active', 'paused')");
  const claimTx = db.transaction((delegateId: string, id: string, proofHash: string, now: string, grantId: string) => {
    const spent = spend.get(id, proofHash, now, delegateId) as { owner_user_id: string; profile_id: string; role: DelegationRecord['role']; wrapped: string } | undefined;
    if (!spent) return null;
    insertGrant.run(grantId, spent.owner_user_id, spent.profile_id, delegateId, spent.role, now, now);
    return { grant: asGrant(grant.get(grantId) as Record<string, unknown>), wrapped: spent.wrapped };
  });
  return {
    async invite(ownerId, i) { insertInvite.run(i.id, owner(ownerId), i.profileId, i.role, i.wrapped, i.proofHash, i.now, i.expiresAt); },
    async invites(ownerId, now) { return invites.all(owner(ownerId), now) as DelegationInvite[]; },
    async cancelInvite(ownerId, id) { return cancel.run(owner(ownerId), id).changes === 1; },
    async claim(delegateId, id, proofHash, now, grantId) { return claimTx(owner(delegateId), id, proofHash, now, grantId); },
    async complete(delegateId, id, wrappedKey, now) { return complete.run(wrappedKey, now, id, owner(delegateId)).changes === 1; },
    async get(id) { const r = grant.get(id) as Record<string, unknown> | undefined; return r ? asGrant(r) : null; },
    async ownedBy(ownerId) { return (owned.all(owner(ownerId)) as Array<Record<string, unknown>>).map(r => ({ ...asGrant(r), delegate_email: r.delegate_email as string, delegate_public_key: (r.delegate_public_key as string | null) ?? null })); },
    async madeTo(delegateId) { return (madeTo.all(owner(delegateId)) as Array<Record<string, unknown>>).map(r => ({ ...asGrant(r), owner_email: r.owner_email as string })); },
    async setState(ownerId, id, state, now) { return setState.run(state, now, state, owner(ownerId), id).changes === 1; },
    async leave(delegateId, id, now) { return leave.run(now, owner(delegateId), id).changes === 1; },
    async rewrap(ownerId, profileId, keys, now) {
      let n = 0;
      for (const k of keys) n += rewrap.run(k.wrappedKey, now, owner(ownerId), profileId, k.id).changes;
      return n;
    },
  };
}

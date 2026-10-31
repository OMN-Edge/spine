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
  const othersOf = db.prepare(`SELECT d.id, d.role, d.state, u.email AS delegate_email, k.public_key AS delegate_public_key FROM delegations d JOIN users u ON u.id = d.delegate_user_id LEFT JOIN vault_keys k ON k.user_id = d.delegate_user_id WHERE d.owner_user_id = ? AND d.profile_id = ? AND d.id <> ? AND d.state IN ('active', 'paused') ORDER BY d.created_at`);
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
  // Promotion at eighteen: see the interface. Everything that changes is in one transaction; what can be checked is checked first.
  const promotable = (delegateId: string, grantId: string, u: Parameters<DelegationRepository['promote']>[2]) => {
    const g = grant.get(grantId) as Record<string, unknown> | undefined;
    if (!g || g.delegate_user_id !== delegateId || g.role !== 'self' || g.state !== 'active') return null;
    const from = g.owner_user_id as string;
    const profileId = g.profile_id as string;
    const profile = db.prepare('SELECT kind, deleted FROM vault_objects WHERE user_id = ? AND id = ?').get(from, profileId) as { kind: string; deleted: number } | undefined;
    if (!profile || profile.kind !== 'profile' || profile.deleted === 1) return null;
    const live = (db.prepare("SELECT id FROM vault_objects WHERE user_id = ? AND profile_id = ? AND deleted = 0 AND kind <> 'profile'").all(from, profileId) as Array<{ id: string }>).map(r => r.id).sort();
    const named = u.objects.map(o => o.id).sort();
    if (live.length !== named.length || live.some((id, i) => id !== named[i])) return null;
    const others = (db.prepare("SELECT id FROM delegations WHERE owner_user_id = ? AND profile_id = ? AND id <> ? AND state IN ('active', 'paused')").all(from, profileId, grantId) as Array<{ id: string }>).map(r => r.id).sort();
    const given = u.grants.map(x => x.id).sort();
    if (others.length !== given.length || others.some((id, i) => id !== given[i])) return null;
    return { from, profileId, live };
  };
  const promoteTx = db.transaction((delegateId: string, grantId: string, u: Parameters<DelegationRepository['promote']>[2], now: string) => {
    const ok = promotable(delegateId, grantId, u);
    if (!ok) return null;
    const bump = (user: string) => (db.prepare('UPDATE vault_keys SET seq = seq + 1 WHERE user_id = ? RETURNING seq').get(user) as { seq: number }).seq;
    const copy = db.prepare('INSERT INTO vault_objects (user_id, id, profile_id, kind, seq, size, wrapped_key, deleted, created_at, updated_at) SELECT ?, id, profile_id, kind, ?, COALESCE(?, size), ?, 0, created_at, ? FROM vault_objects WHERE user_id = ? AND id = ?');
    const tombstone = db.prepare('UPDATE vault_objects SET deleted = 1, size = 0, seq = ?, updated_at = ? WHERE user_id = ? AND id = ?');
    let seq = 0;
    for (const o of u.objects) {
      copy.run(delegateId, bump(delegateId), null, o.wrappedKey, now, ok.from, o.id);
      tombstone.run(bump(ok.from), now, ok.from, o.id);
    }
    seq = bump(delegateId);
    copy.run(delegateId, seq, u.profileSize, u.profileWrapped, now, ok.from, ok.profileId);
    tombstone.run(bump(ok.from), now, ok.from, ok.profileId);
    // The profile is the delegate's now, with everyone else who had it paused until they choose, each holding the new key sealed to them.
    const pause = db.prepare("UPDATE delegations SET owner_user_id = ?, state = 'paused', wrapped_key = ?, updated_at = ? WHERE id = ? AND owner_user_id = ?");
    for (const x of u.grants) pause.run(delegateId, x.wrappedKey, now, x.id, ok.from);
    db.prepare("UPDATE delegations SET state = 'revoked', wrapped_key = NULL, updated_at = ? WHERE id = ?").run(now, grantId);
    db.prepare('DELETE FROM profile_invites WHERE owner_user_id = ? AND profile_id = ?').run(ok.from, ok.profileId);
    return { seq, fromUserId: ok.from, objectIds: ok.live };
  });

  return {
    async promote(delegateId, grantId, update, now, before) {
      const ok = promotable(owner(delegateId), grantId, update);
      if (!ok) return null;
      if (!db.prepare('SELECT 1 FROM vault_keys WHERE user_id = ?').get(delegateId)) return 'no_vault';
      await before({ fromUserId: ok.from, profileId: ok.profileId, objectIds: ok.live });
      const done = promoteTx(delegateId, grantId, update, now);
      if (!done) throw new Error('the vault changed during the promotion');
      return done;
    },
    async invite(ownerId, i) { insertInvite.run(i.id, owner(ownerId), i.profileId, i.role, i.wrapped, i.proofHash, i.now, i.expiresAt); },
    async invites(ownerId, now) { return invites.all(owner(ownerId), now) as DelegationInvite[]; },
    async cancelInvite(ownerId, id) { return cancel.run(owner(ownerId), id).changes === 1; },
    async claim(delegateId, id, proofHash, now, grantId) { return claimTx(owner(delegateId), id, proofHash, now, grantId); },
    async complete(delegateId, id, wrappedKey, now) { return complete.run(wrappedKey, now, id, owner(delegateId)).changes === 1; },
    async get(id) { const r = grant.get(id) as Record<string, unknown> | undefined; return r ? asGrant(r) : null; },
    async ownedBy(ownerId) { return (owned.all(owner(ownerId)) as Array<Record<string, unknown>>).map(r => ({ ...asGrant(r), delegate_email: r.delegate_email as string, delegate_public_key: (r.delegate_public_key as string | null) ?? null })); },
    async madeTo(delegateId) {
      return (madeTo.all(owner(delegateId)) as Array<Record<string, unknown>>).map(r => {
        const g = asGrant(r);
        const others = g.role === 'self' ? (othersOf.all(g.owner_user_id, g.profile_id, g.id) as Array<Record<string, unknown>>).map(o => ({ id: o.id as string, role: o.role as DelegationRecord['role'], state: o.state as DelegationRecord['state'], delegate_email: o.delegate_email as string, delegate_public_key: (o.delegate_public_key as string | null) ?? null })) : [];
        return { ...g, owner_email: r.owner_email as string, others };
      });
    },
    async setState(ownerId, id, state, now) { return setState.run(state, now, state, owner(ownerId), id).changes === 1; },
    async leave(delegateId, id, now) { return leave.run(now, owner(delegateId), id).changes === 1; },
    async rewrap(ownerId, profileId, keys, now) {
      let n = 0;
      for (const k of keys) n += rewrap.run(k.wrappedKey, now, owner(ownerId), profileId, k.id).changes;
      return n;
    },
  };
}

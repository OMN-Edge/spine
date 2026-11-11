import type { Database } from './driver.js';
import { owner } from '../owner.js';
import type { FamilyRepository, SeatRefusal } from '../types.js';

const DAY_MS = 24 * 3600e3;

/** Every statement names the acting account, as the organizer or as the member (SECURITY.md P12). */
export function familyRepository(db: Database): FamilyRepository {
  const membership = db.prepare('SELECT organizer_id, joined_at FROM family_members WHERE member_id = ?');
  const members = db.prepare('SELECT m.member_id AS id, u.email AS email, m.joined_at AS joined_at FROM family_members m JOIN users u ON u.id = m.member_id WHERE m.organizer_id = ? ORDER BY m.joined_at, m.member_id');
  const held = db.prepare(`SELECT COUNT(*) AS n FROM vault_objects WHERE kind = 'profile' AND deleted = 0 AND (user_id = ? OR user_id IN (SELECT member_id FROM family_members WHERE organizer_id = ?))`);
  const poolBytes = db.prepare('SELECT COALESCE(SUM(size), 0) AS n FROM vault_objects WHERE deleted = 0 AND (user_id = ? OR user_id IN (SELECT member_id FROM family_members WHERE organizer_id = ?))');
  const poolLinks = db.prepare("SELECT COUNT(*) AS n FROM shared_bundles WHERE kind = 'share' AND revoked_at IS NULL AND expires_at > ? AND (user_id = ? OR user_id IN (SELECT member_id FROM family_members WHERE organizer_id = ?))");
  const invites = db.prepare("SELECT id, created_at, expires_at FROM family_invites WHERE organizer_id = ? AND state = 'offered' AND expires_at > ? ORDER BY created_at");
  const insertInvite = db.prepare('INSERT INTO family_invites (id, organizer_id, secret_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)');
  const cancel = db.prepare("DELETE FROM family_invites WHERE organizer_id = ? AND id = ? AND state = 'offered'");
  const peek = db.prepare("SELECT organizer_id, expires_at FROM family_invites WHERE id = ? AND secret_hash = ? AND state = 'offered' AND expires_at > ? AND organizer_id <> ?");
  const count = db.prepare('SELECT COUNT(*) AS n FROM family_members WHERE organizer_id = ?');
  const left = db.prepare('SELECT organizer_id, left_at FROM family_left WHERE member_id = ?');
  const spend = db.prepare("UPDATE family_invites SET state = 'used' WHERE id = ? AND state = 'offered'");
  const add = db.prepare('INSERT INTO family_members (member_id, organizer_id, joined_at) VALUES (?, ?, ?)');
  const forget = db.prepare('DELETE FROM family_left WHERE member_id = ?');
  const dropOwnInvites = db.prepare('DELETE FROM family_invites WHERE organizer_id = ?');
  const drop = db.prepare('DELETE FROM family_members WHERE organizer_id = ? AND member_id = ?');
  const dropSelf = db.prepare('DELETE FROM family_members WHERE member_id = ? RETURNING organizer_id');
  const remember = db.prepare('INSERT INTO family_left (member_id, organizer_id, left_at) VALUES (?, ?, ?) ON CONFLICT (member_id) DO UPDATE SET organizer_id = excluded.organizer_id, left_at = excluded.left_at');

  const joinTx = db.transaction((userId: string, id: string, secretHash: string, now: string, rules: { seats: number; cooldownDays: number }): { organizer_id: string } | SeatRefusal => {
    const invite = peek.get(id, secretHash, now, userId) as { organizer_id: string } | undefined;
    if (!invite) return 'invalid';
    if (membership.get(userId)) return 'already_member';
    // An account others share cannot take a seat in another plan: they would be left on nothing.
    if ((count.get(userId) as { n: number }).n > 0) return 'is_organizer';
    const gone = left.get(userId) as { organizer_id: string; left_at: string } | undefined;
    if (gone && gone.organizer_id !== invite.organizer_id && Date.parse(gone.left_at) + rules.cooldownDays * DAY_MS > Date.parse(now)) return 'cooldown';
    // The organizer holds a seat too.
    if ((count.get(invite.organizer_id) as { n: number }).n + 1 >= rules.seats) return 'full';
    if (spend.run(id).changes !== 1) return 'invalid';
    add.run(userId, invite.organizer_id, now);
    forget.run(userId);
    dropOwnInvites.run(userId);
    return { organizer_id: invite.organizer_id };
  });
  const leaveTx = db.transaction((userId: string, now: string) => {
    const row = dropSelf.get(userId) as { organizer_id: string } | undefined;
    if (!row) return false;
    remember.run(userId, row.organizer_id, now);
    return true;
  });
  const removeTx = db.transaction((organizerId: string, memberId: string, now: string) => {
    if (drop.run(organizerId, memberId).changes !== 1) return false;
    remember.run(memberId, organizerId, now);
    return true;
  });

  return {
    async membership(userId) { return (membership.get(owner(userId)) as { organizer_id: string; joined_at: string } | undefined) ?? null; },
    async members(organizerId) { return members.all(owner(organizerId)) as Array<{ id: string; email: string; joined_at: string }>; },
    async profilesHeld(organizerId) { const id = owner(organizerId); return (held.get(id, id) as { n: number }).n; },
    async pool(organizerId, now) {
      const id = owner(organizerId);
      return { bytes: Number((poolBytes.get(id, id) as { n: number }).n), links: Number((poolLinks.get(now, id, id) as { n: number }).n) };
    },
    async invites(organizerId, now) { return invites.all(owner(organizerId), now) as Array<{ id: string; created_at: string; expires_at: string }>; },
    async invite(organizerId, i) { insertInvite.run(i.id, owner(organizerId), i.secretHash, i.now, i.expiresAt); },
    async cancelInvite(organizerId, id) { return cancel.run(owner(organizerId), id).changes === 1; },
    async peek(userId, id, secretHash, now) { return (peek.get(id, secretHash, now, owner(userId)) as { organizer_id: string; expires_at: string } | undefined) ?? null; },
    async join(userId, id, secretHash, now, rules) { return joinTx(owner(userId), id, secretHash, now, rules); },
    async remove(organizerId, memberId, now) { return removeTx(owner(organizerId), memberId, now); },
    async leave(userId, now) { return leaveTx(owner(userId), now); },
  };
}

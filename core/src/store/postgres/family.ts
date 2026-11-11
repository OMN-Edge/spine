import type { FamilyRepository, SeatRefusal } from '../types.js';
import { many, one, changed, type Begin, type Query } from './query.js';
import { owner } from '../owner.js';

const DAY_MS = 24 * 3600e3;

/** Every statement names the acting account, as the organizer or as the member (SECURITY.md P12). */
export function familyRepository(q: Query, begin: Begin): FamilyRepository {
  return {
    async membership(userId) {
      const r = await one(q, 'SELECT organizer_id, joined_at FROM family_members WHERE member_id = $1', [owner(userId)]);
      return r ? { organizer_id: r.organizer_id as string, joined_at: r.joined_at as string } : null;
    },
    async members(organizerId) {
      return many<{ id: string; email: string; joined_at: string }>(q, 'SELECT m.member_id AS id, u.email AS email, m.joined_at AS joined_at FROM family_members m JOIN users u ON u.id = m.member_id WHERE m.organizer_id = $1 ORDER BY m.joined_at, m.member_id', [owner(organizerId)]);
    },
    async profilesHeld(organizerId) {
      const r = await one<{ n: number }>(q, `SELECT COUNT(*) AS n FROM vault_objects WHERE kind = 'profile' AND deleted = 0 AND (user_id = $1 OR user_id IN (SELECT member_id FROM family_members WHERE organizer_id = $1))`, [owner(organizerId)]);
      return Number(r!.n);
    },
    async pool(organizerId, now) {
      const id = owner(organizerId);
      const bytes = await one<{ n: number }>(q, `SELECT COALESCE(SUM(size), 0) AS n FROM vault_objects WHERE deleted = 0 AND (user_id = $1 OR user_id IN (SELECT member_id FROM family_members WHERE organizer_id = $1))`, [id]);
      const links = await one<{ n: number }>(q, `SELECT COUNT(*) AS n FROM shared_bundles WHERE kind = 'share' AND revoked_at IS NULL AND expires_at > $2 AND (user_id = $1 OR user_id IN (SELECT member_id FROM family_members WHERE organizer_id = $1))`, [id, now]);
      return { bytes: Number(bytes!.n), links: Number(links!.n) };
    },
    async invites(organizerId, now) {
      return many<{ id: string; created_at: string; expires_at: string }>(q, "SELECT id, created_at, expires_at FROM family_invites WHERE organizer_id = $1 AND state = 'offered' AND expires_at > $2 ORDER BY created_at", [owner(organizerId), now]);
    },
    async invite(organizerId, i) {
      await q('INSERT INTO family_invites (id, organizer_id, secret_hash, created_at, expires_at) VALUES ($1, $2, $3, $4, $5)', [i.id, owner(organizerId), i.secretHash, i.now, i.expiresAt]);
    },
    async cancelInvite(organizerId, id) {
      return (await changed(q, "DELETE FROM family_invites WHERE organizer_id = $1 AND id = $2 AND state = 'offered'", [owner(organizerId), id])) === 1;
    },
    async peek(userId, id, secretHash, now) {
      const r = await one(q, "SELECT organizer_id, expires_at FROM family_invites WHERE id = $1 AND secret_hash = $2 AND state = 'offered' AND expires_at > $3 AND organizer_id <> $4", [id, secretHash, now, owner(userId)]);
      return r ? { organizer_id: r.organizer_id as string, expires_at: r.expires_at as string } : null;
    },
    async join(userId, id, secretHash, now, rules) {
      const me = owner(userId);
      return begin(async run => {
        const invite = await one(run, "SELECT organizer_id FROM family_invites WHERE id = $1 AND secret_hash = $2 AND state = 'offered' AND expires_at > $3 AND organizer_id <> $4 FOR UPDATE", [id, secretHash, now, me]);
        if (!invite) return 'invalid' as SeatRefusal;
        const organizerId = invite.organizer_id as string;
        // The organizer's row is locked, so two people taking the last seat at once are taken one after the other.
        await run('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [organizerId]);
        if (await one(run, 'SELECT 1 FROM family_members WHERE member_id = $1', [me])) return 'already_member' as SeatRefusal;
        if (await one(run, 'SELECT 1 FROM family_members WHERE organizer_id = $1', [me])) return 'is_organizer' as SeatRefusal;
        const gone = await one(run, 'SELECT organizer_id, left_at FROM family_left WHERE member_id = $1', [me]);
        if (gone && gone.organizer_id !== organizerId && Date.parse(gone.left_at as string) + rules.cooldownDays * DAY_MS > Date.parse(now)) return 'cooldown' as SeatRefusal;
        const used = Number((await one<{ n: number }>(run, 'SELECT COUNT(*) AS n FROM family_members WHERE organizer_id = $1', [organizerId]))!.n);
        if (used + 1 >= rules.seats) return 'full' as SeatRefusal;
        if ((await changed(run, "UPDATE family_invites SET state = 'used' WHERE id = $1 AND state = 'offered'", [id])) !== 1) return 'invalid' as SeatRefusal;
        await run('INSERT INTO family_members (member_id, organizer_id, joined_at) VALUES ($1, $2, $3)', [me, organizerId, now]);
        await run('DELETE FROM family_left WHERE member_id = $1', [me]);
        await run('DELETE FROM family_invites WHERE organizer_id = $1', [me]);
        return { organizer_id: organizerId };
      });
    },
    async remove(organizerId, memberId, now) {
      const id = owner(organizerId);
      return begin(async run => {
        if ((await changed(run, 'DELETE FROM family_members WHERE organizer_id = $1 AND member_id = $2', [id, memberId])) !== 1) return false;
        await run('INSERT INTO family_left (member_id, organizer_id, left_at) VALUES ($1, $2, $3) ON CONFLICT (member_id) DO UPDATE SET organizer_id = excluded.organizer_id, left_at = excluded.left_at', [memberId, id, now]);
        return true;
      });
    },
    async leave(userId, now) {
      const me = owner(userId);
      return begin(async run => {
        const row = await one(run, 'DELETE FROM family_members WHERE member_id = $1 RETURNING organizer_id', [me]);
        if (!row) return false;
        await run('INSERT INTO family_left (member_id, organizer_id, left_at) VALUES ($1, $2, $3) ON CONFLICT (member_id) DO UPDATE SET organizer_id = excluded.organizer_id, left_at = excluded.left_at', [me, row.organizer_id, now]);
        return true;
      });
    },
  };
}

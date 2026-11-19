import type { Database } from './driver.js';
import { owner } from '../owner.js';
import type { InvitationRepository } from '../types.js';

/** Who invited an account, until it buys or the link is old (`store/types.ts`). Every statement is for the invitee's `user_id`, but the sweep, which is for the whole instance. */
export function invitationRepository(db: Database): InvitationRepository {
  const insert = db.prepare('INSERT OR IGNORE INTO invitations (user_id, inviter_id, created_at) VALUES (?, ?, ?)');
  const find = db.prepare('SELECT inviter_id FROM invitations WHERE user_id = ? AND created_at >= ?');
  const drop = db.prepare('DELETE FROM invitations WHERE user_id = ?');
  const sweep = db.prepare('DELETE FROM invitations WHERE created_at < ?');
  return {
    async record(userId, inviterId, at) { return insert.run(owner(userId), inviterId, at).changes > 0; },
    async take(userId, notBefore) {
      const found = find.get(owner(userId), notBefore) as { inviter_id: string } | undefined;
      // The row is deleted by the call that finds it: a second call, or a second payment, finds nothing.
      return drop.run(owner(userId)).changes > 0 && found ? found.inviter_id : null;
    },
    async sweep(before) { return sweep.run(before).changes; },
  };
}

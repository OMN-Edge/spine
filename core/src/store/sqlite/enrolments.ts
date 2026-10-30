import type { Database } from './driver.js';
import { owner } from './owner.js';
import type { EnrolmentClaim, EnrolmentOffer, EnrolmentRepository } from '../types.js';

const OFFER_COLUMNS = 'id, state, expires_at, requested_at, requester_agent, requester_country';

/**
 * Every statement on the signed-in side filters by `user_id` (SECURITY.md P12). `request` and `claim` are the public side, scoped by the
 * offer's id and the token only the asking browser has (store/types.ts, exception 4). Each step is one statement that checks the state it
 * moves from, so two browsers cannot both be let in by one approval.
 */
export function enrolmentRepository(db: Database): EnrolmentRepository {
  const drop = db.prepare('DELETE FROM device_enrolments WHERE user_id = ?');
  const insert = db.prepare('INSERT INTO device_enrolments (id, user_id, wrapped, auth_version, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)');
  const current = db.prepare(`SELECT ${OFFER_COLUMNS} FROM device_enrolments WHERE user_id = ? AND expires_at > ? AND state <> 'used'`);
  const decide = db.prepare(`UPDATE device_enrolments SET state = ? WHERE user_id = ? AND state = 'requested' AND expires_at > ?`);
  const request = db.prepare(`UPDATE device_enrolments SET state = 'requested', token_hash = ?, requested_at = ?, requester_agent = ?, requester_country = ? WHERE id = ? AND state = 'offered' AND expires_at > ?`);
  const find = db.prepare('SELECT user_id, auth_version, wrapped, state FROM device_enrolments WHERE id = ? AND token_hash = ? AND expires_at > ?');
  const use = db.prepare(`UPDATE device_enrolments SET state = 'used', wrapped = '' WHERE id = ? AND state = 'approved'`);
  const sweep = db.prepare('DELETE FROM device_enrolments WHERE expires_at <= ? OR state = \'used\'');

  return {
    async offer(userId, offer) {
      drop.run(owner(userId));
      insert.run(offer.id, owner(userId), offer.wrapped, offer.authVersion, offer.at, offer.expiresAt);
    },
    async current(userId, now) { return (current.get(owner(userId), now) as EnrolmentOffer | undefined) ?? null; },
    async decide(userId, approve, now) { return decide.run(approve ? 'approved' : 'denied', owner(userId), now).changes > 0; },
    async cancel(userId) { drop.run(owner(userId)); },
    async request(id, tokenHash, who, now) { return request.run(tokenHash, who.at, who.agent, who.country, id, now).changes > 0; },
    async claim(id, tokenHash, now): Promise<EnrolmentClaim> {
      const found = find.get(id, tokenHash, now) as { user_id: string; auth_version: number; wrapped: string; state: string } | undefined;
      if (!found) return { status: 'gone' };
      if (found.state === 'requested') return { status: 'waiting' };
      if (found.state === 'denied') return { status: 'denied' };
      // Both statements run with nothing between them, and the second only moves an approved offer: a second claim finds it used.
      if (found.state !== 'approved' || use.run(id).changes === 0) return { status: 'gone' };
      return { status: 'approved', userId: found.user_id, authVersion: found.auth_version, wrapped: found.wrapped };
    },
    async sweep(now) { return sweep.run(now).changes; },
  };
}

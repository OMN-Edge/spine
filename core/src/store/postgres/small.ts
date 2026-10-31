import type { CookieSessionRepository, EnrolmentClaim, EnrolmentOffer, EnrolmentRepository, SessionRecord, SessionRepository, UsageRepository } from '../types.js';
import { owner } from '../owner.js';
import { changed, many, one, type Query } from './query.js';

const SESSION_COLUMNS = 'id, created_at, last_seen_at, user_agent, address';

/** Every statement filters by `user_id` (SECURITY.md P12). */
export function sessionRepository(q: Query): SessionRepository {
  return {
    async open(userId, s) { await q('INSERT INTO user_sessions (id, user_id, created_at, last_seen_at, user_agent, address) VALUES ($1, $2, $3, $3, $4, $5)', [s.id, owner(userId), s.at, s.userAgent, s.address]); },
    async get(userId, id) { return one<SessionRecord>(q, `SELECT ${SESSION_COLUMNS} FROM user_sessions WHERE user_id = $1 AND id = $2`, [owner(userId), id]); },
    async touch(userId, id, at) { await q('UPDATE user_sessions SET last_seen_at = $1 WHERE user_id = $2 AND id = $3', [at, owner(userId), id]); },
    async list(userId) { return many<SessionRecord>(q, `SELECT ${SESSION_COLUMNS} FROM user_sessions WHERE user_id = $1 ORDER BY last_seen_at DESC`, [owner(userId)]); },
    async revoke(userId, id) { return (await changed(q, 'DELETE FROM user_sessions WHERE user_id = $1 AND id = $2', [owner(userId), id])) > 0; },
    async revokeExcept(userId, keepId) { return changed(q, 'DELETE FROM user_sessions WHERE user_id = $1 AND id IS DISTINCT FROM $2', [owner(userId), keepId]); },
    async prune(userId, startedBefore, idleSince) { return changed(q, 'DELETE FROM user_sessions WHERE user_id = $1 AND (created_at < $2 OR last_seen_at < $3)', [owner(userId), startedBefore, idleSince]); },
    async rememberDevice(userId, deviceHash, at) {
      const id = owner(userId);
      if (await one(q, 'SELECT 1 FROM user_devices WHERE user_id = $1 AND device_hash = $2', [id, deviceHash])) return 'known';
      const had = Number((await one<{ n: number }>(q, 'SELECT COUNT(*) AS n FROM user_devices WHERE user_id = $1', [id]))!.n) > 0;
      await q('INSERT INTO user_devices (user_id, device_hash, first_seen_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [id, deviceHash, at]);
      return had ? 'new' : 'first';
    },
  };
}

/** The seventh exception to P12 (store/types.ts): found by the digest of the cookie's id, before there is an acting user. */
export function cookieSessionRepository(q: Query): CookieSessionRepository {
  return {
    async get(sidHash, now) { return (await one<{ data: string }>(q, 'SELECT data FROM cookie_sessions WHERE sid_hash = $1 AND expires_at > $2', [sidHash, now]))?.data ?? null; },
    async set(sidHash, row) {
      await q(`INSERT INTO cookie_sessions (sid_hash, user_id, data, expires_at) VALUES ($1, $2, $3, $4)
        ON CONFLICT (sid_hash) DO UPDATE SET user_id = excluded.user_id, data = excluded.data, expires_at = excluded.expires_at`, [sidHash, row.userId, row.data, row.expiresAt]);
    },
    async destroy(sidHash) { await q('DELETE FROM cookie_sessions WHERE sid_hash = $1', [sidHash]); },
  };
}

export function usageRepository(q: Query): UsageRepository {
  return {
    async spend(userId, day, limit) {
      const id = owner(userId);
      if (limit <= 0) return null;
      // One statement decides and counts: a row at the limit is not updated, so nothing comes back and two instances cannot both take the last call.
      const row = await one<{ calls: number }>(q, `INSERT INTO model_usage (user_id, day, calls) VALUES ($1, $2, 1)
        ON CONFLICT (user_id, day) DO UPDATE SET calls = model_usage.calls + 1 WHERE model_usage.calls < $3 RETURNING calls`, [id, day, limit]);
      if (!row) return null;
      await q('DELETE FROM model_usage WHERE user_id = $1 AND day < $2', [id, day]);
      return Number(row.calls);
    },
  };
}

const OFFER_COLUMNS = 'id, state, expires_at, requested_at, requester_agent, requester_country';

/**
 * Every statement on the signed-in side filters by `user_id` (SECURITY.md P12). `request` and `claim` are the public side, scoped by the
 * offer's id and the token only the asking browser has (store/types.ts, exception 4). Each step is one statement that checks the state it
 * moves from, so two browsers cannot both be let in by one approval.
 */
export function enrolmentRepository(q: Query): EnrolmentRepository {
  return {
    async offer(userId, offer) {
      await q('DELETE FROM device_enrolments WHERE user_id = $1', [owner(userId)]);
      await q('INSERT INTO device_enrolments (id, user_id, wrapped, auth_version, created_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6)', [offer.id, owner(userId), offer.wrapped, offer.authVersion, offer.at, offer.expiresAt]);
    },
    async current(userId, now) { return one<EnrolmentOffer>(q, `SELECT ${OFFER_COLUMNS} FROM device_enrolments WHERE user_id = $1 AND expires_at > $2 AND state <> 'used'`, [owner(userId), now]); },
    async decide(userId, approve, now) { return (await changed(q, `UPDATE device_enrolments SET state = $1 WHERE user_id = $2 AND state = 'requested' AND expires_at > $3`, [approve ? 'approved' : 'denied', owner(userId), now])) > 0; },
    async cancel(userId) { await q('DELETE FROM device_enrolments WHERE user_id = $1', [owner(userId)]); },
    async request(id, tokenHash, who, now) {
      return (await changed(q, `UPDATE device_enrolments SET state = 'requested', token_hash = $1, requested_at = $2, requester_agent = $3, requester_country = $4 WHERE id = $5 AND state = 'offered' AND expires_at > $6`, [tokenHash, who.at, who.agent, who.country, id, now])) > 0;
    },
    async claim(id, tokenHash, now): Promise<EnrolmentClaim> {
      const found = await one<{ user_id: string; auth_version: number; wrapped: string; state: string }>(q, 'SELECT user_id, auth_version, wrapped, state FROM device_enrolments WHERE id = $1 AND token_hash = $2 AND expires_at > $3', [id, tokenHash, now]);
      if (!found) return { status: 'gone' };
      if (found.state === 'requested') return { status: 'waiting' };
      if (found.state === 'denied') return { status: 'denied' };
      // Only an approved offer moves, and in the statement that moves it: a second claim finds it used.
      if (found.state !== 'approved' || (await changed(q, `UPDATE device_enrolments SET state = 'used', wrapped = '' WHERE id = $1 AND state = 'approved'`, [id])) === 0) return { status: 'gone' };
      return { status: 'approved', userId: found.user_id, authVersion: found.auth_version, wrapped: found.wrapped };
    },
    async sweep(now) { return changed(q, `DELETE FROM device_enrolments WHERE expires_at <= $1 OR state = 'used'`, [now]); },
  };
}

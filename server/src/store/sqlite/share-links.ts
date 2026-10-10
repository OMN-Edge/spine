import type { Database } from 'better-sqlite3';
import { owner } from './owner.js';
import type {
  AccessLogEntry,
  NewShareLink,
  ResolvedShareLink,
  ShareLinkRepository,
  ShareLinkSummary,
} from '../types.js';

/** Every owner-facing statement filters by `user_id` (SECURITY.md P12). */
export function shareLinkRepository(db: Database): ShareLinkRepository {
  // No token column, not even the digest: the owner's list view never showed it
  // and there is no reason to hand a client a capability digest (S-8).
  const list = db.prepare(`
    SELECT id, label, scope, scope_value, created_at, expires_at, revoked,
           view_count, last_accessed_at
    FROM share_links
    WHERE user_id = ?
    ORDER BY created_at DESC
  `);

  const insert = db.prepare(`
    INSERT INTO share_links (id, user_id, token, label, scope, scope_value, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const revoke = db.prepare('UPDATE share_links SET revoked = 1 WHERE id = ? AND user_id = ?');

  // P6: looked up by sha256(token), so possession of the database does not
  // confer usable links.
  const findLive = db.prepare(`
    SELECT id, user_id, scope, scope_value, expires_at
    FROM share_links
    WHERE token = ? AND revoked = 0
  `);

  // The log row carries the link's owner, read from the link itself.
  const insertAccess = db.prepare(`
    INSERT INTO share_link_access_log (user_id, share_link_id, accessed_at, ip_address)
    SELECT user_id, id, ?, ? FROM share_links WHERE id = ?
  `);
  const bumpViewCount = db.prepare(
    'UPDATE share_links SET view_count = view_count + 1, last_accessed_at = ? WHERE id = ?',
  );

  const accessLog = db.prepare(`
    SELECT accessed_at, ip_address FROM share_link_access_log
    WHERE share_link_id = ? AND user_id = ? ORDER BY accessed_at
  `);

  return {
    async listFor(userId) {
      return list.all(owner(userId)) as ShareLinkSummary[];
    },

    async create(userId, link: NewShareLink) {
      insert.run(
        link.id,
        owner(userId),
        link.tokenHash,
        link.label,
        link.scope,
        link.scopeValue,
        link.createdAt,
        link.expiresAt,
      );
    },

    async revoke(userId, id) {
      return revoke.run(id, owner(userId)).changes > 0;
    },

    async findLiveByTokenHash(tokenHash) {
      const row = findLive.get(tokenHash) as
        | { id: string; user_id: string; scope: string; scope_value: string | null; expires_at: string }
        | undefined;
      if (!row) return null;
      if (new Date(row.expires_at) < new Date()) return null;

      const resolved: ResolvedShareLink = {
        id: row.id,
        userId: row.user_id,
        scope: row.scope,
        scopeValue: row.scope_value,
        expiresAt: row.expires_at,
      };
      return resolved;
    },

    async logAccess(linkId, accessedAt, ipAddress, countView) {
      insertAccess.run(accessedAt, ipAddress, linkId);
      if (countView) bumpViewCount.run(accessedAt, linkId);
    },

    async accessLogFor(userId, linkId) {
      return accessLog.all(linkId, owner(userId)) as AccessLogEntry[];
    },
  };
}

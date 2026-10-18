import type { Database } from 'better-sqlite3';
import { owner } from './owner.js';
import type {
  AccessLogEntry,
  NewShareLink,
  ResolvedShareLink,
  ShareLinkRepository,
  ShareLinkSummary,
  AccessSummary,
  ShareLinkEvent,
  ShareLinkPatch,
  ShareRequest,
  ShareRequestState,
} from '../types.js';

/** Every owner-facing statement filters by `user_id` (SECURITY.md P12). */
export function shareLinkRepository(db: Database): ShareLinkRepository {
  // No token column, not even the digest: the owner's list view never showed it
  // and there is no reason to hand a client a capability digest (S-8).
  const list = db.prepare(`
    SELECT id, label, scope, scope_value, created_at, expires_at, revoked,
           view_count, last_accessed_at, include_scans, language, require_approval, allow_chat,
           (SELECT COUNT(*) FROM share_access_requests r
             WHERE r.share_link_id = share_links.id AND r.user_id = share_links.user_id AND r.status = 'pending') AS pending_requests
    FROM share_links
    WHERE user_id = ?
    ORDER BY created_at DESC
  `);

  const insert = db.prepare(`
    INSERT INTO share_links (id, user_id, token, label, scope, scope_value, created_at, expires_at, include_scans, language, require_approval, allow_chat)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const revoke = db.prepare('UPDATE share_links SET revoked = 1 WHERE id = ? AND user_id = ?');

  // P6: looked up by sha256(token), so possession of the database does not
  // confer usable links.
  const findLive = db.prepare(`
    SELECT id, user_id, label, scope, scope_value, expires_at, include_scans, language, require_approval, allow_chat
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

  const findRequest = db.prepare(
    'SELECT id, status FROM share_access_requests WHERE share_link_id = ? AND visitor_hash = ?',
  );
  // The cap is inside the statement, so two requests arriving together cannot both pass the count.
  const insertRequest = db.prepare(`
    INSERT INTO share_access_requests (id, user_id, share_link_id, visitor_hash, note, ip_address, user_agent, requested_at)
    SELECT ?, user_id, id, ?, ?, ?, ?, ? FROM share_links
    WHERE id = ?
      AND (SELECT COUNT(*) FROM share_access_requests WHERE share_link_id = ? AND status = 'pending') < ?
  `);
  const REQUEST_COLUMNS = `r.id, r.share_link_id, l.label AS link_label,
           (l.revoked = 0 AND l.expires_at > ?) AS link_active,
           r.status, r.note, r.ip_address, r.user_agent, r.requested_at, r.decided_at`;
  const listRequests = db.prepare(`
    SELECT ${REQUEST_COLUMNS}
    FROM share_access_requests r JOIN share_links l ON l.id = r.share_link_id AND l.user_id = r.user_id
    WHERE r.user_id = ?
    ORDER BY (r.status = 'pending') DESC, r.requested_at DESC
    LIMIT 100
  `);
  const listRequestsOfLink = db.prepare(`
    SELECT ${REQUEST_COLUMNS}
    FROM share_access_requests r JOIN share_links l ON l.id = r.share_link_id AND l.user_id = r.user_id
    WHERE r.user_id = ? AND r.share_link_id = ?
    ORDER BY r.requested_at DESC
    LIMIT 100
  `);

  const event = db.prepare('INSERT INTO share_link_events (user_id, share_link_id, at, kind, detail) VALUES (?, ?, ?, ?, ?)');
  const events = db.prepare('SELECT at, kind, detail FROM share_link_events WHERE share_link_id = ? AND user_id = ? ORDER BY at DESC, id DESC LIMIT ?');
  const one = db.prepare(`
    SELECT id, label, scope, scope_value, created_at, expires_at, revoked, view_count, last_accessed_at, include_scans, language, require_approval, allow_chat,
           (SELECT COUNT(*) FROM share_access_requests r WHERE r.share_link_id = share_links.id AND r.user_id = share_links.user_id AND r.status = 'pending') AS pending_requests
    FROM share_links WHERE id = ? AND user_id = ?
  `);
  const current = db.prepare('SELECT label, scope, scope_value, expires_at, revoked, include_scans, language, require_approval, allow_chat FROM share_links WHERE id = ? AND user_id = ?');
  const write = db.prepare(`
    UPDATE share_links SET label = ?, scope = ?, scope_value = ?, expires_at = ?, include_scans = ?, language = ?, require_approval = ?, allow_chat = ?
    WHERE id = ? AND user_id = ?
  `);
  const clearRequests = db.prepare('DELETE FROM share_access_requests WHERE share_link_id = ? AND user_id = ?');
  const accessTotals = db.prepare('SELECT COUNT(*) AS total, MIN(accessed_at) AS first_at, MAX(accessed_at) AS last_at FROM share_link_access_log WHERE share_link_id = ? AND user_id = ?');
  const accessByAddress = db.prepare(`
    SELECT ip_address, COUNT(*) AS count, MAX(accessed_at) AS last_at FROM share_link_access_log
    WHERE share_link_id = ? AND user_id = ? GROUP BY ip_address ORDER BY count DESC, last_at DESC LIMIT 20
  `);
  const accessRecent = db.prepare('SELECT accessed_at, ip_address FROM share_link_access_log WHERE share_link_id = ? AND user_id = ? ORDER BY accessed_at DESC, id DESC LIMIT 50');
  const updateTx = db.transaction((uid: string, id: string, patch: ShareLinkPatch, at: string): 'ok' | 'not_found' | 'revoked' => {
    const row = current.get(id, uid) as { label: string | null; scope: string; scope_value: string | null; expires_at: string; revoked: number; include_scans: number; language: string | null; require_approval: number; allow_chat: number } | undefined;
    if (!row) return 'not_found';
    if (row.revoked) return 'revoked';
    const next = {
      label: patch.label !== undefined ? patch.label : row.label,
      scope: patch.scope ?? row.scope,
      scopeValue: patch.scope !== undefined || patch.scopeValue !== undefined ? patch.scopeValue ?? null : row.scope_value,
      expiresAt: patch.expiresAt ?? row.expires_at,
      includeScans: patch.includeScans ?? !!row.include_scans,
      language: patch.language !== undefined ? patch.language : row.language,
      requireApproval: patch.requireApproval ?? !!row.require_approval,
      allowChat: patch.allowChat ?? !!row.allow_chat,
    };
    // Small values only: what the setting was and is. The documents of a shared set are counted, never listed.
    const count = (scopeValue: string | null) => { try { const v = scopeValue ? JSON.parse(scopeValue) : null; return Array.isArray(v) ? v.length : null; } catch { return null; } };
    const changes: Array<{ field: string; from: unknown; to: unknown }> = [];
    const diff = (field: string, from: unknown, to: unknown) => { if (from !== to) changes.push({ field, from, to }); };
    diff('label', row.label, next.label);
    diff('expires_at', row.expires_at, next.expiresAt);
    diff('include_scans', !!row.include_scans, next.includeScans);
    diff('require_approval', !!row.require_approval, next.requireApproval);
    diff('allow_chat', !!row.allow_chat, next.allowChat);
    diff('language', row.language, next.language);
    if (row.scope !== next.scope || row.scope_value !== next.scopeValue) {
      changes.push({ field: 'scope', from: row.scope === 'document_ids' ? `${count(row.scope_value) ?? 0} documents` : row.scope, to: next.scope === 'document_ids' ? `${count(next.scopeValue) ?? 0} documents` : next.scope });
    }
    if (changes.length === 0) return 'ok';
    write.run(next.label, next.scope, next.scopeValue, next.expiresAt, next.includeScans ? 1 : 0, next.language, next.requireApproval ? 1 : 0, next.allowChat ? 1 : 0, id, uid);
    // Approval switched on: whoever was approved under the old setting asks again.
    if (next.requireApproval && !row.require_approval) clearRequests.run(id, uid);
    event.run(uid, id, at, 'changed', JSON.stringify({ changes }));
    return 'ok';
  });
  const getRequest = db.prepare(`
    SELECT ${REQUEST_COLUMNS}
    FROM share_access_requests r JOIN share_links l ON l.id = r.share_link_id AND l.user_id = r.user_id
    WHERE r.user_id = ? AND r.id = ?
  `);
  const decide = db.prepare('UPDATE share_access_requests SET status = ?, decided_at = ? WHERE id = ? AND user_id = ?');
  const toRequest = (row: Record<string, unknown>): ShareRequest => ({ ...(row as unknown as ShareRequest), link_active: !!row.link_active });

  return {
    async listFor(userId) {
      // SQLite keeps the flags as 0 or 1.
      return (list.all(owner(userId)) as Array<Omit<ShareLinkSummary, 'include_scans' | 'require_approval' | 'allow_chat'> & { include_scans: number; require_approval: number; allow_chat: number }>).map(row => ({
        ...row,
        include_scans: !!row.include_scans,
        require_approval: !!row.require_approval,
        allow_chat: !!row.allow_chat,
      }));
    },

    async create(userId, link: NewShareLink) {
      db.transaction(() => {
      insert.run(
        link.id,
        owner(userId),
        link.tokenHash,
        link.label,
        link.scope,
        link.scopeValue,
        link.createdAt,
        link.expiresAt,
        link.includeScans ? 1 : 0,
        link.language,
        link.requireApproval ? 1 : 0,
        link.allowChat ? 1 : 0,
      );
      event.run(owner(userId), link.id, link.createdAt, 'created', null);
      })();
    },

    async revoke(userId, id) {
      return db.transaction(() => {
        const changed = revoke.run(id, owner(userId)).changes > 0;
        if (changed) event.run(owner(userId), id, new Date().toISOString(), 'revoked', null);
        return changed;
      })();
    },

    async findLiveByTokenHash(tokenHash) {
      const row = findLive.get(tokenHash) as
        | { id: string; user_id: string; label: string | null; scope: string; scope_value: string | null; expires_at: string; include_scans: number; language: string | null; require_approval: number; allow_chat: number }
        | undefined;
      if (!row) return null;
      if (new Date(row.expires_at) < new Date()) return null;

      const resolved: ResolvedShareLink = {
        id: row.id,
        userId: row.user_id,
        label: row.label,
        scope: row.scope,
        scopeValue: row.scope_value,
        expiresAt: row.expires_at,
        includeScans: !!row.include_scans,
        language: row.language,
        requireApproval: !!row.require_approval,
        allowChat: !!row.allow_chat,
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

    async findRequest(linkId, visitorHash) {
      return (findRequest.get(linkId, visitorHash) as ShareRequestState | undefined) ?? null;
    },

    async createRequest(linkId, r, maxPending) {
      return insertRequest.run(r.id, r.visitorHash, r.note, r.ipAddress, r.userAgent, r.requestedAt, linkId, linkId, maxPending).changes > 0;
    },

    async listRequests(userId, now, linkId) {
      const rows = linkId ? listRequestsOfLink.all(now, owner(userId), linkId) : listRequests.all(now, owner(userId));
      return (rows as Array<Record<string, unknown>>).map(toRequest);
    },

    async getRequest(userId, id, now) {
      const row = getRequest.get(now, owner(userId), id) as Record<string, unknown> | undefined;
      return row ? toRequest(row) : null;
    },

    async decideRequest(userId, id, status, at) {
      return db.transaction(() => {
        const row = db.prepare('SELECT share_link_id FROM share_access_requests WHERE id = ? AND user_id = ?').get(id, owner(userId)) as { share_link_id: string } | undefined;
        const changed = decide.run(status, at, id, owner(userId)).changes > 0;
        if (changed && row) event.run(owner(userId), row.share_link_id, at, status === 'approved' ? 'approved' : 'denied', JSON.stringify({ request: id }));
        return changed;
      })();
    },

    async findFor(userId, id) {
      const row = one.get(id, owner(userId)) as (Omit<ShareLinkSummary, 'include_scans' | 'require_approval' | 'allow_chat' | 'revoked'> & { include_scans: number; require_approval: number; allow_chat: number; revoked: number }) | undefined;
      return row ? { ...row, include_scans: !!row.include_scans, require_approval: !!row.require_approval, allow_chat: !!row.allow_chat, revoked: !!row.revoked } : null;
    },

    async update(userId, id, patch, at) {
      return updateTx(owner(userId), id, patch, at);
    },

    async accessSummary(userId, linkId) {
      const uid = owner(userId);
      const totals = accessTotals.get(linkId, uid) as { total: number; first_at: string | null; last_at: string | null };
      return {
        ...totals,
        addresses: accessByAddress.all(linkId, uid) as AccessSummary['addresses'],
        recent: accessRecent.all(linkId, uid) as AccessSummary['recent'],
      };
    },

    async eventsFor(userId, linkId, limit) {
      return events.all(linkId, owner(userId), limit) as ShareLinkEvent[];
    },
  };
}

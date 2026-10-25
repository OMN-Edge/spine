import type { Database } from './driver.js';
import type { SharedBundle, SharedOpen, SharedRepository, SharedRequest } from '../types.js';

const bundleOf = (r: Record<string, unknown>): SharedBundle => ({
  id: r.id as string,
  userId: r.user_id as string,
  createdAt: r.created_at as string,
  expiresAt: r.expires_at as string,
  requireApproval: r.require_approval === 1,
  size: r.size as number,
  blobs: r.blobs as number,
  blobBytes: r.blob_bytes as number,
  revokedAt: (r.revoked_at as string | null) ?? null,
});

const requestOf = (r: Record<string, unknown>): SharedRequest => ({
  id: r.id as string,
  bundleId: r.bundle_id as string,
  visitorKey: r.visitor_key as string,
  status: r.status as SharedRequest['status'],
  wrappedKey: (r.wrapped_key as string | null) ?? null,
  note: (r.note as string | null) ?? null,
  country: (r.country as string | null) ?? null,
  requestedAt: r.requested_at as string,
  decidedAt: (r.decided_at as string | null) ?? null,
});

const BUNDLE = 'id, user_id, created_at, expires_at, require_approval, size, blobs, blob_bytes, revoked_at';
const REQUEST = 'id, bundle_id, visitor_key, status, wrapped_key, note, country, requested_at, decided_at';

export function sharedRepository(db: Database): SharedRepository {
  const get = db.prepare(`SELECT ${BUNDLE} FROM shared_bundles WHERE id = ?`);
  const insert = db.prepare('INSERT INTO shared_bundles (id, user_id, created_at, expires_at, require_approval, size, blobs, blob_bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const replace = db.prepare('UPDATE shared_bundles SET expires_at = ?, require_approval = ?, size = ?, blobs = ?, blob_bytes = ? WHERE id = ? AND user_id = ?');
  const usage = db.prepare('SELECT COUNT(*) AS bundles, COALESCE(SUM(size + blob_bytes), 0) AS bytes FROM shared_bundles WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?');
  const dropKeys = db.prepare("UPDATE shared_requests SET wrapped_key = NULL WHERE bundle_id = ?");
  const waiting = db.prepare("SELECT COUNT(*) AS n FROM shared_requests WHERE bundle_id = ? AND status = 'pending'");
  const byVisitor = db.prepare(`SELECT ${REQUEST} FROM shared_requests WHERE bundle_id = ? AND visitor_key = ?`);

  const putTx = db.transaction((userId: string, b: Parameters<SharedRepository['put']>[1], now: string) => {
    const have = get.get(b.id) as Record<string, unknown> | undefined;
    if (!have) { insert.run(b.id, userId, now, b.expiresAt, b.requireApproval ? 1 : 0, b.size, b.blobs, b.blobBytes); return 'ok' as const; }
    if (have.user_id !== userId) return 'taken' as const;
    if (have.revoked_at) return 'revoked' as const;
    replace.run(b.expiresAt, b.requireApproval ? 1 : 0, b.size, b.blobs, b.blobBytes, b.id, userId);
    return 'ok' as const;
  });

  const revokeTx = db.transaction((userId: string, id: string, now: string) => {
    const have = get.get(id) as Record<string, unknown> | undefined;
    if (!have || have.user_id !== userId || have.revoked_at) return false;
    db.prepare('UPDATE shared_bundles SET revoked_at = ? WHERE id = ?').run(now, id);
    dropKeys.run(id);
    return true;
  });

  const endedTx = db.transaction((now: string) => {
    const rows = db.prepare('SELECT id, user_id FROM shared_bundles WHERE (size > 0 OR blobs > 0) AND (revoked_at IS NOT NULL OR expires_at <= ?)').all(now) as Array<{ id: string; user_id: string }>;
    for (const r of rows) {
      dropKeys.run(r.id);
      db.prepare('UPDATE shared_bundles SET size = 0, blobs = 0, blob_bytes = 0 WHERE id = ?').run(r.id);
    }
    return rows.map(r => ({ id: r.id, userId: r.user_id }));
  });

  return {
    async get(id) {
      const r = get.get(id) as Record<string, unknown> | undefined;
      return r ? bundleOf(r) : null;
    },
    async put(userId, bundle, now) {
      return putTx(userId, bundle, now);
    },
    async addBlob(userId, id, bytes) {
      return db.prepare('UPDATE shared_bundles SET blobs = blobs + 1, blob_bytes = blob_bytes + ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL').run(bytes, id, userId).changes === 1;
    },
    async update(userId, id, patch) {
      const have = get.get(id) as Record<string, unknown> | undefined;
      if (!have || have.user_id !== userId || have.revoked_at) return false;
      db.prepare('UPDATE shared_bundles SET expires_at = ?, require_approval = ? WHERE id = ?').run(patch.expiresAt ?? have.expires_at, (patch.requireApproval ?? have.require_approval === 1) ? 1 : 0, id);
      return true;
    },
    async revoke(userId, id, now) {
      return revokeTx(userId, id, now);
    },
    async usage(userId, now) {
      return usage.get(userId, now) as { bundles: number; bytes: number };
    },
    async endedWithFiles(now) {
      return endedTx(now);
    },
    async forgetEnded(now, graceMs) {
      const cutoff = new Date(Date.parse(now) - graceMs).toISOString();
      const ids = (db.prepare('SELECT id FROM shared_bundles WHERE (revoked_at IS NOT NULL AND revoked_at < ?) OR expires_at < ?').all(cutoff, cutoff) as Array<{ id: string }>).map(r => r.id);
      for (const id of ids) for (const t of ['shared_requests', 'shared_opens']) db.prepare(`DELETE FROM ${t} WHERE bundle_id = ?`).run(id);
      for (const id of ids) db.prepare('DELETE FROM shared_bundles WHERE id = ?').run(id);
      return ids.length;
    },
    async eraseFor(userId) {
      const ids = (db.prepare('SELECT id FROM shared_bundles WHERE user_id = ?').all(userId) as Array<{ id: string }>).map(r => r.id);
      for (const t of ['shared_requests', 'shared_opens', 'shared_bundles']) db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(userId);
      return ids;
    },

    async createRequest(bundleId, r, maxWaiting) {
      const known = byVisitor.get(bundleId, r.visitorKey) as Record<string, unknown> | undefined;
      if (known) return 'known';
      if ((waiting.get(bundleId) as { n: number }).n >= maxWaiting) return 'waiting';
      const owner = (get.get(bundleId) as Record<string, unknown> | undefined)?.user_id as string | undefined;
      if (!owner) return 'waiting';
      db.prepare('INSERT INTO shared_requests (id, bundle_id, user_id, visitor_key, note, country, requested_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(r.id, bundleId, owner, r.visitorKey, r.note, r.country, r.requestedAt);
      return requestOf(db.prepare(`SELECT ${REQUEST} FROM shared_requests WHERE id = ?`).get(r.id) as Record<string, unknown>);
    },
    async getRequest(bundleId, id) {
      const r = db.prepare(`SELECT ${REQUEST} FROM shared_requests WHERE bundle_id = ? AND id = ?`).get(bundleId, id) as Record<string, unknown> | undefined;
      return r ? requestOf(r) : null;
    },
    async pendingRequests(userId) {
      return (db.prepare(`SELECT ${REQUEST} FROM shared_requests WHERE user_id = ? AND pulled = 0 ORDER BY requested_at`).all(userId) as Array<Record<string, unknown>>).map(requestOf);
    },
    async ackRequests(userId, ids) {
      for (const id of ids) db.prepare('UPDATE shared_requests SET pulled = 1 WHERE user_id = ? AND id = ?').run(userId, id);
    },
    async decide(userId, id, status, wrappedKey, now) {
      const r = db.prepare("UPDATE shared_requests SET status = ?, wrapped_key = ?, decided_at = ? WHERE user_id = ? AND id = ? AND status = 'pending' AND bundle_id IN (SELECT id FROM shared_bundles WHERE revoked_at IS NULL AND expires_at > ?)").run(status, status === 'approved' ? wrappedKey : null, now, userId, id, now);
      return r.changes === 1;
    },

    async logOpen(bundleId, at, country, documentId, countView) {
      const owner = (get.get(bundleId) as Record<string, unknown> | undefined)?.user_id as string | undefined;
      if (!owner) return;
      db.prepare('INSERT INTO shared_opens (bundle_id, user_id, at, country, document_id, count_view) VALUES (?, ?, ?, ?, ?, ?)').run(bundleId, owner, at, country, documentId, countView ? 1 : 0);
    },
    async pendingOpens(userId, limit) {
      return (db.prepare('SELECT id, bundle_id, at, country, document_id, count_view FROM shared_opens WHERE user_id = ? ORDER BY id LIMIT ?').all(userId, limit) as Array<Record<string, unknown>>).map((r): SharedOpen => ({
        id: r.id as number, bundleId: r.bundle_id as string, at: r.at as string, country: (r.country as string | null) ?? null, documentId: (r.document_id as string | null) ?? null, countView: r.count_view === 1,
      }));
    },
    async ackOpens(userId, ids) {
      for (const id of ids) db.prepare('DELETE FROM shared_opens WHERE user_id = ? AND id = ?').run(userId, id);
    },
  };
}

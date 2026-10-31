import type { SharedBundle, SharedOpen, SharedRepository, SharedRequest } from '../types.js';
import { changed, many, one, type Begin, type Query } from './query.js';

const bundleOf = (r: Record<string, unknown>): SharedBundle => ({
  id: r.id as string,
  userId: r.user_id as string,
  createdAt: r.created_at as string,
  expiresAt: r.expires_at as string,
  requireApproval: r.require_approval === 1,
  size: Number(r.size),
  blobs: Number(r.blobs),
  blobBytes: Number(r.blob_bytes),
  revokedAt: (r.revoked_at as string | null) ?? null,
  kind: r.kind === 'card' ? 'card' : 'share',
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

const BUNDLE = 'id, user_id, created_at, expires_at, require_approval, size, blobs, blob_bytes, revoked_at, kind';
const REQUEST = 'id, bundle_id, visitor_key, status, wrapped_key, note, country, requested_at, decided_at';

export function sharedRepository(q: Query, begin: Begin): SharedRepository {
  const bundle = (run: Query, id: string, lock = false) => one(run, `SELECT ${BUNDLE} FROM shared_bundles WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);

  return {
    async get(id) {
      const r = await bundle(q, id);
      return r ? bundleOf(r) : null;
    },

    async put(userId, b, now) {
      return begin(async run => {
        const have = await bundle(run, b.id, true);
        if (!have) {
          // One emergency card at a time: a new one is made after the old one is revoked.
          if (b.kind === 'card' && (await one(run, `SELECT 1 FROM shared_bundles WHERE user_id = $1 AND kind = 'card' AND revoked_at IS NULL FOR UPDATE`, [userId]))) return 'one_card' as const;
          await run('INSERT INTO shared_bundles (id, user_id, created_at, expires_at, require_approval, size, blobs, blob_bytes, kind) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)', [b.id, userId, now, b.expiresAt, b.requireApproval ? 1 : 0, b.size, b.blobs, b.blobBytes, b.kind ?? 'share']);
          return 'ok' as const;
        }
        if (have.user_id !== userId) return 'taken' as const;
        if (have.revoked_at) return 'revoked' as const;
        await run('UPDATE shared_bundles SET expires_at = $1, require_approval = $2, size = $3, blobs = $4, blob_bytes = $5 WHERE id = $6 AND user_id = $7', [b.expiresAt, b.requireApproval ? 1 : 0, b.size, b.blobs, b.blobBytes, b.id, userId]);
        return 'ok' as const;
      });
    },

    async cardOf(userId) {
      const r = await one(q, `SELECT ${BUNDLE} FROM shared_bundles WHERE user_id = $1 AND kind = 'card' AND revoked_at IS NULL`, [userId]);
      return r ? bundleOf(r) : null;
    },

    async addBlob(userId, id, bytes) {
      return (await changed(q, 'UPDATE shared_bundles SET blobs = blobs + 1, blob_bytes = blob_bytes + $1 WHERE id = $2 AND user_id = $3 AND revoked_at IS NULL', [bytes, id, userId])) === 1;
    },

    async update(userId, id, patch) {
      return begin(async run => {
        const have = await bundle(run, id, true);
        if (!have || have.user_id !== userId || have.revoked_at) return false;
        await run('UPDATE shared_bundles SET expires_at = $1, require_approval = $2 WHERE id = $3', [patch.expiresAt ?? have.expires_at, (patch.requireApproval ?? have.require_approval === 1) ? 1 : 0, id]);
        return true;
      });
    },

    async revoke(userId, id, now) {
      return begin(async run => {
        const have = await bundle(run, id, true);
        if (!have || have.user_id !== userId || have.revoked_at) return false;
        await run('UPDATE shared_bundles SET revoked_at = $1 WHERE id = $2', [now, id]);
        await run('UPDATE shared_requests SET wrapped_key = NULL WHERE bundle_id = $1', [id]);
        return true;
      });
    },

    async usage(userId, now) {
      const row = (await one<{ bundles: number; bytes: number }>(q, "SELECT COUNT(*) AS bundles, COALESCE(SUM(size + blob_bytes), 0) AS bytes FROM shared_bundles WHERE user_id = $1 AND kind = 'share' AND revoked_at IS NULL AND expires_at > $2", [userId, now]))!;
      return { bundles: Number(row.bundles), bytes: Number(row.bytes) };
    },

    async endedWithFiles(now) {
      return begin(async run => {
        const rows = await many<{ id: string; user_id: string }>(run, 'SELECT id, user_id FROM shared_bundles WHERE (size > 0 OR blobs > 0) AND (revoked_at IS NOT NULL OR expires_at <= $1)', [now]);
        for (const r of rows) {
          await run('UPDATE shared_requests SET wrapped_key = NULL WHERE bundle_id = $1', [r.id]);
          await run('UPDATE shared_bundles SET size = 0, blobs = 0, blob_bytes = 0 WHERE id = $1', [r.id]);
        }
        return rows.map(r => ({ id: r.id, userId: r.user_id }));
      });
    },

    async forgetEnded(now, graceMs) {
      const cutoff = new Date(Date.parse(now) - graceMs).toISOString();
      return begin(async run => {
        const ids = (await many<{ id: string }>(run, 'SELECT id FROM shared_bundles WHERE (revoked_at IS NOT NULL AND revoked_at < $1) OR expires_at < $1', [cutoff])).map(r => r.id);
        for (const id of ids) for (const t of ['shared_requests', 'shared_opens']) await run(`DELETE FROM ${t} WHERE bundle_id = $1`, [id]);
        for (const id of ids) await run('DELETE FROM shared_bundles WHERE id = $1', [id]);
        return ids.length;
      });
    },

    async eraseFor(userId) {
      return begin(async run => {
        const ids = (await many<{ id: string }>(run, 'SELECT id FROM shared_bundles WHERE user_id = $1', [userId])).map(r => r.id);
        for (const t of ['shared_requests', 'shared_opens', 'shared_bundles']) await run(`DELETE FROM ${t} WHERE user_id = $1`, [userId]);
        return ids;
      });
    },

    async createRequest(bundleId, r, maxWaiting) {
      return begin(async run => {
        // The bundle is locked so that two visitors cannot both take the last place under the ceiling.
        const have = await bundle(run, bundleId, true);
        if (await one(run, 'SELECT 1 FROM shared_requests WHERE bundle_id = $1 AND visitor_key = $2', [bundleId, r.visitorKey])) return 'known' as const;
        const waiting = Number((await one<{ n: number }>(run, `SELECT COUNT(*) AS n FROM shared_requests WHERE bundle_id = $1 AND status = 'pending'`, [bundleId]))!.n);
        if (waiting >= maxWaiting || !have) return 'waiting' as const;
        await run('INSERT INTO shared_requests (id, bundle_id, user_id, visitor_key, note, country, requested_at) VALUES ($1, $2, $3, $4, $5, $6, $7)', [r.id, bundleId, have.user_id, r.visitorKey, r.note, r.country, r.requestedAt]);
        return requestOf((await one(run, `SELECT ${REQUEST} FROM shared_requests WHERE id = $1`, [r.id]))!);
      });
    },

    async getRequest(bundleId, id) {
      const r = await one(q, `SELECT ${REQUEST} FROM shared_requests WHERE bundle_id = $1 AND id = $2`, [bundleId, id]);
      return r ? requestOf(r) : null;
    },

    async pendingRequests(userId) {
      return (await many(q, `SELECT ${REQUEST} FROM shared_requests WHERE user_id = $1 AND pulled = 0 ORDER BY requested_at`, [userId])).map(requestOf);
    },

    async ackRequests(userId, ids) {
      for (const id of ids) await q('UPDATE shared_requests SET pulled = 1 WHERE user_id = $1 AND id = $2', [userId, id]);
    },

    async decide(userId, id, status, wrappedKey, now) {
      return (await changed(q, `UPDATE shared_requests SET status = $1, wrapped_key = $2, decided_at = $3 WHERE user_id = $4 AND id = $5 AND status = 'pending'
        AND bundle_id IN (SELECT id FROM shared_bundles WHERE revoked_at IS NULL AND expires_at > $3)`, [status, status === 'approved' ? wrappedKey : null, now, userId, id])) === 1;
    },

    async logOpen(bundleId, at, country, documentId, countView) {
      const have = await bundle(q, bundleId);
      if (!have) return;
      await q('INSERT INTO shared_opens (bundle_id, user_id, at, country, document_id, count_view) VALUES ($1, $2, $3, $4, $5, $6)', [bundleId, have.user_id, at, country, documentId, countView ? 1 : 0]);
    },

    async pendingOpens(userId, limit) {
      return (await many(q, 'SELECT id, bundle_id, at, country, document_id, count_view FROM shared_opens WHERE user_id = $1 ORDER BY id LIMIT $2', [userId, limit])).map((r): SharedOpen => ({
        id: Number(r.id), bundleId: r.bundle_id as string, at: r.at as string, country: (r.country as string | null) ?? null, documentId: (r.document_id as string | null) ?? null, countView: r.count_view === 1,
      }));
    },

    async ackOpens(userId, ids) {
      for (const id of ids) await q('DELETE FROM shared_opens WHERE user_id = $1 AND id = $2', [userId, id]);
    },
  };
}

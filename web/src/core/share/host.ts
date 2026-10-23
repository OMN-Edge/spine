import fs from 'fs';
import { Buffer } from 'buffer';
import { WasmDatabase } from '../sqlite-wasm';
import { openDatabase } from '../../../../server/src/store/sqlite/connection';
import { copySlice } from '../../../../server/src/store/sqlite/slice';
import { hashShareToken } from '../../../../server/src/share-token';
import type { Store } from '../../../../server/src/store/types';
import type { ShareHost } from '../../../../server/src/share-host';
import { newShareKey, sealPart, wrapShareKey } from './keys';

/** The fixed address the recipient's own core answers to: it serves one share, so the name does not matter. */
export const LOCAL_SHARE_TOKEN = 'local';

/** Where a page's image is inside a share's file system: the number is its sealed file's number at the server. */
export const SHARE_IMAGE = (n: number) => `/share/pages/${n}.png`;

async function call(method: string, url: string, init: { headers?: Record<string, string>; body?: BodyInit; ok404?: boolean } = {}): Promise<Response> {
  const res = await fetch(url, { method, headers: init.headers, body: init.body });
  if (res.ok || (init.ok404 && res.status === 404)) return res;
  const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  throw Object.assign(new Error(body.error ?? `the server answered ${res.status}`), { status: res.status, code: body.code });
}

/**
 * What the owner's device does for a share: makes the copy (the allow-list slice of its own database), seals it, sends it, collects what
 * visitors did, and answers a browser that asks to be let in. The route files (`routes/share.ts`) call this; nothing here is sent to the
 * server unsealed except the end time and the approval setting.
 */
export function createShareHost(deps: { source: WasmDatabase; schema: string; store: () => Store; mail: () => boolean }): ShareHost {
  return {
    async publish({ link, userId, documentIds, newKey }) {
      const store = deps.store();
      const have = newKey ? null : await store.shareLinks.keyFor(userId, link.id);
      const key = have ?? (await newShareKey());

      const dest = new WasmDatabase();
      try {
        openDatabase(':memory:', () => dest, deps.schema);
        let next = 0;
        const result = copySlice(deps.source, dest, {
          userId, documentIds, includeText: link.allow_chat, includeScans: link.include_scans, tokenHash: hashShareToken(LOCAL_SHARE_TOKEN),
          link: { id: link.id, label: link.label, createdAt: link.created_at, expiresAt: link.expires_at, language: link.language, allowChat: link.allow_chat },
          imagePathOf: () => SHARE_IMAGE(next++),
        });
        const sealed = await sealPart(key, link.id, 'db', dest.export());
        await call('PUT', `/api/shared/${encodeURIComponent(link.id)}`, {
          headers: { 'content-type': 'application/octet-stream', 'x-spine-expires': new Date(link.expires_at).toISOString(), 'x-spine-approval': link.require_approval ? '1' : '0' },
          body: sealed as BodyInit,
        });
        for (const [n, image] of result.images.entries()) {
          const bytes = new Uint8Array(fs.readFileSync(image.from) as Buffer);
          await call('PUT', `/api/shared/${encodeURIComponent(link.id)}/blob/${n}`, {
            headers: { 'content-type': 'application/octet-stream' },
            body: (await sealPart(key, link.id, `blob-${n}`, bytes)) as BodyInit,
          });
        }
      } finally {
        dest.close();
      }
      return { key };
    },

    async update(link) {
      await call('PATCH', `/api/shared/${encodeURIComponent(link.id)}`, {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expires_at: new Date(link.expiresAt).toISOString(), require_approval: link.requireApproval }),
      });
    },

    async revoke(linkId) {
      await call('DELETE', `/api/shared/${encodeURIComponent(linkId)}`, { ok404: true });
    },

    async pull(userId) {
      const store = deps.store();
      const events = (await (await call('GET', '/api/shared/events')).json()) as {
        requests: Array<{ id: string; bundleId: string; visitorKey: string; note: string | null; country: string | null; requestedAt: string }>;
        opens: Array<{ id: number; bundleId: string; at: string; country: string | null; documentId: string | null; countView: boolean }>;
      };
      for (const r of events.requests) {
        // A request for a link this device no longer has (deleted) is not kept; the visitor's key stands in for the cookie's digest.
        if (!(await store.shareLinks.findFor(userId, r.bundleId))) continue;
        await store.shareLinks.createRequest(r.bundleId, { id: r.id, visitorHash: r.visitorKey, note: r.note, ipAddress: r.country, userAgent: null, requestedAt: r.requestedAt }, 50);
      }
      for (const o of events.opens) {
        if (!(await store.shareLinks.findFor(userId, o.bundleId))) continue;
        await store.shareLinks.logAccess(o.bundleId, o.at, null, o.countView, { country: o.country, documentId: o.documentId });
      }
      if (events.requests.length > 0 || events.opens.length > 0) {
        await call('POST', '/api/shared/events/ack', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requests: events.requests.map(r => r.id), opens: events.opens.map(o => o.id) }) });
      }
    },

    async answer(_userId, request, decision, shareKey) {
      const approved = decision === 'approve';
      await call('POST', `/api/shared/requests/${encodeURIComponent(request.id)}/decision`, {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(approved ? { decision: 'approved', wrapped_key: await wrapShareKey(shareKey!, request.visitorKey) } : { decision: 'denied' }),
      });
    },

    mailsOwner: deps.mail,
    addressOf: (linkId, key) => `${self.location.origin}/share/${linkId}${key ? `#${key}` : ''}`,
  };
}

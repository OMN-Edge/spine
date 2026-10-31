import fs from '../shims/fs';
import { Buffer } from 'buffer';
import type { Store } from 'spine-core/store/types';
import type { ShareHost } from 'spine-core/share-host';
import { sodium } from '../../crypto/sodium';
import { newShareKey, sealPart, wrapShareKey } from './keys';

/** The fixed address the recipient's own core answers to: it serves one share, so the name does not matter. */

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
export function createShareHost(deps: { store: () => Store; mail: () => boolean }): ShareHost {
  return {
    async publish({ link, userId, documentIds, newKey, unlessUnchanged }) {
      const store = deps.store();
      const have = newKey ? null : await store.shareLinks.keyFor(userId, link.id);
      // A link that follows the records only ever uses the key it was made with: a new one would stop the address opening.
      if (unlessUnchanged && !have) return { key: '', published: false, digest: '' };
      const key = have ?? (await newShareKey());

      let digest = '';
      // The copy is built by the store, in a store of its own, and leaves it as changes: the form in which records travel, not a database file.
      let next = 0;
      const result = await store.slice({
        userId, documentIds, includeText: link.allow_chat, includeScans: link.include_scans,
        link: { id: link.id, label: link.label, createdAt: link.created_at, expiresAt: link.expires_at, language: link.language, allowChat: link.allow_chat },
        imagePathOf: () => SHARE_IMAGE(next++),
      });
      const changes = result.changes;
      // A keyed hash of what the copy holds (without the clocks, which differ every time it is made), so that a copy that would be the
      // same is not sent again. The key makes it useless to anyone who sees it beside the sealed copy.
      const s = await sodium();
      const canonical = changes.map(c => JSON.stringify([c.t, c.k, c.r])).sort().join('\n') + '\n' + result.images.map(i => `${i.pageId}:${fs.statSync(i.from).size}`).sort().join(',') + `\n${link.label}|${link.expires_at}|${link.language}|${link.allow_chat}|${link.include_scans}`;
      digest = s.to_base64(s.crypto_generichash(24, new TextEncoder().encode(canonical), s.from_base64(key, s.base64_variants.URLSAFE_NO_PADDING)), s.base64_variants.URLSAFE_NO_PADDING);
      if (unlessUnchanged && !newKey && have && (await store.shareLinks.copyDigest(userId, link.id)) === digest) return { key, published: false, digest };
      const sealed = await sealPart(key, link.id, 'records', new TextEncoder().encode(JSON.stringify({ v: 1, owner: userId, changes })));
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
      return { key, published: true, digest };
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
      const card = await store.emergency.get(userId);
      for (const o of events.opens) {
        // The emergency card is opened without a link of the owner's: each opening of it is a scan, kept with the card.
        if (card?.card_id === o.bundleId) {
          if (!o.countView) await store.emergency.addScan(userId, { id: `scan-${o.id}-${o.bundleId.slice(0, 8)}`, at: o.at, country: o.country });
          continue;
        }
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

    async publishCard({ id, key, content }) {
      const cardId = id ?? crypto.randomUUID();
      const cardKey = key ?? (await newShareKey());
      // Sealed under a key of its own that only the owner's device and the address it hands out hold; the server stores bytes it cannot open.
      const sealed = await sealPart(cardKey, cardId, 'card', new TextEncoder().encode(content));
      await call('PUT', `/api/shared/${encodeURIComponent(cardId)}`, { headers: { 'content-type': 'application/octet-stream', 'x-spine-kind': 'card' }, body: sealed as BodyInit });
      return { id: cardId, key: cardKey };
    },

    async reviewCard(id) {
      await call('POST', `/api/shared/${encodeURIComponent(id)}/review`, { ok404: true });
    },

    async revokeCard(id) {
      await call('DELETE', `/api/shared/${encodeURIComponent(id)}`, { ok404: true });
    },

    mailsOwner: deps.mail,
    addressOf: (linkId, key) => `${self.location.origin}/share/${linkId}${key ? `#${key}` : ''}`,
  };
}

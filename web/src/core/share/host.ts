import fs from '../shims/fs';
import { Buffer } from 'buffer';
import type { Store } from 'spine-core/store/types';
import type { ShareHost } from 'spine-core/share-host';
import { carryTranslations } from 'spine-core/translation';
import { sodium } from '../../crypto/sodium';
import { uprightJpeg } from '../native/image-ops';
import { newShareKey, sealPart, wrapShareKey } from './keys';

/**
 * Where a page's image is inside a share's file system: the name is its sealed file's name at the server. A copy made before images had
 * names numbered them, as `<n>.png`; the recipient's core reads both.
 */
export const SHARE_IMAGE = (name: string) => `/share/pages/${name}.jpg`;
/** Page images sent at once. */
const SENDING = 4;
/**
 * A page image in a share is a JPEG, at most this many pixels on its long side: a page read at 200 DPI keeps its size, a photo larger than
 * that is brought down to it. A PNG of a scanned page is several times larger, and every one is sent to the server and to each reader.
 */
const SHARE_IMAGE_SIDE = 2400;

/** Runs `work` on every item, `width` at a time; the first failure stops the rest and is thrown. */
async function eachAtOnce<T>(items: T[], width: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => {
    while (next < items.length) await work(items[next++]);
  }));
}

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
      const s = await sodium();
      const keyBytes = s.from_base64(key, s.base64_variants.URLSAFE_NO_PADDING);
      // A page image is named after the page and what its file is (its size changes when it is turned or read again), keyed with the share's
      // key: a copy made again names an unchanged image the same, so it is not sent again, and the name says nothing to the server.
      const names = new Map<string, string>();
      const nameOf = (pageId: string, from: string) =>
        s.to_base64(s.crypto_generichash(16, new TextEncoder().encode(`jpeg-${SHARE_IMAGE_SIDE}:${pageId}:${fs.statSync(from).size}`), keyBytes), s.base64_variants.URLSAFE_NO_PADDING);
      // The copy is built by the store, in a store of its own, and leaves it as changes: the form in which records travel, not a database file.
      const result = await store.slice({
        userId, documentIds, includeText: link.allow_chat, includeScans: link.include_scans,
        link: { id: link.id, label: link.label, createdAt: link.created_at, expiresAt: link.expires_at, language: link.language, allowChat: link.allow_chat },
        imagePathOf: (pageId, from) => { const name = nameOf(pageId, from); names.set(pageId, name); return SHARE_IMAGE(name); },
        // What the owner already had translated goes with it, so a reader in that language is not kept waiting for the model again.
        finish: copy => carryTranslations(userId, documentIds, copy),
      });
      const changes = result.changes;
      // A keyed hash of what the copy holds (without the clocks, which differ every time it is made), so that a copy that would be the
      // same is not sent again. The key makes it useless to anyone who sees it beside the sealed copy.
      const canonical = changes.map(c => JSON.stringify([c.t, c.k, c.r])).sort().join('\n') + '\n' + result.images.map(i => `${i.pageId}:${fs.statSync(i.from).size}`).sort().join(',') + `\n${link.label}|${link.expires_at}|${link.language}|${link.allow_chat}|${link.include_scans}`;
      digest = s.to_base64(s.crypto_generichash(24, new TextEncoder().encode(canonical), keyBytes), s.base64_variants.URLSAFE_NO_PADDING);
      if (unlessUnchanged && !newKey && have && (await store.shareLinks.copyDigest(userId, link.id)) === digest) return { key, published: false, digest };

      const at = `/api/shared/${encodeURIComponent(link.id)}`;
      const sealed = await sealPart(key, link.id, 'records', new TextEncoder().encode(JSON.stringify({ v: 1, owner: userId, changes })));
      const sendRecords = () => call('PUT', at, {
        headers: { 'content-type': 'application/octet-stream', 'x-spine-expires': new Date(link.expires_at).toISOString(), 'x-spine-approval': link.require_approval ? '1' : '0', 'x-spine-keep-images': '1' },
        body: sealed as BodyInit,
      });
      // The images the server holds already (none for a new link): only the others are sent.
      const held = await call('GET', `${at}/blobs`, { ok404: true });
      const known = held.status === 404 ? null : new Set(((await held.json()) as { names: string[] }).names);
      const wanted = [...new Map(result.images.map(i => [names.get(i.pageId)!, i.from])).entries()];
      const sendImages = () => eachAtOnce(wanted.filter(([name]) => !known?.has(name)), SENDING, async ([name, from]) => {
        const { jpeg } = await uprightJpeg(from, { maxSide: SHARE_IMAGE_SIDE, maxPixels: 100_000_000 });
        await call('PUT', `${at}/blob/${name}`, { headers: { 'content-type': 'application/octet-stream' }, body: (await sealPart(key, link.id, `blob-${name}`, new Uint8Array(jpeg))) as BodyInit });
      });
      if (known) {
        // A link that is open somewhere: the new images first, then the records that name them, then the images nothing names any more, so a
        // reader never has a copy that names an image the server does not have.
        await sendImages();
        await sendRecords();
        await call('POST', `${at}/blobs/keep`, { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ names: wanted.map(([name]) => name) }) });
      } else {
        // A new link has no address yet: the server takes images only for a copy it holds.
        await sendRecords();
        await sendImages();
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

    async takeCard(id) {
      await call('POST', `/api/shared/${encodeURIComponent(id)}/take`, { ok404: true });
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

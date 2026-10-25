import { useCallback, useEffect, useRef, useState } from 'react';
import { reader, readingShare } from '../client';
import { newVisitorKeys, unwrapShareKey } from './keys';

/** Where the recipient's page stands with a link: found out from the server, then, with the key, opened in the page's own core. */
export type ShareAccess = 'checking' | 'gone' | 'needed' | 'pending' | 'denied' | 'open' | 'broken';

/** The fixed name the recipient's core answers to (core/src/store/sqlite/slice.ts: the copy has one link, under this token). */
export const LOCAL_SHARE_TOKEN = 'local';

const keyName = (id: string) => `spine-share-key:${id}`;
const requestName = (id: string) => `spine-share-request:${id}`;

/** What is kept for this tab only, so a reload does not ask the owner again. */
const remember = (name: string, value: string | null) => {
  try { if (value === null) sessionStorage.removeItem(name); else sessionStorage.setItem(name, value); } catch { /* a private window: the page asks again after a reload */ }
};
const recall = (name: string): string | null => {
  try { return sessionStorage.getItem(name); } catch { return null; }
};

/** The key in the address after the `#`: read once and taken out of the address bar, so it is not copied along with the page. */
function takeKeyFromAddress(): string | null {
  const hash = window.location.hash.replace(/^#/, '');
  if (!hash) return null;
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
  return /^[A-Za-z0-9_-]{43}$/.test(hash) ? hash : null;
}

export function useShareAccess(shareId: string | undefined): { state: ShareAccess; ask: (note: string) => Promise<void>; error: string } {
  const [state, setState] = useState<ShareAccess>('checking');
  const [error, setError] = useState('');
  const live = useRef(true);

  const open = useCallback(async (id: string, key: string) => {
    try {
      await reader.openShare(id, key);
      readingShare(id);
      remember(keyName(id), key);
      if (live.current) setState('open');
    } catch (err) {
      remember(keyName(id), null);
      const status = (err as { status?: number }).status;
      if (live.current) setState(status === 410 || status === 404 ? 'gone' : 'broken');
    }
  }, []);

  /** Asks the server what became of this browser's request; an approval carries the key sealed to it. */
  const poll = useCallback(async (id: string) => {
    const stored = recall(requestName(id));
    if (!stored) return;
    const request = JSON.parse(stored) as { rid: string; publicKey: string; privateKey: string };
    for (;;) {
      if (!live.current) return;
      const res = await fetch(`/api/shared/${encodeURIComponent(id)}/access-request/${encodeURIComponent(request.rid)}`);
      if (res.status === 410 || res.status === 404) { setState('gone'); return; }
      if (res.ok) {
        const answer = (await res.json()) as { status: 'pending' | 'approved' | 'denied'; wrapped_key: string | null };
        if (answer.status === 'denied') { setState('denied'); return; }
        if (answer.status === 'approved' && answer.wrapped_key) {
          const key = await unwrapShareKey(answer.wrapped_key, request);
          if (!key) { setState('broken'); return; }
          remember(requestName(id), null);
          await open(id, key);
          return;
        }
      }
      await new Promise(r => setTimeout(r, 3000));
    }
  }, [open]);

  useEffect(() => {
    live.current = true;
    if (!shareId) return;
    const id = shareId;
    void (async () => {
      const meta = await fetch(`/api/shared/${encodeURIComponent(id)}/meta`).catch(() => null);
      if (!live.current) return;
      if (!meta || meta.status === 404 || meta.status === 410) { setState('gone'); return; }
      if (!meta.ok) { setState('broken'); return; }
      const needsApproval = ((await meta.json()) as { approval: boolean }).approval;
      const key = takeKeyFromAddress() ?? recall(keyName(id));
      if (key) { await open(id, key); return; }
      if (!needsApproval) { setState('broken'); return; }
      if (recall(requestName(id))) { setState('pending'); await poll(id); return; }
      setState('needed');
    })();
    return () => { live.current = false; };
  }, [shareId, open, poll]);

  const ask = useCallback(async (note: string) => {
    if (!shareId) return;
    setError('');
    const keys = await newVisitorKeys();
    const res = await fetch(`/api/shared/${encodeURIComponent(shareId)}/access-request`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: keys.publicKey, note }) });
    if (res.status === 410) { setState('gone'); return; }
    const body = (await res.json().catch(() => ({}))) as { request_id?: string; error?: string };
    if (!res.ok || !body.request_id) { setError(body.error ?? 'Could not send the request'); return; }
    remember(requestName(shareId), JSON.stringify({ rid: body.request_id, ...keys }));
    setState('pending');
    void poll(shareId);
  }, [shareId, poll]);

  return { state, ask, error };
}

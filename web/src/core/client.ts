import type { FromWorker, Part, ToWorker } from './protocol';

/**
 * The page's side of the core: starts the worker, and answers `fetch`-shaped calls from it. `deviceFetch` is what the app's requests
 * for records go through; the ones for the account (sign-in, the vault's objects) still go to the server.
 */
class CoreWorker {
  private worker: Worker | null = null;
  /** Resolves when the worker has started listening; a message sent before would be lost. */
  private loaded: Promise<void> = Promise.resolve();
  private onLoaded: () => void = () => {};
  private next = 1;
  /** The streamed replies being read, by request. */
  private streams = new Map<number, ReadableStreamDefaultController<Uint8Array>>();
  private waiting = new Map<number, { resolve: (m: Extract<FromWorker, { ok: true }>) => void; reject: (e: Error) => void }>();
  private ready = false;

  private ensure(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('./core.worker.ts', import.meta.url), { type: 'module' });
    this.worker = worker;
    this.loaded = new Promise(resolve => { this.onLoaded = resolve; });
    worker.onmessage = (event: MessageEvent<FromWorker>) => {
      const m = event.data;
      // SQLite's own worker support announces itself on the same channel; it is not for us.
      if (typeof m?.id !== 'number') return;
      if ('changed' in m) { window.dispatchEvent(new Event(RECORDS_CHANGED)); return; }
      if ('trace' in m) { if (m.trace === 'loaded') this.onLoaded(); else console.debug('[core]', m.trace); return; }
      if ('chunk' in m) { this.streams.get(m.id)?.enqueue(new Uint8Array(m.chunk)); return; }
      if ('end' in m) { try { this.streams.get(m.id)?.close(); } catch { /* the reader already left */ } this.streams.delete(m.id); return; }
      const w = this.waiting.get(m.id);
      if (!w) return;
      this.waiting.delete(m.id);
      if (m.ok) w.resolve(m);
      else w.reject(Object.assign(new Error(m.error.message), m.error));
    };
    // A worker that cannot start (or dies) must not leave every request waiting for an answer that will never come.
    worker.onerror = event => {
      const error = Object.assign(new Error(event.message || 'the core could not start'), { name: 'CoreError' });
      console.error('the core failed', event.message, event.filename, event.lineno);
      for (const w of this.waiting.values()) w.reject(error);
      this.waiting.clear();
    };
    return worker;
  }

  send(message: WithoutId<ToWorker>, transfer: Transferable[] = []) {
    const id = this.next++;
    const w = this.ensure();
    return new Promise<Extract<FromWorker, { ok: true }>>((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      void this.loaded.then(() => w.postMessage({ ...message, id }, transfer));
    });
  }

  /** Opens the vault with this master key and loads the records. The key is handed over, not copied: this page no longer has it. */
  async unlock(masterKey: Uint8Array): Promise<void> {
    await this.send({ type: 'start', masterKey }, [masterKey.buffer]);
    this.ready = true;
  }

  /** The same with a passkey's PRF output: the worker opens the account key with it. Handed over, not copied. */
  async unlockWithPasskey(passkey: { prf: Uint8Array; credentialId: string; wrapped: string }): Promise<void> {
    await this.send({ type: 'startWithPasskey', passkey }, [passkey.prf.buffer]);
    this.ready = true;
  }

  /** Reads a share: fetches the sealed copy, opens it with the key from the link, and answers from it. */
  async openShare(shareId: string, key: string): Promise<void> {
    await this.send({ type: 'startShare', shareId, key });
    this.ready = true;
  }

  /** Saves what changed, lets go of everything, and stops the worker. */
  async lock(): Promise<void> {
    if (this.worker) await this.send({ type: 'lock' }).catch(() => undefined);
    this.worker?.terminate();
    this.worker = null;
    this.ready = false;
  }

  isOpen = () => this.ready;

  /** `fetch`, answered by the core. A form's files are read here and handed over as parts. */
  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => { headers[k] = v; });
    let body: string | undefined;
    let parts: Part[] | undefined;
    const transfer: Transferable[] = [];
    if (init.body instanceof FormData) {
      parts = [];
      for (const [fieldname, value] of init.body.entries()) {
        if (typeof value === 'string') parts.push({ fieldname, value });
        else { const data = await value.arrayBuffer(); transfer.push(data); parts.push({ fieldname, filename: value.name, mimetype: value.type, data }); }
      }
    } else if (typeof init.body === 'string') body = init.body;

    try {
      const m = await this.send({ type: 'request', method: init.method ?? 'GET', url, headers, body, parts }, transfer);
      if (m.stream) {
        const id = m.id;
        const stop = () => { this.streams.delete(id); void this.send({ type: 'abort', target: id }).catch(() => undefined); };
        const body = new ReadableStream<Uint8Array>({
          start: controller => {
            this.streams.set(id, controller);
            init.signal?.addEventListener('abort', () => { try { controller.error(new DOMException('aborted', 'AbortError')); } catch { /* done already */ } stop(); }, { once: true });
          },
          cancel: stop,
        });
        return new Response(body, { status: m.status, headers: m.headers });
      }
      return new Response(m.status === 204 || m.status === 304 ? null : m.body, { status: m.status, headers: m.headers });
    } catch (err) {
      const e = err as { status?: number; code?: string; message: string };
      if (e.status === 423) return new Response(JSON.stringify({ error: e.message, code: e.code }), { status: 423, headers: { 'content-type': 'application/json' } });
      throw err;
    }
  }
}

type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;

/** Said on the window when another device saved first and this one can no longer save. */
export const RECORDS_CHANGED = 'spine:records-changed';

/** The owner's core: their vault, opened with the master key. */
export const device = new CoreWorker();
/** A recipient's core: one share, opened with the key from its link. A separate worker, so an owner can open their own link in the same browser. */
export const reader = new CoreWorker();
export const deviceFetch = (url: string, init?: RequestInit) => device.fetch(url, init);

/**
 * Requests the server answers: the account, the vault's objects, and a share's sealed copy and handshake (`/api/shared/`, which is
 * ciphertext and metadata). What a recipient reads of a share (`/api/share/<token>/...`) is answered by the reader's core; every other
 * `/api` call is the owner's core.
 */
const SERVER_SIDE = /^\/(api\/(auth|account|legal|vault|shared)\/|share\/)/;
const READER = /^\/api\/share\//;

/** The share the reader's core has open, so that what the recipient opens can be noted at the server. */
let reading: string | null = null;
export const readingShare = (id: string | null) => { reading = id; };

/** What the app calls instead of `fetch`: the cores for records, the network for the rest. */
export async function appFetch(url: string, init?: RequestInit): Promise<Response> {
  if (READER.test(url)) {
    const res = await reader.fetch(url, init);
    // The recipient's browser says that a document was opened: only the time, the country and the id inside the sealed copy are kept.
    if (res.ok && reading && (init?.method ?? 'GET') === 'GET') {
      const doc = /^\/api\/share\/[^/]+\/documents\/([^/?]+)$/.exec(url)?.[1];
      if (doc || /^\/api\/share\/[^/]+\/documents(\?|$)/.test(url)) {
        void fetch(`/api/shared/${encodeURIComponent(reading)}/opened`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(doc ? { document_id: doc } : {}) }).catch(() => undefined);
      }
    }
    return res;
  }
  return SERVER_SIDE.test(url) || !url.startsWith('/api/') ? fetch(url, init) : deviceFetch(url, init);
}

/** A picture the core holds, as an address the page can show; the same address is reused, and the oldest are let go. */
const shown = new Map<string, Promise<string>>();
const KEEP = 80;
export function deviceObjectUrl(url: string): Promise<string> {
  let found = shown.get(url);
  if (found) { shown.delete(url); shown.set(url, found); return found; }
  found = appFetch(url).then(async res => {
    if (!res.ok) throw new Error(`could not load ${url}`);
    return URL.createObjectURL(await res.blob());
  });
  shown.set(url, found);
  for (const [key, value] of shown) {
    if (shown.size <= KEEP) break;
    shown.delete(key);
    void value.then(u => URL.revokeObjectURL(u));
  }
  return found;
}
export function forgetDeviceObjectUrls(): void {
  for (const value of shown.values()) void value.then(u => URL.revokeObjectURL(u));
  shown.clear();
}

/** Saves what the core returns for this address as a file, the way a link with `download` would. */
export async function downloadFromDevice(url: string, filename: string): Promise<void> {
  const res = await deviceFetch(url);
  if (!res.ok) {
    // Said in the console for whoever is finding out why: the status and the core's own words, never the records.
    const why = await res.json().then((b: { error?: string; message?: string }) => b.error ?? b.message ?? '', () => '');
    throw new Error(`could not make the file (${res.status}${why ? `: ${why}` : ''})`);
  }
  const disposition = res.headers.get('content-disposition')?.match(/filename="?([^";]+)"?/)?.[1];
  const link = document.createElement('a');
  link.href = URL.createObjectURL(await res.blob());
  link.download = disposition ?? filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
}
